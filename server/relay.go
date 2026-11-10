package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// RangeM is how far back along the carriageway a stop event is pushed.
const RangeM = 2000.0

// Msg is every message on the wire, in either direction.
//
//	phone -> relay   {"t":"pos",  "id","cw","s","v","ts"}                   about once a second
//	phone -> relay   {"t":"stop", "id","cw","s","v","dec","kind","ts"}      braking / stopped / crash
//	phone -> relay   {"t":"ping", "ts"}                                     clock offset + latency probe
//	relay -> phone   {"t":"alert", ...the stop event..., "gap","rts"}       gap = metres ahead of you
//	relay -> phone   {"t":"pong", "ts","rts"}
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
}

type client struct {
	out      chan []byte
	id       string // current anonymous ID, "" until the first pos
	observer bool
	stops    []time.Time // recent stop events, for rate limiting
}

type Hub struct {
	store         Store
	observerToken string // "" disables the live observer feed

	mu        sync.RWMutex
	byID      map[string]*client
	observers map[*client]struct{}

	connected atomic.Int64
	events    atomic.Int64
	pushed    atomic.Int64
	latMu     sync.Mutex
	lat       []float64 // recent relay processing times, ms (ring)
	latN      int
}

func NewHub(store Store, observerToken string) *Hub {
	return &Hub{store: store, observerToken: observerToken, byID: map[string]*client{}, observers: map[*client]struct{}{}, lat: make([]float64, 0, 2048)}
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

func (h *Hub) observe(m *Msg) {
	h.mu.RLock()
	for o := range h.observers {
		h.send(o, m)
	}
	h.mu.RUnlock()
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
		if h.observerToken != "" && m.Token == h.observerToken {
			c.observer = true
			h.mu.Lock()
			h.observers[c] = struct{}{}
			h.mu.Unlock()
		}
	case "pos":
		if !valid(m) {
			return
		}
		if c.id != "" && c.id != m.ID {
			h.store.Remove(ctx, c.id) // ID rotated: drop the old one at once
		}
		h.bind(c, m.ID)
		h.store.Update(ctx, m.ID, m.CW, m.S)
		h.observe(m)
	case "stop":
		if !valid(m) {
			return
		}
		// at most 4 stop events a second from one connection
		keep := c.stops[:0]
		for _, t := range c.stops {
			if now.Sub(t) < time.Second {
				keep = append(keep, t)
			}
		}
		c.stops = keep
		if len(c.stops) >= 4 && !c.observer {
			return
		}
		c.stops = append(c.stops, now)
		targets, err := h.store.Behind(ctx, m.CW, m.S, RangeM)
		if err != nil {
			return
		}
		out := *m
		out.T = "alert"
		out.RTS = now.UnixMilli()
		n := 0
		h.mu.RLock()
		for _, t := range targets {
			if t.ID == m.ID {
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
		h.observe(&ob)
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
	h.mu.Unlock()
	if c.id != "" {
		h.store.Remove(context.Background(), c.id)
	}
}

// ServeWS is the one WebSocket endpoint.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.ServeWS(w, r) }

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &client{out: make(chan []byte, 64)}
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
		"relay_ms_p50": pct(0.5), "relay_ms_p95": pct(0.95),
	})
}
