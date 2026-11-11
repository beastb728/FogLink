# FogLink Android app

Kotlin, no account, one screen. Tap **Fog mode** once before setting off; a
foreground service then keeps sensing and speaking with the screen off.

## Build and install

Needs JDK 17 and the Android SDK (platform 34, build-tools 34). Point
`local.properties` at the SDK (`sdk.dir=/path/to/Android/Sdk`), then:

```bash
./gradlew assembleRelease
```

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

There are two builds, and they install side by side:

| | Release (`app.foglink`, "FogLink") | Debug (`app.foglink.debug`, "FogLink (debug)") |
|---|---|---|
| Relay address | `wss://` only | `ws://` allowed, for a relay on the local network |
| Code | shrunk with R8 (about 220 KB) | not shrunk |
| Signed with | the release key | the SDK's debug key |

**The release key.** `keystore.properties` and `keystore/` (both git-ignored) hold
the key that signs release builds. Android only accepts an update signed with the
same key as the installed app, so losing it means every user must uninstall and
reinstall. Keep a copy of both somewhere safe, outside this folder. Without them
`assembleRelease` still builds, unsigned.

Unit tests:

```bash
./gradlew testDebugUnitTest
```

## Using it

Pick the voice language and how far you can see, then tap **Fog mode** and allow
precise location. The app uses the public relay, `wss://foglink-relay.fly.dev/ws`.
The first status line, **Warnings**, says whether the app can warn right now; when
that changes it also says so aloud ("FogLink offline. No network…").

### Keeping it running

Fog mode is a foreground service, but many phones stop background apps anyway.

- The app shows a yellow button until it is exempt from battery optimisation. Tap it and allow.
- If Android does kill the service, it is restarted and Fog mode comes back by itself (checked on an emulator by killing the process). If Android refuses to let it use location from the background, a notification asks the driver to open the app.
- Some makers add their own limits on top. On OnePlus, Xiaomi, Oppo, Vivo and Samsung phones also look in Settings → Battery (or Apps → FogLink → Battery) for "Allow background activity" or "Unrestricted" and "Auto-launch", and lock the app in the recent-apps screen. The exact names differ by phone and version; this has not been verified on each brand.

### Developer mode

Tap the **FogLink** title seven times (with Fog mode off) to show the testing
controls: the demo position, the relay address and the drive logger. To use your
own relay, start it (`make up` in the repo root) and enter `ws://<that machine>:8080/ws`
in the debug build; from the Android emulator the development machine is
`ws://10.0.2.2:8080/ws`.

### Testing indoors

Away from the two corridors the app reports "not on a FogLink road" and the relay
sends it nothing. In developer mode, under **Position** choose **Demo (desk test)**, pick a road, a
starting kilometre and a speed, then switch Fog mode on. The app then pretends to
drive along that road: GPS and the braking sensor are ignored, everything else
(service, relay link, alert rule, voice, tone, vibration) is the real thing. A demo
position joins the relay's simulated world, so it hears the dashboard's virtual
vehicles and can never alert, or be alerted by, a phone in a real car. To
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
- **Play Store.** Not submitted: it needs a privacy policy page and the background-location declaration.
- **Direct phone-to-phone radio** (Bluetooth long-range / Wi-Fi Aware): v2.
