package app.foglink.core

import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * One direction of one road, as a line that runs the way traffic drives.
 * Position "s" is metres from the start of the line. Port of sim/src/core/road.js.
 */
class Carriageway(
    val id: String,
    val towards: String,
    val roadName: String,
    private val line: Array<DoubleArray>,
    /** [from, to] metres along, where the line passes a toll plaza. */
    val tolls: List<DoubleArray> = emptyList(),
) {
    private val cum = DoubleArray(line.size)
    val length: Double

    init {
        for (i in 1 until line.size) cum[i] = cum[i - 1] + haversine(line[i - 1], line[i])
        length = cum[line.size - 1]
    }

    /**
     * Inside a toll plaza or its approach, where everyone crawls and expects to.
     * Phones do not report "slow" or "stopped" here; hard braking is still reported.
     * The queue forms before the booths, so the margin is longer on that side.
     */
    fun inTollZone(s: Double, before: Double = 600.0, after: Double = 300.0): Boolean =
        tolls.any { s >= it[0] - before && s <= it[1] + after }

    private fun seg(s: Double): Int {
        var lo = 0
        var hi = cum.size - 1
        while (hi - lo > 1) {
            val mid = (lo + hi) ushr 1
            if (cum[mid] <= s) lo = mid else hi = mid
        }
        return lo
    }

    fun bearingAt(s: Double): Double {
        val i = seg(min(max(s, 0.0), length - 0.01))
        return bearing(line[i], line[i + 1])
    }

    fun pointAt(s: Double): DoubleArray {
        val c = min(max(s, 0.0), length)
        val i = seg(c)
        val d = cum[i + 1] - cum[i]
        val f = (c - cum[i]) / (if (d == 0.0) 1.0 else d)
        return doubleArrayOf(line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f)
    }

    class Projection(val s: Double, val dist: Double)

    /** Nearest point on the line. */
    fun project(lat: Double, lon: Double): Projection {
        val k = cos(Math.toRadians(lat)) * 111320
        val ky = 110540.0
        var bestS = 0.0
        var bestD = Double.POSITIVE_INFINITY
        for (i in 0 until line.size - 1) {
            val ax = (line[i][1] - lon) * k
            val ay = (line[i][0] - lat) * ky
            val dx = (line[i + 1][1] - lon) * k - ax
            val dy = (line[i + 1][0] - lat) * ky - ay
            val len2 = (dx * dx + dy * dy).let { if (it == 0.0) 1e-9 else it }
            val t = min(1.0, max(0.0, -(ax * dx + ay * dy) / len2))
            val d = hypot(ax + dx * t, ay + dy * t)
            if (d < bestD) {
                bestD = d
                bestS = cum[i] + t * (cum[i + 1] - cum[i])
            }
        }
        return Projection(bestS, bestD)
    }

    companion object {
        private const val R = 6371000.0

        fun haversine(a: DoubleArray, b: DoubleArray): Double {
            val dLa = Math.toRadians(b[0] - a[0])
            val dLo = Math.toRadians(b[1] - a[1])
            val h = sin(dLa / 2).pow(2) + cos(Math.toRadians(a[0])) * cos(Math.toRadians(b[0])) * sin(dLo / 2).pow(2)
            return 2 * R * asin(sqrt(h))
        }

        fun bearing(a: DoubleArray, b: DoubleArray): Double {
            val la1 = Math.toRadians(a[0])
            val la2 = Math.toRadians(b[0])
            val dLo = Math.toRadians(b[1] - a[1])
            val y = sin(dLo) * cos(la2)
            val x = cos(la1) * sin(la2) - sin(la1) * cos(la2) * cos(dLo)
            return (Math.toDegrees(atan2(y, x)) + 360) % 360
        }

        fun angleDiff(a: Double, b: Double): Double = abs((a - b + 540) % 360 - 180)

        /** Parse one data/roads/<road>.json file. */
        fun parse(json: String): List<Carriageway> {
            val road = JSONObject(json)
            val cws = road.getJSONArray("carriageways")
            return List(cws.length()) { i ->
                val c = cws.getJSONObject(i)
                val pts = c.getJSONArray("line")
                val tolls = c.optJSONArray("tolls")
                Carriageway(
                    c.getString("id"), c.getString("towards"), road.getString("name"),
                    Array(pts.length()) { j -> pts.getJSONArray(j).let { doubleArrayOf(it.getDouble(0), it.getDouble(1)) } },
                    List(tolls?.length() ?: 0) { j -> tolls!!.getJSONArray(j).let { doubleArrayOf(it.getDouble(0), it.getDouble(1)) } },
                )
            }
        }
    }
}

class Match(val cw: Carriageway, val s: Double, val dist: Double)

/**
 * Rule-based map matching (v1): the nearest carriageway within maxDist metres whose
 * direction agrees with the GPS heading. The two carriageways of an expressway are
 * only ~20 m apart, so heading, not distance, tells them apart. Pass heading = null
 * when the vehicle is too slow for GPS heading to be trusted; then the previous
 * match breaks the tie.
 */
fun matchCarriageway(
    roads: List<Carriageway>, lat: Double, lon: Double, heading: Double?,
    previousId: String? = null, maxDist: Double = 60.0, maxAngle: Double = 60.0,
): Match? {
    var best: Match? = null
    for (cw in roads) {
        val p = cw.project(lat, lon)
        if (p.dist > maxDist) continue
        if (heading != null) {
            if (Carriageway.angleDiff(cw.bearingAt(p.s), heading) > maxAngle) continue
        } else if (previousId != null && cw.id != previousId) continue
        if (best == null || p.dist < best.dist) best = Match(cw, p.s, p.dist)
    }
    return best
}
