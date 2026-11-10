package app.foglink.core

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

class BrakeEvent(val kind: String, val dec: Double, val source: String)

/**
 * Threshold braking detector, a port of sim/src/phone/detector.js.
 * Works wherever the phone sits: "down" comes from gravity, "forward" from matching
 * horizontal acceleration against GPS speed changes, and a stop event fires on
 * sustained forward deceleration above 0.35 g. Not thread-safe: call from one thread.
 */
class BrakeDetector(
    private val threshold: Double = Alert.HARD_BRAKE,
    private val sustainMs: Long = 200,
    private val refractoryMs: Long = 1000,
) {
    private var g: DoubleArray? = null
    private var f = DoubleArray(3) // accumulated evidence for the forward direction
    private var weight = 0.0
    private var hSum = DoubleArray(3)
    private var hN = 0
    var dec = 0.0 // smoothed forward deceleration, m/s^2
        private set
    private var over = -1L
    private var lastFire = Long.MIN_VALUE / 2
    private var lastT = -1L
    private var speed = 0.0
    private var gpsT = -1L
    private var gpsSpeed = 0.0
    private var gpsHeading: Double? = null
    private var fastAt = Long.MIN_VALUE / 2
    private var lastSlow = Long.MIN_VALUE / 2
    private var quietUntil = 0L

    val aligned get() = weight >= 6

    fun reset() {
        g = null; f = DoubleArray(3); weight = 0.0; hSum = DoubleArray(3); hN = 0; dec = 0.0; over = -1
        lastT = -1; speed = 0.0; gpsT = -1; quietUntil = 0
        lastFire = Long.MIN_VALUE / 2; fastAt = Long.MIN_VALUE / 2; lastSlow = Long.MIN_VALUE / 2
    }

    private fun dot(a: DoubleArray, b: DoubleArray) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    private fun norm(a: DoubleArray) = sqrt(dot(a, a))

    /**
     * Accelerometer sample including gravity, device axes, m/s^2. `rot` is the gyro
     * rotation rate in rad/s, or null if the phone has no gyro.
     */
    fun motion(t: Long, ax: Double, ay: Double, az: Double, rot: Double?): BrakeEvent? {
        val a = doubleArrayOf(ax, ay, az)
        val dt = if (lastT < 0) 0.02 else min(0.2, max(0.001, (t - lastT) / 1000.0))
        lastT = t
        val grav = g ?: a.copyOf().also { g = it }
        // A sudden change in which way is "down" means the phone was moved or dropped:
        // forget the alignment and stay quiet while it settles. Hard braking also tilts
        // apparent gravity (0.5 g is 27 degrees) but without the phone rotating, so the
        // gyro tells the two apart; without a gyro only a very large tilt counts.
        val cosAngle = dot(a, grav) / (norm(a) * norm(grav)).let { if (it == 0.0) 1.0 else it }
        if (if (rot != null) rot > 2.5 && cosAngle < 0.97 else cosAngle < 0.78) {
            a.copyInto(grav)
            f = DoubleArray(3)
            weight = 0.0
            quietUntil = t + 1500
        }
        // gravity is tracked slowly: a quick filter would take a few seconds of braking
        // for a change in "down" and cancel it
        val kg = dt / (8 + dt)
        for (i in 0..2) grav[i] += kg * (a[i] - grav[i])
        val gn = norm(grav).let { if (it == 0.0) 1.0 else it }
        val up = DoubleArray(3) { grav[it] / gn }
        val lin = DoubleArray(3) { a[it] - grav[it] }
        val vert = dot(lin, up)
        val h = DoubleArray(3) { lin[it] - vert * up[it] }
        for (i in 0..2) hSum[i] += h[i]
        hN++
        if (!aligned || t < quietUntil) {
            over = -1
            return null
        }
        val fn = norm(f).let { if (it == 0.0) 1.0 else it }
        val fwd = -dot(h, f) / fn // positive = slowing down
        dec += dt / (0.25 + dt) * (fwd - dec)
        if (dec >= threshold && speed > 4) {
            if (over < 0) over = t
            if (t - over >= sustainMs && t - lastFire >= refractoryMs) {
                lastFire = t
                return BrakeEvent("brake", dec, "motion")
            }
        } else over = -1
        return null
    }

    /** GPS fix: speed in m/s, heading in degrees or null. */
    fun gps(t: Long, speedNow: Double, heading: Double?): BrakeEvent? {
        var ev: BrakeEvent? = null
        if (gpsT >= 0 && t > gpsT) {
            val dt = (t - gpsT) / 1000.0
            val acc = (speedNow - gpsSpeed) / dt
            val prevH = gpsHeading
            val turn = if (heading != null && prevH != null) abs((heading - prevH + 540) % 360 - 180) / dt else 0.0
            // learn "forward" while speeding up or slowing down in a straight line
            if (hN > 0 && abs(acc) > 0.4 && abs(acc) < 8 && turn < 3 && speedNow > 3 && dt < 3) {
                for (i in 0..2) f[i] += hSum[i] / hN * acc
                weight += abs(acc)
            }
            // GPS alone also catches hard braking, just later
            if (-acc >= threshold && gpsSpeed > 4 && t - lastFire >= 1500) {
                lastFire = t
                ev = BrakeEvent("brake", -acc, "gps")
            }
        }
        hSum = DoubleArray(3)
        hN = 0
        gpsT = t
        gpsSpeed = speedNow
        gpsHeading = heading
        speed = speedNow
        if (speedNow > 14) fastAt = t
        // crawling or stopped shortly after expressway speed: keep telling the cars behind
        if (ev == null && speedNow < Alert.SLOW_SPEED && t - fastAt < 60000 && t - lastSlow >= 2000) {
            lastSlow = t
            ev = BrakeEvent(if (speedNow < 1) "stopped" else "slow", 0.0, "gps")
        }
        return ev
    }
}
