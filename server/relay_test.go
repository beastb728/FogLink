package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type phone struct {
	t  *testing.T
	ws *websocket.Conn
	in chan Msg
}

func dial(t *testing.T, url string) *phone { return dialQ(t, url, "") }

func dialQ(t *testing.T, url, query string) *phone {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(url, "http")+"/ws"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := &phone{t: t, ws: ws, in: make(chan Msg, 256)}
	go func() {
		for {
			_, b, err := ws.Read(context.Background())
			if err != nil {
				close(p.in)
				return
			}
			var m Msg
			json.Unmarshal(b, &m)
			p.in <- m
		}
	}()
	t.Cleanup(func() { ws.CloseNow() })
	return p
}

func (p *phone) send(m Msg) {
	b, _ := json.Marshal(m)
	if err := p.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		p.t.Fatal(err)
	}
}

// sync waits until the relay has processed everything this phone sent so far.
func (p *phone) sync() {
	p.send(Msg{T: "ping", TS: 1})
	for m := range p.in {
		if m.T == "pong" {
			return
		}
	}
}

func (p *phone) alert(wait time.Duration) *Msg { return p.next("alert", wait) }

// next returns the next message of the given type, skipping the relay's hello.
func (p *phone) next(typ string, wait time.Duration) *Msg {
	deadline := time.After(wait)
	for {
		select {
		case m, ok := <-p.in:
			if ok && m.T == "hello" && typ != "hello" {
				continue
			}
			if ok && m.T == typ {
				return &m
			}
			return nil
		case <-deadline:
			return nil
		}
	}
}

func stores(t *testing.T) map[string]Store {
	s := map[string]Store{"memory": newMemStore()}
	if addr := os.Getenv("FOGLINK_TEST_REDIS"); addr != "" {
		rs, err := newRedisStore(addr)
		if err != nil {
			t.Fatal(err)
		}
		rs.rdb.FlushDB(context.Background())
		s["redis"] = rs
	}
	return s
}

func TestStopEventReachesOnlyVehiclesBehind(t *testing.T) {
	for name, store := range stores(t) {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(NewHub(store, ""))
			defer srv.Close()
			at := func(id, cw string, s float64) *phone {
				p := dial(t, srv.URL)
				p.send(Msg{T: "pos", ID: id, CW: cw, S: s, V: 25})
				p.sync()
				return p
			}
			truck := at("truck-01", "nh48:jaipur", 50000)
			near := at("near-001", "nh48:jaipur", 49700)   // 300 m behind
			far := at("far-0001", "nh48:jaipur", 48100)    // 1.9 km behind
			tooFar := at("toofar-1", "nh48:jaipur", 47900) // 2.1 km behind
			ahead := at("ahead-01", "nh48:jaipur", 50200)
			opposite := at("oppo-001", "nh48:delhi", 49700) // other carriageway

			truck.send(Msg{T: "stop", ID: "truck-01", CW: "nh48:jaipur", S: 50000, V: 3, Dec: 5.2, Kind: "brake", TS: 42})

			if a := near.alert(time.Second); a == nil || a.Gap != 300 || a.Dec != 5.2 || a.TS != 42 || a.RTS == 0 {
				t.Fatalf("near: got %+v", a)
			}
			if a := far.alert(time.Second); a == nil || a.Gap != 1900 {
				t.Fatalf("far: got %+v", a)
			}
			for who, p := range map[string]*phone{"too far": tooFar, "ahead": ahead, "opposite": opposite, "sender": truck} {
				if a := p.alert(150 * time.Millisecond); a != nil {
					t.Errorf("%s should not be alerted, got %+v", who, a)
				}
			}
		})
	}
}

func TestRotatedIDReplacesOldOne(t *testing.T) {
	for name, store := range stores(t) {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(NewHub(store, ""))
			defer srv.Close()
			car := dial(t, srv.URL)
			car.send(Msg{T: "pos", ID: "old-id-1", CW: "yamuna:agra", S: 1000, V: 20})
			car.send(Msg{T: "pos", ID: "new-id-2", CW: "yamuna:agra", S: 1020, V: 20})
			car.sync()
			front := dial(t, srv.URL)
			front.send(Msg{T: "stop", ID: "front-01", CW: "yamuna:agra", S: 1500, V: 0, Kind: "stopped"})
			if a := car.alert(time.Second); a == nil || a.Gap != 480 {
				t.Fatalf("got %+v", a)
			}
			if a := car.alert(150 * time.Millisecond); a != nil {
				t.Fatalf("alerted twice: the old ID was still live: %+v", a)
			}
		})
	}
}

func TestPositionsExpire(t *testing.T) {
	m := newMemStore()
	now := time.Now()
	m.now = func() time.Time { return now }
	m.Update(context.Background(), "abcd", "cw", 100)
	if got, _ := m.Behind(context.Background(), "cw", 500, RangeM); len(got) != 1 {
		t.Fatalf("want 1, got %v", got)
	}
	now = now.Add(positionTTL + time.Second)
	if got, _ := m.Behind(context.Background(), "cw", 500, RangeM); len(got) != 0 {
		t.Fatalf("position should have expired, got %v", got)
	}
	if len(m.byID) != 0 {
		t.Fatal("expired position still held in memory")
	}
}

func TestObserverNeedsToken(t *testing.T) {
	srv := httptest.NewServer(NewHub(newMemStore(), "secret"))
	defer srv.Close()
	bad, good := dial(t, srv.URL), dial(t, srv.URL)
	bad.send(Msg{T: "observe", Token: "nope"})
	good.send(Msg{T: "observe", Token: "secret"})
	bad.sync()
	good.sync()
	car := dial(t, srv.URL)
	car.send(Msg{T: "pos", ID: "car-0001", CW: "cw", S: 10, V: 5})
	select {
	case m := <-good.in:
		if m.T != "pos" || m.ID != "car-0001" {
			t.Fatalf("got %+v", m)
		}
	case <-time.After(time.Second):
		t.Fatal("observer saw nothing")
	}
	select {
	case m := <-bad.in:
		t.Fatalf("unauthorised observer saw %+v", m)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestRelayLatency measures stop-event-in to alert-out through real WebSockets
// on one machine, with 1,000 phones behind the sender. The 500 ms end-to-end
// target also includes two mobile-network hops, which this cannot measure.
func TestRelayLatency(t *testing.T) {
	for name, store := range stores(t) {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(NewHub(store, ""))
			defer srv.Close()
			const n = 1000
			phones := make([]*phone, n)
			for i := range phones {
				phones[i] = dial(t, srv.URL)
			}
			report := func() { // phones report about once a second; the relay forgets them after 5 s
				for i, p := range phones {
					p.send(Msg{T: "pos", ID: "veh-" + string(rune('a'+i%26)) + string(rune('a'+i/26%26)) + string(rune('a'+i/676)), CW: "cw", S: float64(100 + i*2), V: 20})
				}
				for _, p := range phones {
					p.sync()
				}
			}
			sender := dial(t, srv.URL)
			var lat []float64
			for round := 0; round < 20; round++ {
				if round%5 == 0 {
					report()
				}
				t0 := time.Now()
				sender.send(Msg{T: "stop", ID: "sender-1", CW: "cw", S: 2099, V: 0, Dec: 6, Kind: "brake"})
				for _, p := range phones {
					if a := p.alert(2 * time.Second); a == nil {
						t.Fatal("missing alert")
					}
				}
				lat = append(lat, float64(time.Since(t0).Microseconds())/1000)
				time.Sleep(260 * time.Millisecond) // stay under the per-connection rate limit
			}
			sort.Float64s(lat)
			t.Logf("%s: stop event -> last of %d phones alerted: p50 %.1f ms, p95 %.1f ms, max %.1f ms", name, n, lat[len(lat)/2], lat[len(lat)*95/100], lat[len(lat)-1])
			if lat[len(lat)*95/100] > 250 {
				t.Errorf("p95 relay fan-out %.1f ms leaves too little of the 500 ms budget", lat[len(lat)*95/100])
			}
		})
	}
}

// A simulated event must never reach a phone reporting a real position, and
// the other way round, even on the same carriageway.
func TestSimulatedAndRealWorldsAreSeparate(t *testing.T) {
	for name, store := range stores(t) {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(NewHub(store, "secret"))
			defer srv.Close()
			realCar := dial(t, srv.URL)
			realCar.send(Msg{T: "pos", ID: "real-001", CW: "nh48:jaipur", S: 1000, V: 25})
			realCar.sync()
			demoPhone := dialQ(t, srv.URL, "?world=sim")
			demoPhone.send(Msg{T: "pos", ID: "demo-001", CW: "nh48:jaipur", S: 1000, V: 25})
			demoPhone.sync()

			dashboard := dialQ(t, srv.URL, "?world=sim")
			dashboard.send(Msg{T: "observe"}) // no token needed to watch simulated traffic
			dashboard.sync()
			dashboard.send(Msg{T: "stop", ID: "sim-7", CW: "nh48:jaipur", S: 1500, V: 0, Kind: "crash"})
			if a := demoPhone.alert(time.Second); a == nil || a.Gap != 500 || a.CW != "nh48:jaipur" {
				t.Fatalf("demo phone should hear the simulated crash, got %+v", a)
			}
			if a := realCar.alert(200 * time.Millisecond); a != nil {
				t.Fatalf("a real phone heard a simulated event: %+v", a)
			}

			front := dial(t, srv.URL)
			front.send(Msg{T: "pos", ID: "front-01", CW: "nh48:jaipur", S: 1400, V: 25})
			front.send(Msg{T: "stop", ID: "front-01", CW: "nh48:jaipur", S: 1400, V: 0, Kind: "stopped"})
			if a := realCar.alert(time.Second); a == nil || a.Gap != 400 {
				t.Fatalf("real phone should hear the real event, got %+v", a)
			}
			if a := demoPhone.alert(200 * time.Millisecond); a != nil {
				t.Fatalf("a demo phone heard a real event: %+v", a)
			}
			// the simulated-world observer saw only simulated traffic
			for {
				m := dashboard.next("pos", 100*time.Millisecond)
				if m == nil {
					break
				}
				if m.ID == "real-001" || m.ID == "front-01" {
					t.Fatalf("simulated-world observer saw a real phone: %+v", m)
				}
			}
		})
	}
}

// An observer of real traffic can watch but cannot inject events.
func TestRealWorldObserverIsReadOnly(t *testing.T) {
	srv := httptest.NewServer(NewHub(newMemStore(), "secret"))
	defer srv.Close()
	car := dial(t, srv.URL)
	car.send(Msg{T: "pos", ID: "car-0001", CW: "cw", S: 100, V: 20})
	car.sync()
	obs := dial(t, srv.URL)
	obs.send(Msg{T: "observe", Token: "secret"})
	obs.send(Msg{T: "stop", ID: "fake-001", CW: "cw", S: 500, V: 0, Kind: "crash"})
	obs.sync()
	if a := car.alert(200 * time.Millisecond); a != nil {
		t.Fatalf("observer injected an event: %+v", a)
	}
}

// With plausibility checks on, a stop event is only forwarded when it fits
// what its sender has been reporting.
func TestImplausibleStopEventsAreRefused(t *testing.T) {
	hub := NewHub(newMemStore(), "")
	hub.Strict = true
	srv := httptest.NewServer(hub)
	defer srv.Close()
	behind := dial(t, srv.URL)
	keep := func() { // the listener keeps reporting, as a phone does
		behind.send(Msg{T: "pos", ID: "behind-1", CW: "cw", S: 9000, V: 0})
		behind.sync()
	}
	keep()
	stop := func(p *phone, id string, s, v float64) {
		p.send(Msg{T: "stop", ID: id, CW: "cw", S: s, V: v, Dec: 5, Kind: "brake"})
		p.sync()
	}

	// 1. no position history at all
	prank := dial(t, srv.URL)
	stop(prank, "prank-01", 10000, 0)
	// 2. one position report, then an event straight away
	prank.send(Msg{T: "pos", ID: "prank-01", CW: "cw", S: 10000, V: 25})
	stop(prank, "prank-01", 10000, 0)
	if a := behind.alert(200 * time.Millisecond); a != nil {
		t.Fatalf("event with no history was forwarded: %+v", a)
	}

	// a believable drive: four reports over three seconds at 20 m/s
	car := dial(t, srv.URL)
	s := 10000.0
	for i := 0; i < 4; i++ {
		car.send(Msg{T: "pos", ID: "car-0001", CW: "cw", S: s, V: 20})
		car.sync()
		keep()
		if i < 3 {
			time.Sleep(time.Second)
			s += 20
		}
	}
	// 3. an event somewhere it has not been
	stop(car, "car-0001", s+800, 0)
	// 4. an event under an ID it has not been using
	stop(car, "other-id", s, 0)
	// 5. an event far faster than it was travelling
	stop(car, "car-0001", s, 60)
	if a := behind.alert(200 * time.Millisecond); a != nil {
		t.Fatalf("implausible event was forwarded: %+v", a)
	}
	if got := hub.rejected.Load(); got != 5 {
		t.Fatalf("rejected = %d, want 5", got)
	}
	// and the honest one goes through
	stop(car, "car-0001", s+5, 8)
	if a := behind.alert(time.Second); a == nil || a.Gap != s+5-9000 {
		t.Fatalf("plausible event was not forwarded: %+v", a)
	}

	// a jump down the road resets the history
	car.send(Msg{T: "pos", ID: "car-0001", CW: "cw", S: s + 1500, V: 20})
	stop(car, "car-0001", s+1500, 0)
	if a := behind.alert(200 * time.Millisecond); a != nil {
		t.Fatalf("event after a position jump was forwarded: %+v", a)
	}
}

func TestProtocolVersionAndConnectionCap(t *testing.T) {
	hub := NewHub(newMemStore(), "")
	hub.MaxConnsPerIP = 2
	srv := httptest.NewServer(hub)
	defer srv.Close()
	a := dialQ(t, srv.URL, "?p=1")
	if m := a.next("hello", time.Second); m == nil || m.P != ProtocolVersion || m.Min != MinClientVersion || m.World != "real" {
		t.Fatalf("hello: %+v", m)
	}
	b := dialQ(t, srv.URL, "?world=sim")
	if m := b.next("hello", time.Second); m == nil || m.World != "sim" {
		t.Fatalf("hello: %+v", m)
	}
	// a third connection from the same address is refused
	if ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil); err == nil {
		ws.CloseNow()
		t.Fatal("connection over the per-address cap was accepted")
	}
	a.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)
	// a client older than the relay accepts is told to update
	old := dialQ(t, srv.URL, "?p=0")
	if _, ok := <-old.in; ok {
		t.Fatal("outdated client was not closed")
	}
}

// On shutdown every phone is told to reconnect, with the "service restart" close code.
func TestShutdownTellsPhonesToReconnect(t *testing.T) {
	hub := NewHub(newMemStore(), "")
	srv := httptest.NewServer(hub)
	defer srv.Close()
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if _, _, err := ws.Read(context.Background()); err != nil { // hello
		t.Fatal(err)
	}
	go hub.Shutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err = ws.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusServiceRestart {
		t.Fatalf("close status = %v (%v), want service restart", websocket.CloseStatus(err), err)
	}
}
