package app.foglink

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.speech.tts.TextToSpeech
import app.foglink.core.Alert
import app.foglink.core.AlertGate
import app.foglink.core.BrakeDetector
import app.foglink.core.BrakeEvent
import app.foglink.core.Carriageway
import app.foglink.core.matchCarriageway
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.util.Locale
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Fog mode. A foreground service, so it keeps sensing and speaking with the screen
 * off: motion sensors and GPS in, stop events out, voice alerts for what is ahead.
 * All sensing runs on one worker thread.
 */
class FogService : Service(), SensorEventListener, LocationListener {
    private lateinit var prefs: Prefs
    private lateinit var worker: HandlerThread
    private lateinit var handler: Handler
    private lateinit var sensors: SensorManager
    private lateinit var locations: LocationManager
    private var wake: PowerManager.WakeLock? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var tone: ToneGenerator? = null
    private var link: RelayLink? = null
    private var roads: List<Carriageway> = emptyList()

    private val detector = BrakeDetector()
    private val gate = AlertGate()
    private var id = RelayLink.randomId()
    private var idAt = 0L
    private var cw: Carriageway? = null
    private var s = 0.0
    private var speed = 0.0
    private var fixAt = 0L
    private var gyroRate: Double? = null
    private val delays = ArrayDeque<Long>()
    private var fogOn = false
    private var rec: BufferedWriter? = null
    private var recRows = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        worker = HandlerThread("foglink").also { it.start() }
        handler = Handler(worker.looper)
        sensors = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        locations = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        roads = assets.list("roads").orEmpty().filter { it.endsWith(".json") }.flatMap { name ->
            Carriageway.parse(assets.open("roads/$name").bufferedReader().use { it.readText() })
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_FOG_ON -> startFog()
            ACTION_FOG_OFF -> stopFog()
            ACTION_REC_ON -> startRecording()
            ACTION_REC_OFF -> stopRecording()
        }
        if (!fogOn && !FogState.recording) stopSelf()
        return START_STICKY
    }

    // ---------- lifecycle ----------

    @SuppressLint("MissingPermission", "WakelockTimeout") // the activity only starts us once location is granted
    private fun startSensing() {
        if (wake != null) return
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification(), type) else startForeground(1, notification())
        wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "foglink:fog").also { it.acquire() }
        // 100 Hz: the rate the model and the logger expect
        sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let { sensors.registerListener(this, it, 10_000, handler) }
        sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { sensors.registerListener(this, it, 10_000, handler) }
        try {
            locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, worker.looper)
        } catch (e: Exception) {
            FogState.say("GPS unavailable: ${e.message}")
        }
        handler.post(tick)
    }

    private fun stopSensingIfIdle() {
        if (fogOn || FogState.recording) return
        sensors.unregisterListener(this)
        locations.removeUpdates(this)
        handler.removeCallbacks(tick)
        wake?.let { if (it.isHeld) it.release() }
        wake = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startFog() {
        if (fogOn) return
        fogOn = true
        FogState.on = true
        detector.reset()
        startSensing()
        link = RelayLink(prefs.relayUrl, { m -> handler.post { onAlert(m) } }, { publish() })
        tone = try { ToneGenerator(AudioManager.STREAM_ALARM, 100) } catch (e: RuntimeException) { null }
        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                tts?.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                speak(if (prefs.lang == "hi") "फ़ॉग मोड चालू" else "Fog mode on", flush = false)
            } else FogState.say("No text-to-speech engine: alerts will beep and vibrate only")
        }
        publish()
    }

    private fun stopFog() {
        fogOn = false
        FogState.on = false
        link?.close()
        link = null
        tts?.shutdown()
        tts = null
        ttsReady = false
        tone?.release()
        tone = null
        cw = null
        publish()
        stopSensingIfIdle()
    }

    override fun onDestroy() {
        if (fogOn) stopFog()
        stopRecording()
        worker.quitSafely()
        super.onDestroy()
    }

    // ---------- sensing ----------

    override fun onSensorChanged(e: SensorEvent) {
        val t = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - e.timestamp) / 1_000_000
        if (e.sensor.type == Sensor.TYPE_GYROSCOPE) {
            val (x, y, z) = e.values
            gyroRate = sqrt((x * x + y * y + z * z).toDouble())
            lastGyro[0] = x; lastGyro[1] = y; lastGyro[2] = z
            return
        }
        val (x, y, z) = e.values
        if (fogOn) detector.motion(t, x.toDouble(), y.toDouble(), z.toDouble(), gyroRate)?.let { sendStop(it) }
        rec?.let {
            it.write("$t,m,$x,$y,$z,${lastGyro[0]},${lastGyro[1]},${lastGyro[2]},,,,,\n")
            recRows++
        }
    }

    private val lastGyro = FloatArray(3)
    private var prevFix: DoubleArray? = null

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    override fun onLocationChanged(loc: Location) {
        fixAt = System.currentTimeMillis()
        speed = if (loc.hasSpeed()) loc.speed.toDouble() else 0.0
        // Direction of travel: from the last two fixes when the phone has moved far enough
        // to trust it (some GPS chips, and the emulator, report a stale or zero bearing),
        // otherwise the chip's own bearing, otherwise unknown.
        val here = doubleArrayOf(loc.latitude, loc.longitude)
        val moved = prevFix?.let { Carriageway.haversine(it, here) } ?: 0.0
        val heading = when {
            speed <= 3 -> null
            moved >= 8 -> Carriageway.bearing(prevFix!!, here)
            loc.hasBearing() -> loc.bearing.toDouble()
            else -> null
        }
        prevFix = here
        val m = matchCarriageway(roads, loc.latitude, loc.longitude, heading, cw?.id)
        cw = m?.cw
        if (m != null) s = m.s
        if (fogOn) detector.gps(loc.time, speed, heading)?.let { sendStop(it) }
        rec?.let {
            it.write("${loc.time},g,,,,,,,${loc.latitude},${loc.longitude},${if (loc.hasSpeed()) loc.speed else ""},${if (loc.hasBearing()) loc.bearing else ""},${loc.accuracy}\n")
            recRows++
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
    override fun onProviderEnabled(provider: String) = Unit
    override fun onProviderDisabled(provider: String) = FogState.say("Location is switched off")

    /** Once a second: report where we are, rotate the ID, refresh the screen. */
    private val tick = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            if (now - idAt > ID_ROTATE_MS) {
                id = RelayLink.randomId()
                idAt = now
            }
            if (now - fixAt > 5000) cw = null // GPS went quiet
            val road = cw
            val l = link
            if (fogOn && road != null && l != null) {
                l.send(JSONObject().put("t", "pos").put("id", id).put("cw", road.id).put("s", round1(s)).put("v", round1(speed)).put("ts", l.now()))
            }
            publish()
            handler.postDelayed(this, 1000)
        }
    }

    private fun round1(x: Double) = (x * 10).roundToInt() / 10.0

    private fun sendStop(ev: BrakeEvent) {
        val road = cw ?: return
        val l = link ?: return
        l.send(JSONObject().put("t", "stop").put("id", id).put("cw", road.id).put("s", round1(s)).put("v", round1(speed)).put("dec", round1(ev.dec)).put("kind", ev.kind).put("ts", l.now()))
        if (ev.kind == "brake") FogState.say("Hard braking reported (%.2f g, %s)".format(Locale.US, ev.dec / Alert.G, ev.source))
    }

    // ---------- alerts ----------

    private fun onAlert(m: JSONObject) {
        val road = cw ?: return
        val l = link ?: return
        if (!fogOn || m.optString("cw") != road.id) return
        val ts = m.optLong("ts")
        if (ts > 0) {
            val d = l.now() - ts
            if (d in 0..9999) {
                delays.addLast(d)
                if (delays.size > 200) delays.removeFirst()
                val sorted = delays.sorted()
                FogState.delayText = "${sorted[sorted.size / 2]} / ${sorted[minOf(sorted.size - 1, (sorted.size * 0.95).toInt())]} ms"
            }
        }
        val res = Alert.assess(gap = m.optDouble("s") - s, v = speed, hazardV = m.optDouble("v", 0.0), hazardDec = m.optDouble("dec", 0.0), visibility = prefs.visibility.toDouble())
        if (gate.offer(res.level, System.currentTimeMillis())) announce(res)
    }

    private fun announce(res: Alert.Result) {
        val lang = prefs.lang
        val text = Alert.phrase(res, lang)
        if (res.level >= Alert.WARNING) {
            tone?.startTone(if (res.level == Alert.CRITICAL) ToneGenerator.TONE_CDMA_EMERGENCY_RINGBACK else ToneGenerator.TONE_PROP_BEEP2, if (res.level == Alert.CRITICAL) 600 else 150)
        }
        speak(text, flush = res.level == Alert.CRITICAL) // BRAKE never waits behind another sentence
        if (res.level == Alert.CRITICAL) {
            @Suppress("DEPRECATION")
            (getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 500, 100, 500, 100, 500), -1))
        }
        FogState.alertLevel = res.level
        FogState.alertText = text
        FogState.alertAt = System.currentTimeMillis()
        FogState.say("${arrayOf("", "Heads-up", "Warning", "CRITICAL")[res.level]}: “$text” (${res.gap.roundToInt()} m ahead)")
    }

    private fun speak(text: String, flush: Boolean) {
        val engine = tts ?: return
        if (!ttsReady) return
        engine.language = if (prefs.lang == "hi") Locale("hi", "IN") else Locale("en", "IN")
        engine.speak(text, if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, "foglink")
    }

    // ---------- drive logger: the CSV that ml/foglink_ml reads ----------

    private fun startRecording() {
        if (rec != null) return
        val dir = File(getExternalFilesDir(null), "drives").apply { mkdirs() }
        val file = File(dir, "foglink-drive-${java.text.SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(java.util.Date())}.csv")
        startSensing()
        handler.post {
            rec = file.bufferedWriter().also { it.write("t_ms,kind,ax,ay,az,gx,gy,gz,lat,lon,speed,bearing,acc\n") }
            recRows = 0
        }
        FogState.recording = true
        FogState.say("Recording to ${file.name}")
    }

    private fun stopRecording() {
        if (!FogState.recording) return
        FogState.recording = false
        handler.post {
            rec?.close()
            rec = null
            FogState.say("Saved $recRows rows")
            stopSensingIfIdle()
        }
    }

    // ---------- screen + notification ----------

    private fun publish() {
        FogState.speedKmh = if (fogOn) (speed * 3.6).roundToInt() else -1
        FogState.road = cw?.let { "${it.roadName} → ${it.towards}" }
        FogState.km = s / 1000
        FogState.relayOpen = link?.open == true
        FogState.rttMs = link?.rttMs ?: -1
        FogState.sensor = if (!fogOn) "–" else if (detector.aligned) "motion + GPS" else "GPS only"
        FogState.changed()
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Fog mode", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setContentTitle("FogLink is on")
            .setContentText("Listening for vehicles braking ahead")
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val ACTION_FOG_ON = "app.foglink.FOG_ON"
        const val ACTION_FOG_OFF = "app.foglink.FOG_OFF"
        const val ACTION_REC_ON = "app.foglink.REC_ON"
        const val ACTION_REC_OFF = "app.foglink.REC_OFF"
        private const val CHANNEL = "fog"
        private const val ID_ROTATE_MS = 10 * 60 * 1000L
    }
}
