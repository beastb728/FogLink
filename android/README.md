# FogLink Android app

Kotlin, no account, one screen. Tap **Fog mode** once before setting off; a
foreground service then keeps sensing and speaking with the screen off.

## Build and install

Needs JDK 17 and the Android SDK (platform 34, build-tools 34). Point
`local.properties` at the SDK (`sdk.dir=/path/to/Android/Sdk`), then:

```bash
./gradlew assembleDebug
```

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Unit tests:

```bash
./gradlew testDebugUnitTest
```

## Using it

1. Start the relay somewhere the phone can reach (`make up` in the repo root).
2. In the app, set **Relay address** to `ws://<that machine>:8080/ws` (use `wss://` behind TLS). The default, `ws://10.0.2.2:8080/ws`, is the development machine as seen from the Android emulator.
3. Pick the voice language and how far you can see, then tap **Fog mode** and allow precise location.

### Testing indoors

Away from the two corridors the app reports "not on a FogLink road" and the relay
sends it nothing. Under **Position** choose **Demo (desk test)**, pick a road, a
starting kilometre and a speed, then switch Fog mode on. The app then pretends to
drive along that road: GPS and the braking sensor are ignored, everything else
(service, relay link, alert rule, voice, tone, vibration) is the real thing. To
hear an alert, start the dashboard simulation, press **Stop a vehicle**, and start
the demo about 0.8 km before the kilometre shown in the dashboard's phone link.
**Pretend I just braked hard** sends a real stop event from the demo position.

**Start recording sensors** writes motion sensors (100 Hz) and GPS to a CSV in the
app's own files folder (`Android/data/app.foglink/files/drives/`). `ml/` reads
that format directly: `make ml DRIVES="data/drives/*.csv"`.

## What is in here

| File | Job |
|---|---|
| `core/Alert.kt` | The alert rule, phrases (English, Hindi) and the gate that stops repeats |
| `core/Road.kt` | Carriageway geometry and rule-based map matching |
| `core/BrakeDetector.kt` | Threshold braking detector: gravity → forward axis from GPS speed changes → 0.35 g for 200 ms |
| `RelayLink.kt` | WebSocket to the relay, auto-reconnect, clock offset for measuring alert delay |
| `FogService.kt` | Foreground service: sensors, GPS, stop events, text-to-speech, tone, vibration, drive logger |
| `MainActivity.kt` | The one screen, and the full-screen alert (red and flashing for BRAKE) |

`core/` is a port of `sim/src/core/alert.js`, `road.js` and
`sim/src/phone/detector.js`. `VectorsTest` replays about 5,000 alert cases, 400
gate steps, 240 map-matching cases and a 65-second sensor stream generated from
the JavaScript and requires identical results. After changing the reference, run
`node sim/cli/vectors.mjs` to regenerate `app/src/test/resources/vectors.json`.

Road lines are not duplicated: the build copies `data/roads/*.json` into the APK.

## Not done yet

- **TFLite model.** The app runs the threshold detector only. `ml/` has not exported a `.tflite` file (needs `ai-edge-torch`); once it has, the model takes `[1, 4, 200]`: forward, lateral, vertical m/s² and gyro magnitude rad/s, newest sample last.
- **Battery.** A partial wake lock and 100 Hz sensors run for as long as Fog mode is on. Drain has not been measured, and nothing has been done yet to reduce it.
- **Battery-optimisation guides** for Xiaomi, Samsung and others: some phones will still kill the service.
- **Cleartext traffic** is allowed so a test phone can reach a relay on the local network over `ws://`. Switch it off in `AndroidManifest.xml` before distributing.
- **Release build.** Debug-signed only; no app icon beyond a system placeholder.
- **Direct phone-to-phone radio** (Bluetooth long-range / Wi-Fi Aware): v2.
