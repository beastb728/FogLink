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

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", hub.ServeWS)
	mux.HandleFunc("/stats", hub.ServeStats)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	if *static != "" {
		mux.Handle("/", http.FileServer(http.Dir(*static)))
	}
	log.Printf("FogLink relay on %s (observer feed %v)", *addr, map[bool]string{true: "on", false: "off"}[*token != ""])
	if *cert != "" {
		log.Fatal(http.ListenAndServeTLS(*addr, *cert, *key, mux))
	}
	log.Fatal(http.ListenAndServe(*addr, mux))
}
