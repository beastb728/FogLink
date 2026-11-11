# FogLink

Phones already in cars, turned into a fog-time collision warning network. When a
vehicle brakes hard or stops on a foggy expressway, every phone behind it on the
same carriageway, up to 2 km back, hears a voice alert.

FogLink is an assistive warning. It cannot see every hazard and it does not
prevent crashes; nothing here should be presented as doing so.

## What works today

| Part | State |
|---|---|
| Relay (`server/`, Go + WebSockets, Redis or in-memory lookups) | Built, tested, packaged as a 21 MB Docker image |
| Simulator and live map dashboard (`sim/`) | Built and tested: up to 2,000 virtual vehicles on the real NH-48 and Yamuna Expressway lines, crash injection, with-vs-without A/B |
| Phone client (`sim/phone.html`, web) | Built: Fog mode, map matching, braking detection, Hindi/English voice alerts at three levels, drive logger. Tested in demo mode in a desktop browser and on one phone (OnePlus 11R, Chrome, relay over Wi-Fi): spoken alerts work. Not yet tested in a car |
| ML pipeline (`ml/`) | Built: orientation alignment, GPS auto-labels, threshold baseline, 1D-CNN. Trained and scored on synthetic drives only |
| Road data (`data/`) | Both corridors, both carriageways, from OpenStreetMap |
| Android app (`android/`, Kotlin) | Built: foreground service, sensors + GPS, threshold braking detector, relay link, Hindi/English voice alerts, drive logger. Logic verified against the JavaScript reference by unit tests. Smoke-tested in an emulator (launch, Fog mode, map matching, Warning and BRAKE alerts from relay events). On one real phone (OnePlus 11R, relay over Wi-Fi): install, foreground service, GPS, relay link and spoken alerts work, the alerts using the app's demo position. Braking detection from the motion sensors has not been tried in a moving car |
| TFLite export | **Not run** (needs `ai-edge-torch`); TorchScript is exported, and the Android app uses the threshold detector |
| Direct phone-to-phone radio | Not started (v2) |

## Run it

Needs Docker, Node 22 and Python 3.10+. Go runs inside Docker.

```bash
make up
```

Then open http://localhost:8080 for the dashboard. For development with live reload:

```bash
make dev
```

(dashboard on http://localhost:5173, relay on :8080).

### The 60-second demo

1. Open the dashboard. Pick a fog level, press **Start**, then **Stop a vehicle** (or click anywhere on either traffic strip).
2. The top strip is the same traffic without FogLink; the bottom strip has it. Yellow sweeping backward is a stop event reaching the vehicles behind.
3. Press **Open a phone 800 m back**. On that page tap **Fog mode**. It is now a real client of the real relay, placed behind the incident with a pretend position, and it speaks when the virtual cars ahead of it brake. Its **Pretend I just braked hard** button sends a real stop event that virtual cars react to.
4. **Run 10 seeds × 3 fog levels** repeats the scenario and tabulates the result with its assumptions.

### A phone in a real car

Browsers only give GPS and motion sensors to pages served over HTTPS. Put the
relay behind a TLS proxy or tunnel, or give it a certificate directly:

```bash
./server/foglink-relay -static sim/dist -cert cert.pem -key key.pem
```

Open `https://<host>:8080/phone.html`, choose **Phone GPS**, tap **Fog mode**.
The page must stay open with the screen on. The Android app (`android/README.md`)
has no such limit: it runs as a foreground service. Testing rules from the project overview apply: hard-braking
tests only in empty lots at low speed, and on real roads the tester is a
passenger.

### A public relay (Fly.io)

`fly.toml` runs the same Docker image in Mumbai behind Fly's HTTPS, as a single
machine (the relay holds positions in memory, so it must not be scaled out).
Needs the `fly` command and a Fly.io account.

```bash
fly launch --copy-config --no-deploy
```

```bash
fly deploy --ha=false
```

Phones then use `wss://<app>.fly.dev/ws` (Android app) or
`https://<app>.fly.dev/phone.html` (browser). The dashboard always shows phones
that joined with a demo position. Its view of phones reporting real positions
stays off unless you set a token: `fly secrets set FOGLINK_OBSERVER_TOKEN=<your own>`
and open the dashboard with `?token=<the same>`; that view is read-only.

A deployment is running at https://foglink-relay.fly.dev (Singapore; Mumbai was
not offered). Checked from one home broadband connection in India: 10 of 10 test
events reached a client 600 m behind, none reached the opposite carriageway, and
event-to-alert took 318 to 381 ms (median 323 ms) across both network hops. That
is inside the 500 ms target with little to spare, and mobile data on a highway
will be slower; a relay in India would cut it.

## How it fits together

```
phone that brakes ── stop event ──▶ relay ── alert ──▶ phones up to 2 km behind
 motion + GPS                       carriageway +         stopping-distance check
 map matching                       distance lookup       voice, 3 levels, hi/en
                                        ▲
                                        │ virtual events, real phones
                                   simulator + dashboard
```

- A **carriageway** is one direction of one road, stored as a line that runs the way traffic drives. A position is metres along that line, so "behind" is simply "smaller number, same carriageway". Phones do the map matching; the relay never sees raw GPS.
- The **relay** only routes. It holds one latest position per anonymous ID for 5 seconds, in memory (or Redis with a 5 s expiry), and writes nothing to disk.
- **Phones decide** whether to speak. `sim/src/core/alert.js` is the single alert rule, used unchanged by the phone client and by the simulator's FogLink arm.

Wire format (JSON over one WebSocket at `/ws`):

| Direction | Message |
|---|---|
| phone → relay, every second | `{"t":"pos","id","cw","s","v","ts"}` |
| phone → relay, on an event | `{"t":"stop","id","cw","s","v","dec","kind","ts"}` with kind `brake`, `stopped`, `slow` or `crash` |
| relay → phones behind | `{"t":"alert", …the stop event…, "gap","rts"}` |
| clock sync | `{"t":"ping","ts"}` → `{"t":"pong","ts","rts"}` |
| relay → phone, once on connecting | `{"t":"hello","p","min","world"}` |

**Simulated and real traffic never mix.** A client that connects to `/ws?world=sim`
is in the relay's simulated world: the dashboard's virtual vehicles, and phones
showing a demo position. Everything else is the real world. The relay shares
nothing between the two, so pressing "Stop a vehicle" on a public dashboard can
never make a phone in a real car speak. The web phone client and the Android app
pick the world themselves: demo position → simulated, GPS → real.

**Fake events.** In the real world the relay forwards a stop event only if it fits
what the same connection has been reporting: at least three position reports over
2.5 s that agree with each other (distance covered matches the speed claimed, no
jumps), road speed within the last 90 s, and an event at the place and speed last
reported. Anything else is dropped and counted in `/stats` as `rejected`. There
are also limits of 4 stop events and 5 position reports a second per connection
and 256 connections per address. This stops one-off fake events and ties each
connection to one place on the road. It does not stop someone who fakes a
believable drive first: there are no accounts, so there is nothing to ban.

**Versions.** Clients connect with `?p=1` and the relay says which versions it
accepts in `hello`. Within a version, changes are additive only; both sides ignore
fields and message types they do not know. If a client is older than `min`, the
relay closes it with code 4426 and the app tells the driver, aloud, to update.

### Alert levels

The phone works out the deceleration its driver would need to stop short of the
reported position, after a 1.5 s reaction and a fog margin (10 to 40 m, larger in
thicker fog).

| Level | Needed deceleration | Spoken |
|---|---|---|
| Heads-up | under 1 m/s² | "Slow traffic ahead." / "आगे ट्रैफ़िक धीमा है।" |
| Warning | 1 to 3 m/s² | "Vehicle stopped 300 metres ahead." / "300 मीटर आगे गाड़ी रुकी है।" |
| Critical | over 3 m/s² | "BRAKE" / "ब्रेक!", red full-screen flash, vibration |

Silence must not be mistaken for "all clear", so the phone also says when it
cannot warn and why: no network, no GPS signal, a road FogLink does not cover, or
an app too old for the relay. It speaks once the state has held for 8 seconds,
and says "FogLink active" when warnings are back.

## Metrics against the six targets

None of the targets has been measured on a road yet. This is what has been
measured, and on what.

| Metric | Target | Measured here | On what |
|---|---|---|---|
| Braking detection precision / recall | over 90% / over 95% | CNN 92.8% / 98.7%; threshold baseline 93.8% / 94.7% | Synthetic drives, 15 held out, 75 episodes, GPS-derived labels |
| Earlier than GPS | over 300 ms | CNN 1,640 ms median (1,170 ms at the worst 10%); baseline 1,410 ms | Same synthetic drives. The synthetic GPS lags the vehicle by 0.5 to 1.1 s by construction, so this mostly measures that assumption |
| Event to alert, 95% of alerts | under 500 ms | Relay fan-out to 1,000 phones: p95 14 ms in memory, 32 ms via Redis. Through the public relay in Singapore: median 323 ms, worst 381 ms of 10 | Fan-out: one machine, loopback, excluding the network. Public relay: both hops over one home broadband line in India, 10 events, not mobile data. The phone client shows the true end-to-end delay live once two phones are on the road |
| False alarms per 100 km | under 1 | CNN 6.3, baseline 3.7 | Synthetic drives with speed breakers, potholes, toll stops and phone moves. **Misses the target** |
| Battery drain per hour | under 5% | Not measured | Needs the Android app on real phones |
| Pileup reduction in simulation | report as measured | Table below | Simulator, assumptions stated |

The model is 8,241 parameters (36 KB), well under the 1 MB budget. On synthetic
data it does not clearly beat the threshold rule: it finds more braking events and
fires about 230 ms sooner, but raises more false alarms. Real logged drives are
needed before choosing between them.

## Simulated pileups, with and without FogLink

All lanes blocked 20 s into the run; 1,000 vehicles, 3 lanes, 10 vehicles per km
per lane; mean of 20 random traffic layouts, 240 s each. "Vehicles involved" is
every vehicle that hit or was hit.

| Visibility | Vehicles running FogLink | Vehicles involved, without → with | Fewer | Mean impact speed km/h, without → with |
|---|---|---|---|---|
| 20 m | 10% | 97.8 → 96.8 | 1% | 46 → 46 |
| 20 m | 30% | 97.8 → 84.1 | 14% | 46 → 43 |
| 20 m | 50% | 97.8 → 67.3 | 31% | 46 → 41 |
| 20 m | 100% | 97.8 → 17.4 | 82% | 46 → 24 |
| 50 m | 10% | 121.9 → 114.3 | 6% | 59 → 58 |
| 50 m | 30% | 121.9 → 88.3 | 28% | 59 → 53 |
| 50 m | 50% | 121.9 → 61.5 | 50% | 59 → 48 |
| 50 m | 100% | 121.9 → 11.2 | 91% | 59 → 32 |
| 200 m | any | 0 → 0 | – | – |

FogLink did worse than no FogLink in 0 of the 20 runs in every row. With no
incident there are no collisions in either arm at any fog level.

Reproduce with `make ab`.

**These numbers are a property of the model below, not a forecast.** The benefit
is roughly proportional to how many vehicles run FogLink, and at 10% it is close
to nothing. Change the driver-response assumptions and the result changes.

- **Car-following.** Intelligent Driver Model per lane, no lane changes. A driver knows nothing about the vehicle ahead until it is inside the visibility distance, starts responding one reaction time (mean 1.5 s) after it comes into view, and picks up changes in its speed half a reaction time late. In thick fog drivers close up to keep the tail-lights ahead in view.
- **Speed in fog.** Drivers overdrive their sight distance: each picks a speed whose stopping distance is 2× what they can see, capped at normal cruising speed. Each lane has settled to a common platoon speed, within 3%. At 200 m this cap never bites and nobody crashes, which is why that row is empty.
- **Braking.** Wet-road maximum deceleration: cars 6.5, buses 4.8, trucks 4.2 m/s².
- **Collision.** A vehicle that reaches the one ahead at more than 2 km/h closing speed crashes and stays stopped in lane.
- **Detection.** An equipped phone reports hard braking (over 0.35 g), a crash, or crawling below 30 km/h after 0.2 s, catching 95% of events. False alarms are not simulated.
- **Relay.** Events reach every equipped vehicle up to 2 km behind, in every lane, after 0.3 s. No coverage gaps.
- **Driver response.** 90% of alerted drivers, 1.0 s after the alert, ease down so that by the reported position they are at a speed they can stop from within what they can see.
- **Not modelled.** Lane changes and swerving, secondary impacts, fire, drivers who brake harder than needed on a heads-up, alert fatigue.

## Privacy

- No accounts, names or phone numbers.
- Vehicle IDs are random and replaced every 10 minutes.
- The relay keeps a position for 5 seconds and an event only for as long as it takes to forward it. Nothing is logged or stored.
- Nobody can watch phones that report real positions unless the relay is started with an observer token (`FOGLINK_OBSERVER_TOKEN`) and they know it; that feed is read-only. `make up` and `make dev` set the token to `dev` for local use. Demo positions are not real, and the dashboard shows them without a token.
- Drive recordings stay on the phone until the user saves the file. `data/drives/` is git-ignored.

## Repo layout

```
server/   Go relay: relay.go (routing), store.go / redis_store.go (who is behind whom), tests
sim/      src/core   simulator, alert rule, road geometry, relay link (shared by everything)
          src/dashboard   live map + A/B strips
          src/phone       phone client + threshold braking detector
          cli/ab.mjs      headless A/B batches
ml/       foglink_ml: synth.py (synthetic drives, CSV loader), signal.py (alignment, labels, baseline), train.py
data/     fetch_osm.py, roads/*.json (map data © OpenStreetMap contributors, ODbL)
android/  Kotlin app: core/ (alert rule, map matching, detector, ported from sim/), FogService, MainActivity
```

## Tests

```bash
make test
```

Relay: routing (only vehicles behind, same carriageway, within 2 km), ID
rotation, position expiry, observer token, simulated and real worlds kept apart,
implausible stop events refused, protocol version and connection cap, fan-out latency; run against both
stores when `FOGLINK_TEST_REDIS` is set. Simulator: alert levels and phrases, no
spontaneous collisions, deterministic A/B arms, map matching by heading, the
"cannot warn" announcements, toll zones, the braking detector against a tilted phone, a speed breaker and a phone pick-up.
Android (`cd android && ./gradlew testDebugUnitTest`): the Kotlin port replays
vectors generated from the JavaScript and must match exactly.

## Known gaps

- **Road lines.** The Yamuna Expressway has a 5.6 km stretch near Agra that OpenStreetMap tags under another name; it is bridged with a straight segment, so distances there are slightly short. The Yamuna lines measure 178 km because the tagged road runs past the 165 km expressway proper.
- **Phones.** Tested indoors on one phone with a pretend position only: nothing has been tested in a moving vehicle. Over mobile data the Android app has received and spoken alerts through the public relay, from a demo position, with the phone stationary. Hindi speech depends on the phone having a Hindi voice installed.
- **Toll plazas.** Phones do not report crawling or stopping from 600 m before a toll plaza to 300 m after it (hard braking is still reported), so a queue that reaches further back than that still triggers heads-ups, and a stopped vehicle inside the zone is reported only if someone brakes hard for it. Plaza positions come from OpenStreetMap toll booths within 120 m of the line; a few near the Greater Noida end of the Yamuna Expressway are probably ramp booths, not main-line plazas. Not checked on the road.
- **Fake events** are made harder, not impossible; see "Fake events" above.
- **ML numbers are synthetic.** Train on logged drives with `make ml DRIVES="data/drives/*.csv"`.
- **Relay** is single-instance. Redis shares positions between instances but alerts are only pushed to phones connected to the instance that received the event.
