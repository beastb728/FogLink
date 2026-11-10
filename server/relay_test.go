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

func dial(t *testing.T, url string) *phone {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(url, "http")+"/ws", nil)
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

func (p *phone) alert(wait time.Duration) *Msg {
	select {
	case m, ok := <-p.in:
		if ok && m.T == "alert" {
			return &m
		}
		return nil
	case <-time.After(wait):
		return nil
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
