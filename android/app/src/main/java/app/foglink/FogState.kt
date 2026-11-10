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
}
