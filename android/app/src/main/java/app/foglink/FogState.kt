package app.foglink

import android.content.Context
import android.os.Handler
import android.os.Looper

/** What the service knows, for the screen to show. Updated from any thread, observed on the main thread. */
object FogState {
    @Volatile var on = false
    @Volatile var recording = false
    @Volatile var speedKmh = -1
    @Volatile var road: String? = null
    @Volatile var km = 0.0
    @Volatile var relayOpen = false
    @Volatile var rttMs = -1L
    @Volatile var sensor = "–"
    @Volatile var delayText = "–"
    @Volatile var cover = "" // Cover.* once Fog mode is on, "" before the first check
    @Volatile var alertLevel = 0
    @Volatile var alertText = ""
    @Volatile var alertAt = 0L
    val log = ArrayDeque<String>()

    private val main = Handler(Looper.getMainLooper())
    @Volatile var listener: (() -> Unit)? = null

    fun changed() {
        main.post { listener?.invoke() }
    }

    fun say(line: String) {
        val stamp = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
        synchronized(log) {
            log.addFirst("$stamp  $line")
            while (log.size > 6) log.removeLast()
        }
        changed()
    }
}

/** The few settings there are. */
class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("foglink", Context.MODE_PRIVATE)
    var lang: String
        get() = p.getString("lang", "en")!!
        set(v) = p.edit().putString("lang", v).apply()
    var visibility: Int
        get() = p.getInt("visibility", 50)
        set(v) = p.edit().putInt("visibility", v).apply()
    var relayUrl: String
        get() = p.getString("relay", BuildConfig.DEFAULT_RELAY)!!
        set(v) = p.edit().putString("relay", v).apply()

    /** The driver switched Fog mode on and has not switched it off: restore it if Android restarts the service. */
    var fogWanted: Boolean
        get() = p.getBoolean("fogWanted", false)
        set(v) = p.edit().putBoolean("fogWanted", v).apply()
    /** Developer mode: shows the relay address, the demo position and the drive logger. */
    var dev: Boolean
        get() = p.getBoolean("dev", false)
        set(v) = p.edit().putBoolean("dev", v).apply()
    /** The demo position only applies while developer mode is on. */
    val demoActive: Boolean get() = dev && demo

    // Desk testing: a pretend position on a road instead of GPS
    var demo: Boolean
        get() = p.getBoolean("demo", false)
        set(v) = p.edit().putBoolean("demo", v).apply()
    var demoCw: String
        get() = p.getString("demoCw", "nh48:jaipur")!!
        set(v) = p.edit().putString("demoCw", v).apply()
    var demoKm: Float
        get() = p.getFloat("demoKm", 40f)
        set(v) = p.edit().putFloat("demoKm", v).apply()
    var demoKmh: Int
        get() = p.getInt("demoKmh", 80)
        set(v) = p.edit().putInt("demoKmh", v).apply()
}
