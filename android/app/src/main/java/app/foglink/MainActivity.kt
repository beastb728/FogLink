package app.foglink

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import app.foglink.core.Alert

/**
 * One screen. The driver taps Fog mode once before setting off and never touches
 * the phone again; everything that matters afterwards is spoken by FogService.
 */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var fog: Button
    private lateinit var status: TextView
    private lateinit var log: TextView
    private lateinit var rec: Button
    private lateinit var overlay: TextView
    private lateinit var relay: EditText
    private lateinit var demoBox: LinearLayout
    private lateinit var demoKm: EditText
    private lateinit var demoKmh: EditText
    private lateinit var testBrake: Button
    private val segments = mutableListOf<() -> Unit>()
    private val ui = Handler(Looper.getMainLooper())
    private var pending: String? = null
    private var flash = false

    private val bg = Color.parseColor("#0e1218")
    private val panel = Color.parseColor("#161c25")
    private val line = Color.parseColor("#263040")
    private val ink = Color.parseColor("#e6ebf2")
    private val muted = Color.parseColor("#8d99ab")
    private val accent = Color.parseColor("#4aa8ff")

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun box(fill: Int, stroke: Int) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(12).toFloat()
        setStroke(dp(1), stroke)
    }

    private fun label(s: String) = TextView(this).apply {
        this.text = s.uppercase()
        setTextColor(muted)
        textSize = 11f
        letterSpacing = 0.08f
        setPadding(0, dp(20), 0, dp(6))
    }

    /** A row of mutually exclusive choices. */
    private fun segment(options: List<Pair<String, String>>, current: () -> String, pick: (String) -> Unit): View {
        val row = LinearLayout(this)
        val buttons = options.map { (value, title) ->
            Button(this).apply {
                this.text = title
                isAllCaps = false
                setOnClickListener {
                    pick(value)
                    segments.forEach { it() }
                }
                row.addView(this, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(4) })
            } to value
        }
        segments += {
            for ((b, value) in buttons) {
                val on = value == current()
                b.background = box(if (on) Color.parseColor("#22344b") else panel, if (on) accent else line)
                b.setTextColor(if (on) ink else muted)
            }
        }
        return row
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        window.statusBarColor = bg
        window.navigationBarColor = bg

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(32))
        }
        col.addView(TextView(this).apply { this.text = "FogLink"; setTextColor(ink); textSize = 22f; typeface = Typeface.DEFAULT_BOLD })
        col.addView(TextView(this).apply {
            this.text = "Warns you by voice when a vehicle ahead in fog brakes hard or stops. An aid only: it cannot see every hazard and does not replace your own eyes and brakes."
            setTextColor(muted); textSize = 13f; setPadding(0, dp(2), 0, dp(14))
        })
        fog = Button(this).apply {
            isAllCaps = false; textSize = 22f; typeface = Typeface.DEFAULT_BOLD
            setOnClickListener { if (FogState.on) send(FogService.ACTION_FOG_OFF) else withPermissions(FogService.ACTION_FOG_ON) }
        }
        col.addView(fog, LinearLayout.LayoutParams(MATCH_PARENT, dp(110)))
        status = TextView(this).apply { setTextColor(ink); textSize = 15f; setLineSpacing(dp(4).toFloat(), 1f); background = box(panel, line); setPadding(dp(14), dp(12), dp(14), dp(12)) }
        col.addView(status, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) })

        col.addView(label("Voice"))
        col.addView(segment(listOf("en" to "English", "hi" to "हिन्दी"), { prefs.lang }) { prefs.lang = it })
        col.addView(label("How far can you see?"))
        col.addView(segment(listOf("200" to "200 m", "50" to "50 m", "20" to "20 m"), { prefs.visibility.toString() }) { prefs.visibility = it.toInt() })

        col.addView(label("Position"))
        col.addView(segment(listOf("gps" to "Phone GPS", "demo" to "Demo (desk test)"), { if (prefs.demo) "demo" else "gps" }) {
            prefs.demo = it == "demo"
            render()
        })
        demoBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        demoBox.addView(TextView(this).apply {
            this.text = "Pretends this phone is driving along the road below, so alerts can be tested indoors. Takes effect the next time Fog mode is switched on."
            setTextColor(muted); textSize = 12f; setPadding(0, dp(8), 0, dp(8))
        })
        val pickRoad: (String) -> Unit = { prefs.demoCw = it }
        demoBox.addView(segment(listOf("nh48:jaipur" to "NH-48 → Jaipur", "nh48:delhi" to "NH-48 → Delhi"), { prefs.demoCw }, pickRoad))
        demoBox.addView(segment(listOf("yamuna:agra" to "Yamuna → Agra", "yamuna:greater-noida" to "Yamuna → Gr. Noida"), { prefs.demoCw }, pickRoad),
            LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(4) })
        fun number(value: String, hint: String, decimal: Boolean) = EditText(this).apply {
            setText(value)
            this.hint = hint
            setTextColor(ink); setHintTextColor(muted); textSize = 14f
            inputType = InputType.TYPE_CLASS_NUMBER or (if (decimal) InputType.TYPE_NUMBER_FLAG_DECIMAL else 0)
            background = box(panel, line); setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        demoKm = number(prefs.demoKm.toString(), "km", true)
        demoKmh = number(prefs.demoKmh.toString(), "km/h", false)
        val numbers = LinearLayout(this)
        for ((title, field) in listOf("Start at km" to demoKm, "Speed, km/h" to demoKmh)) {
            val cell = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            cell.addView(TextView(this).apply { this.text = title; setTextColor(muted); textSize = 12f; setPadding(0, dp(10), 0, dp(4)) })
            cell.addView(field)
            numbers.addView(cell, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(4) })
        }
        demoBox.addView(numbers)
        testBrake = Button(this).apply {
            this.text = "Pretend I just braked hard"
            isAllCaps = false
            setTextColor(ink)
            background = box(panel, line)
            setOnClickListener { if (FogState.on) send(FogService.ACTION_TEST_BRAKE) }
        }
        demoBox.addView(testBrake, LinearLayout.LayoutParams(MATCH_PARENT, dp(52)).apply { topMargin = dp(8) })
        col.addView(demoBox)

        col.addView(label("Relay address"))
        relay = EditText(this).apply {
            setText(prefs.relayUrl)
            setTextColor(ink); textSize = 14f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            background = box(panel, line); setPadding(dp(12), dp(10), dp(12), dp(10))
            setOnFocusChangeListener { _, has -> if (!has) prefs.relayUrl = this.text.toString().trim() }
        }
        col.addView(relay)

        col.addView(label("Drive logger"))
        rec = Button(this).apply {
            isAllCaps = false
            setTextColor(ink)
            background = box(panel, line)
            setOnClickListener { if (FogState.recording) send(FogService.ACTION_REC_OFF) else withPermissions(FogService.ACTION_REC_ON) }
        }
        col.addView(rec, LinearLayout.LayoutParams(MATCH_PARENT, dp(52)))
        log = TextView(this).apply { setTextColor(muted); textSize = 12f; setPadding(0, dp(10), 0, 0); setLineSpacing(dp(3).toFloat(), 1f) }
        col.addView(log)
        col.addView(TextView(this).apply {
            this.text = "No account, no name, no phone number. While Fog mode is on, the phone sends its road, distance along it and speed under a random ID that changes every 10 minutes. The relay forgets it within seconds. Recordings stay on this phone."
            setTextColor(muted); textSize = 12f; setPadding(0, dp(20), 0, 0)
        })

        overlay = TextView(this).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD; visibility = View.GONE; setPadding(dp(24), 0, dp(24), 0) }
        val root = FrameLayout(this).apply { setBackgroundColor(bg) }
        root.addView(ScrollView(this).apply { addView(col) }, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(overlay, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setContentView(root)
        segments.forEach { it() }
    }

    override fun onResume() {
        super.onResume()
        FogState.listener = ::render
        render()
    }

    private fun saveFields() {
        prefs.relayUrl = relay.text.toString().trim()
        demoKm.text.toString().toFloatOrNull()?.let { prefs.demoKm = it }
        demoKmh.text.toString().toIntOrNull()?.let { prefs.demoKmh = it.coerceIn(0, 160) }
    }

    override fun onPause() {
        FogState.listener = null
        saveFields()
        super.onPause()
    }

    private fun send(action: String) {
        saveFields()
        val i = Intent(this, FogService::class.java).setAction(action)
        if (action == FogService.ACTION_FOG_ON || action == FogService.ACTION_REC_ON) startForegroundService(i) else startService(i)
    }

    private fun withPermissions(action: String) {
        val need = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) need += Manifest.permission.POST_NOTIFICATIONS
        val missing = need.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return send(action)
        pending = action
        requestPermissions(missing.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        val action = pending ?: return
        pending = null
        // location is essential; the notification permission is not
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) send(action)
        else FogState.say("FogLink needs precise location to know which road you are on")
    }

    private fun render() {
        val on = FogState.on
        fog.text = if (on) "Fog mode is ON\ntap to switch off" else "Fog mode is off\ntap once before you set off"
        fog.background = box(if (on) Color.parseColor("#12324f") else panel, if (on) accent else line)
        fog.setTextColor(ink)
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        relay.isEnabled = !on
        demoBox.visibility = if (prefs.demo) View.VISIBLE else View.GONE
        demoKm.isEnabled = !on
        demoKmh.isEnabled = !on
        testBrake.alpha = if (on) 1f else 0.4f
        val road = FogState.road
        status.text = listOf(
            "Speed: " + (if (FogState.speedKmh >= 0) "${FogState.speedKmh} km/h" else "–"),
            "Road: " + (road?.let { "$it, km %.1f".format(FogState.km) } ?: if (on) "not on a FogLink road" else "–"),
            "Relay: " + (if (FogState.relayOpen) (if (FogState.rttMs >= 0) "${FogState.rttMs} ms" else "online") else "offline"),
            "Braking sensor: ${FogState.sensor}",
            "Alert delay, median / 95%: ${FogState.delayText}",
        ).joinToString("\n")
        rec.text = if (FogState.recording) "Stop and save recording" else "Start recording sensors"
        log.text = synchronized(FogState.log) { FogState.log.joinToString("\n") }

        // the alert itself: full screen, red and flashing when it says BRAKE
        val age = System.currentTimeMillis() - FogState.alertAt
        val level = FogState.alertLevel
        val show = level > 0 && age < (if (level == Alert.CRITICAL) 4000 else 3000)
        overlay.visibility = if (show) View.VISIBLE else View.GONE
        if (show) {
            overlay.text = FogState.alertText
            overlay.textSize = if (level == Alert.CRITICAL) 84f else 34f
            flash = !flash
            val red = Color.parseColor("#e11d1d")
            when (level) {
                Alert.CRITICAL -> { overlay.setBackgroundColor(if (flash) red else Color.WHITE); overlay.setTextColor(if (flash) Color.WHITE else red) }
                Alert.WARNING -> { overlay.setBackgroundColor(Color.parseColor("#b87400")); overlay.setTextColor(Color.WHITE) }
                else -> { overlay.setBackgroundColor(Color.parseColor("#ee1c2a3d")); overlay.setTextColor(ink) }
            }
            ui.removeCallbacksAndMessages(null)
            ui.postDelayed(::render, if (level == Alert.CRITICAL) 180 else 500)
        }
    }
}
