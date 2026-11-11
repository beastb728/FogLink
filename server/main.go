// FogLink relay: routes stop events to the vehicles behind. That is all it does;
// phones do the sensing and decide for themselves whether to speak.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	redisAddr := flag.String("redis", os.Getenv("FOGLINK_REDIS"), "Redis address for segment lookups (empty = in-memory)")
	static := flag.String("static", os.Getenv("FOGLINK_STATIC"), "directory of the built dashboard + phone client to serve at /")
	token := flag.String("observer-token", os.Getenv("FOGLINK_OBSERVER_TOKEN"), "token that lets the dashboard watch live traffic (empty = feed off)")
	strict := flag.Bool("strict", os.Getenv("FOGLINK_STRICT") != "0", "refuse stop events that do not fit what the sender has been reporting")
	maxPerIP := flag.Int("max-conns-per-ip", 256, "connections allowed from one address (0 = no cap)")
	ipHeader := flag.String("client-ip-header", os.Getenv("FOGLINK_CLIENT_IP_HEADER"), "proxy header carrying the caller's address, e.g. Fly-Client-IP (empty = none)")
	cert := flag.String("cert", "", "TLS certificate (phones need https for GPS and motion sensors)")
	key := flag.String("key", "", "TLS key")
	flag.Parse()

	var store Store = newMemStore()
	if *redisAddr != "" {
		rs, err := newRedisStore(*redisAddr)
		if err != nil {
			log.Fatalf("redis: %v", err)
		}
		store = rs
		log.Printf("segment lookups in Redis at %s", *redisAddr)
	}
	hub := NewHub(store, *token)
	hub.Strict, hub.MaxConnsPerIP, hub.ClientIPHeader = *strict, *maxPerIP, *ipHeader

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", hub.ServeWS)
	mux.HandleFunc("/stats", hub.ServeStats)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	if *static != "" {
		mux.Handle("/", http.FileServer(http.Dir(*static)))
	}
	onOff := map[bool]string{true: "on", false: "off"}
	log.Printf("FogLink relay on %s (protocol %d, real-position observer feed %s, plausibility checks %s)", *addr, ProtocolVersion, onOff[*token != ""], onOff[*strict])
	if *cert != "" {
		log.Fatal(http.ListenAndServeTLS(*addr, *cert, *key, mux))
	}
	log.Fatal(http.ListenAndServe(*addr, mux))
}
