package app.foglink.core

import kotlin.math.max
import kotlin.math.sqrt

/**
 * FogLink alert logic: decides when the phone speaks.
 *
 * This is a line-for-line port of sim/src/core/alert.js, which the simulator and
 * the web phone client use. AlertVectorsTest checks the two against each other
 * with vectors generated from the JavaScript; change both together.
 */
object Alert {
    const val G = 9.81
    const val HARD_BRAKE = 0.35 * G // a stop event fires above this deceleration
    const val SLOW_SPEED = 8.0 // m/s (~30 km/h): crawling on an expressway is itself a hazard
    const val RANGE_M = 2000.0

    const val NONE = 0
    const val HEADS_UP = 1
    const val WARNING = 2
    const val CRITICAL = 3

    const val WARN_DECEL = 1.0
    const val CRITICAL_DECEL = 3.0

    data class Result(val level: Int, val aReq: Double, val gap: Double, val stopped: Boolean)

    /** Extra distance held back in fog: the driver gets no visual confirmation until late. */
    fun fogMargin(visibilityM: Double): Double = when {
        visibilityM < 50 -> 40.0
        visibilityM < 200 -> 25.0
        else -> 10.0
    }

    /** Can this driver stop in time? See alert.js for the parameters. */
    fun assess(
        gap: Double, v: Double, hazardV: Double = 0.0, hazardDec: Double = 0.0,
        visibility: Double = 50.0, reactionS: Double = 1.5,
    ): Result {
        val none = Result(NONE, 0.0, gap, false)
        if (!(gap > 0) || gap > RANGE_M) return none
        val braking = hazardDec >= 1
        val stopped = hazardV < 1 || braking
        val effGap = if (braking) gap + hazardV * hazardV / (2 * hazardDec) else gap
        val closing = if (stopped) v else v - hazardV
        if (closing <= 0.5) return none
        val free = effGap - closing * reactionS - fogMargin(visibility)
        val aReq = if (free > 0) closing * closing / (2 * free) else Double.POSITIVE_INFINITY
        val level = when {
            aReq >= CRITICAL_DECEL -> CRITICAL
            aReq >= WARN_DECEL -> WARNING
            else -> HEADS_UP
        }
        return Result(level, aReq, gap, stopped)
    }

    private fun roundGap(m: Double): Long =
        if (m >= 100) Math.round(m / 50) * 50 else max(10L, Math.round(m / 10) * 10)

    /** The words that are spoken. Short on purpose: the driver never looks at the screen. */
    fun phrase(r: Result, lang: String): String {
        val d = roundGap(r.gap)
        if (lang == "hi") return when (r.level) {
            CRITICAL -> "ब्रेक!"
            WARNING -> if (r.stopped) "$d मीटर आगे गाड़ी रुकी है।" else "$d मीटर आगे गाड़ी धीमी है।"
            HEADS_UP -> "आगे ट्रैफ़िक धीमा है।"
            else -> ""
        }
        return when (r.level) {
            CRITICAL -> "BRAKE"
            WARNING -> if (r.stopped) "Vehicle stopped $d metres ahead." else "Slow vehicle $d metres ahead."
            HEADS_UP -> "Slow traffic ahead."
            else -> ""
        }
    }

    /** Speed (m/s) from which a driver can stop within `dist` metres. */
    fun stoppableSpeed(dist: Double, reactionS: Double, decel: Double): Double =
        -decel * reactionS + sqrt(decel * decel * reactionS * reactionS + 2 * decel * max(dist, 0.0))
}

/**
 * Stops the phone repeating itself: speak when the level rises, repeat a standing
 * warning only occasionally, and reset after a quiet period.
 */
class AlertGate(private val repeatMs: Long = 8000, private val quietMs: Long = 20000) {
    private var level = Alert.NONE
    private var lastSpoke = Long.MIN_VALUE / 2
    private var lastSeen = Long.MIN_VALUE / 2

    /** @return whether to speak now */
    fun offer(newLevel: Int, nowMs: Long): Boolean {
        if (newLevel == Alert.NONE) return false
        if (nowMs - lastSeen > quietMs) level = Alert.NONE
        lastSeen = nowMs
        val rising = newLevel > level
        val due = newLevel >= Alert.WARNING && newLevel == level && nowMs - lastSpoke >= repeatMs
        if (newLevel < level && nowMs - lastSpoke >= repeatMs) level = newLevel // easing off
        if (rising || due) {
            level = newLevel
            lastSpoke = nowMs
            return true
        }
        return false
    }
}
