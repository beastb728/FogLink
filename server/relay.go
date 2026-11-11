package main

import (
	"context"
	"encoding/json"
	"math"
	"net"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// RangeM is how far back along the carriageway a stop event is pushed.
const RangeM = 2000.0

// Protocol version, sent by clients as /ws?p=N (absent = 1) and by the relay in
// its first message, {"t":"hello","p","min"}. Within a version, changes are
// additive only: both sides ignore fields and message types they do not know.
// Raise MinClientVersion only when old clients would be unsafe; they are then
// refused with close code 4426 and tell their driver to update.
const (
	ProtocolVersion  = 1
	MinClientVersion = 1
	closeUpgrade     = 4426
)

// simWorld marks a connection made with /ws?world=sim: the simulator, and phones
// showing a pretend position. The two worlds share nothing. A simulated event
// can never reach a phone that is reporting its real position, and the
// simulated world can be watched without a token because nothing in it is real.
const simWorld = "sim|"

// Msg is every message on the wire, in either direction.
//
//	phone -> relay   {"t":"pos",  "id","cw","s","v","ts"}                   about once a second
//	phone -> relay   {"t":"stop", "id","cw","s","v","dec","kind","ts"}      braking / stopped / crash
//	phone -> relay   {"t":"ping", "ts"}                                     clock offset + latency probe
//	relay -> phone   {"t":"alert", ...the stop event..., "gap","rts"}       gap = metres ahead of you
//	relay -> phone   {"t":"pong", "ts","rts"}
//	relay -> phone   {"t":"hello", "p","min","world"}                       once, on connecting
//
// id is random and rotated by the phone every 10 minutes. The relay never sees
// a name, phone number, account or raw GPS: only a carriageway and a distance
// along it.
type Msg struct {
	T     string  `json:"t"`
	ID    string  `json:"id,omitempty"`
	CW    string  `json:"cw,omitempty"`
	S     float64 `json:"s"`
	V     float64 `json:"v"`
	Dec   float64 `json:"dec,omitempty"`
	Kind  string  `json:"kind,omitempty"`
	TS    int64   `json:"ts,omitempty"`  // sender clock, ms
	RTS   int64   `json:"rts,omitempty"` // relay clock when the event arrived, ms
	Gap   float64 `json:"gap,omitempty"`
	N     int     `json:"n,omitempty"` // observers only: how many phones the event was pushed to
	Token string  `json:"token,omitempty"`
	P     int     `json:"p,omitempty"`     // hello: the relay's protocol version
	Min   int     `json:"min,omitempty"`   // hello: the oldest client version it accepts
	World string  `json:"world,omitempty"` // hello: "real" or "sim"
}

type client struct {
	out      chan []byte
	world    string // "" for real positions, simWorld for simulated ones
	id       string // current anonymous ID with the world in front, "" until the first pos
	observer bool
	stops    []time.Time // recent stop events, for rate limiting
	posWin   time.Time   // pos rate limiting: start of the current second
	posN     int

	// What this connection has reported lately, to judge whether a stop event
	// from it is believable. Kept per connection, so it survives ID rotation.
	lastCW   string
	lastS    float64
	lastV    float64
	lastAt   time.Time
	run      int       // consecutive position reports that agree with each other
	runStart time.Time // when that run began
	fastAt   time.Time // last time it reported road speed on this carriageway
}

// track updates the believability record with a new position report.
func (c *client) track(m *Msg, now time.Time) {
	dt := now.Sub(c.lastAt).Seconds()
	ok := c.run > 0 && c.lastCW == m.CW && dt <= positionTTL.Seconds()
	if ok {
		// distance covered must roughly match the speed claimed, and never go backwards
		ds := m.S - c.lastS
		expect := (m.V + c.lastV) / 2 * dt
		ok = ds > -30 && math.Abs(ds-expect) <= 60+0.5*expect
	}
	if ok {
		c.run++
	} else {
		c.run, c.runStart = 1, now
		if c.lastCW != m.CW {
			c.fastAt = time.Time{}
		}
	}
	if m.V >= 10 {
		c.fastAt = now
	}
	c.lastCW, c.lastS, c.lastV, c.lastAt = m.CW, m.S, m.V, now
}

// plausible says whether a stop event fits what its sender has been reporting:
// a few seconds of consistent travel on that carriageway, at road speed within
// the last 90 s, and an event at the place and speed it last reported. This does
// not stop a determined liar, who can first fake a believable drive; it stops
// one-shot fake events and ties each connection to a single place on the road.
func (c *client) plausible(m *Msg, now time.Time) bool {
	return c.run >= 3 && now.Sub(c.runStart) >= 2500*time.Millisecond &&
		now.Sub(c.lastAt) <= 3*time.Second &&
		c.world+m.ID == c.id && m.CW == c.lastCW &&
		math.Abs(m.S-c.lastS) <= 150 && m.V <= c.lastV+5 &&
		now.Sub(c.fastAt) <= 90*time.Second
}

type Hub struct {
	store         Store
	observerToken string // "" disables the live observer feed for real positions

	// Strict turns on the plausibility checks for stop events from real phones.
	Strict bool
	// MaxConnsPerIP caps connections from one address (0 = no cap). Mobile
	// networks put many phones behind one address, so keep it generous.
	MaxConnsPerIP int
	// ClientIPHeader names the proxy header carrying the caller's address
	// (for example Fly-Client-IP). Empty: use the connection's own address.
	ClientIPHeader string
	ipMu           sync.Mutex
	perIP          map[string]int
	rejected       atomic.Int64 // stop events refused as implausible

	mu        sync.RWMutex
	byID      map[string]*client
	observers map[*client]struct{}
	conns     map[*client]*websocket.Conn

	connected atomic.Int64
	events    atomic.Int64
	pushed    atomic.Int64
	latMu     sync.Mutex
	lat       []float64 // recent relay processing times, ms (ring)
	latN      int
}

func NewHub(store Store, observerToken string) *Hub {
	return &Hub{store: store, observerToken: observerToken, byID: map[string]*client{}, observers: map[*client]struct{}{}, conns: map[*client]*websocket.Conn{}, perIP: map[string]int{}, lat: make([]float64, 0, 2048)}
}

func valid(m *Msg) bool {
	ok := func(x, lo, hi float64) bool { return !math.IsNaN(x) && x >= lo && x <= hi }
	return len(m.ID) >= 4 && len(m.ID) <= 40 && len(m.CW) >= 1 && len(m.CW) <= 64 &&
		ok(m.S, 0, 5e6) && ok(m.V, 0, 80) && ok(m.Dec, 0, 60)
}

func (h *Hub) send(c *client, m *Msg) bool {
	b, _ := json.Marshal(m)
	select {
	case c.out <- b:
		return true
	default: // a slow phone never holds up the others
		return false
	}
}

var kinds = map[string]bool{"brake": true, "stopped": true, "slow": true, "crash": true}

// observe copies a message to the observers of the world it happened in.
func (h *Hub) observe(world string, m *Msg) {
	h.mu.RLock()
	for o := range h.observers {
		if o.world == world {
			h.send(o, m)
		}
	}
	h.mu.RUnlock()
}

func (h *Hub) clientIP(r *http.Request) string {
	if h.ClientIPHeader != "" {
		if ip := r.Header.Get(h.ClientIPHeader); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (h *Hub) acquire(ip string) bool {
	h.ipMu.Lock()
	defer h.ipMu.Unlock()
	if h.MaxConnsPerIP > 0 && h.perIP[ip] >= h.MaxConnsPerIP {
		return false
	}
	h.perIP[ip]++
	return true
}

func (h *Hub) release(ip string) {
	h.ipMu.Lock()
	if h.perIP[ip]--; h.perIP[ip] <= 0 {
		delete(h.perIP, ip)
	}
	h.ipMu.Unlock()
}

func (h *Hub) bind(c *client, id string) {
	if c.id == id {
		return
	}
	h.mu.Lock()
	if c.id != "" && h.byID[c.id] == c {
		delete(h.byID, c.id)
	}
	c.id = id
	h.byID[id] = c
	h.mu.Unlock()
}

func (h *Hub) handle(ctx context.Context, c *client, m *Msg) {
	now := time.Now()
	switch m.T {
	case "ping":
		h.send(c, &Msg{T: "pong", TS: m.TS, RTS: now.UnixMilli()})
	case "observe":
		// simulated traffic is open to watch; real positions need the token
		if c.world == simWorld || (h.observerToken != "" && m.Token == h.observerToken) {
			c.observer = true
			h.mu.Lock()
			h.observers[c] = struct{}{}
			h.mu.Unlock()
		}
	case "pos":
		if !valid(m) {
			return
		}
		// at most 5 position reports a second from one connection
		if now.Sub(c.posWin) >= time.Second {
			c.posWin, c.posN = now, 0
		}
		if c.posN++; c.posN > 5 {
			return
		}
		key := c.world + m.ID
		if c.id != "" && c.id != key {
			h.store.Remove(ctx, c.id) // ID rotated: drop the old one at once
		}
		h.bind(c, key)
		c.track(m, now)
		h.store.Update(ctx, key, c.world+m.CW, m.S)
		h.observe(c.world, m)
	case "stop":
		if !valid(m) || !kinds[m.Kind] {
			return
		}
		limit := 4 // stop events a second from one connection
		if c.world == simWorld {
			if c.observer {
				limit = 500 // the simulator speaks for hundreds of virtual vehicles
			}
		} else {
			if c.observer {
				return // watching real traffic is read-only
			}
			if h.Strict && !c.plausible(m, now) {
				h.rejected.Add(1)
				return
			}
		}
		keep := c.stops[:0]
		for _, t := range c.stops {
			if now.Sub(t) < time.Second {
				keep = append(keep, t)
			}
		}
		c.stops = keep
		if len(c.stops) >= limit {
			return
		}
		c.stops = append(c.stops, now)
		key := c.world + m.ID
		targets, err := h.store.Behind(ctx, c.world+m.CW, m.S, RangeM)
		if err != nil {
			return
		}
		out := *m
		out.T = "alert"
		out.RTS = now.UnixMilli()
		n := 0
		h.mu.RLock()
		for _, t := range targets {
			if t.ID == key {
				continue
			}
			if tc := h.byID[t.ID]; tc != nil && tc != c {
				out.Gap = math.Round((m.S-t.S)*10) / 10
				if h.send(tc, &out) {
					n++
				}
			}
		}
		h.mu.RUnlock()
		h.events.Add(1)
		h.pushed.Add(int64(n))
		h.recordLatency(float64(time.Since(now).Microseconds()) / 1000)
		ob := *m
		ob.RTS, ob.N = out.RTS, n
		h.observe(c.world, &ob)
	}
}

func (h *Hub) recordLatency(ms float64) {
	h.latMu.Lock()
	if len(h.lat) < cap(h.lat) {
		h.lat = append(h.lat, ms)
	} else {
		h.lat[h.latN%cap(h.lat)] = ms
	}
	h.latN++
	h.latMu.Unlock()
}

func (h *Hub) drop(c *client) {
	h.mu.Lock()
	if c.id != "" && h.byID[c.id] == c {
		delete(h.byID, c.id)
	}
	delete(h.observers, c)
	delete(h.conns, c)
	h.mu.Unlock()
	if c.id != "" {
		h.store.Remove(context.Background(), c.id)
	}
}

// ServeWS is the one WebSocket endpoint.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.ServeWS(w, r) }

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	ip := h.clientIP(r)
	if !h.acquire(ip) {
		http.Error(w, "too many connections from this address", http.StatusTooManyRequests)
		return
	}
	defer h.release(ip)
	q := r.URL.Query()
	version := 1 // clients from before versioning send no p
	if p := q.Get("p"); p != "" {
		version, _ = strconv.Atoi(p)
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	if version < MinClientVersion {
		ws.Close(closeUpgrade, "update required")
		return
	}
	ws.SetReadLimit(1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &client{out: make(chan []byte, 64)}
	hello := &Msg{T: "hello", P: ProtocolVersion, Min: MinClientVersion, World: "real"}
	if q.Get("world") == "sim" {
		c.world, hello.World = simWorld, "sim"
	}
	h.send(c, hello)
	h.mu.Lock()
	h.conns[c] = ws
	h.mu.Unlock()
	h.connected.Add(1)
	defer h.connected.Add(-1)
	defer h.drop(c)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case b := <-c.out:
				wctx, wcancel := context.WithTimeout(ctx, 3*time.Second)
				err := ws.Write(wctx, websocket.MessageText, b)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var m Msg
		if json.Unmarshal(data, &m) == nil {
			h.handle(ctx, c, &m)
		}
	}
}

// Shutdown tells every phone the relay is restarting, so they reconnect at once
// instead of waiting to notice a dead connection. Positions are rebuilt from the
// phones' next reports, a second or so after they are back.
func (h *Hub) Shutdown() {
	h.mu.RLock()
	all := make([]*websocket.Conn, 0, len(h.conns))
	for _, ws := range h.conns {
		all = append(all, ws)
	}
	h.mu.RUnlock()
	var wg sync.WaitGroup
	for _, ws := range all {
		wg.Add(1)
		go func(ws *websocket.Conn) {
			defer wg.Done()
			ws.Close(websocket.StatusServiceRestart, "restarting")
		}(ws)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

// ServeStats reports counters only: no positions, no IDs.
func (h *Hub) ServeStats(w http.ResponseWriter, _ *http.Request) {
	h.latMu.Lock()
	l := append([]float64(nil), h.lat...)
	h.latMu.Unlock()
	sort.Float64s(l)
	pct := func(p float64) float64 {
		if len(l) == 0 {
			return 0
		}
		return l[int(math.Min(float64(len(l)-1), p*float64(len(l))))]
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"connected": h.connected.Load(), "events": h.events.Load(), "pushed": h.pushed.Load(),
		"rejected": h.rejected.Load(), "protocol": ProtocolVersion,
		"relay_ms_p50": pct(0.5), "relay_ms_p95": pct(0.95),
	})
}
