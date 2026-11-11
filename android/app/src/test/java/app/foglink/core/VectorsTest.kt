package app.foglink.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/**
 * Checks the Kotlin port against the JavaScript reference (sim/src/core, used by
 * the simulator and the web phone client). The vectors are produced by
 * `node sim/cli/vectors.mjs`; regenerate them whenever the reference changes.
 */
class VectorsTest {
    private val vectors = JSONObject(javaClass.classLoader!!.getResource("vectors.json")!!.readText())
    private fun JSONArray.dOrNull(i: Int): Double? = if (isNull(i)) null else getDouble(i)
    private fun JSONArray.sOrNull(i: Int): String? = if (isNull(i)) null else getString(i)

    @Test
    fun alertLevelsAndPhrasesMatchReference() {
        val cases = vectors.getJSONArray("alert")
        assertTrue(cases.length() > 1000)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONArray(i)
            val r = Alert.assess(c.getDouble(0), c.getDouble(1), c.getDouble(2), c.getDouble(3), c.getDouble(4))
            assertEquals("level for $c", c.getInt(5), r.level)
            val aReq = c.dOrNull(6)
            if (aReq == null) assertTrue("aReq for $c", r.aReq.isInfinite()) else assertEquals("aReq for $c", aReq, r.aReq, 1e-9)
            assertEquals("English for $c", c.getString(7), Alert.phrase(r, "en"))
            assertEquals("Hindi for $c", c.getString(8), Alert.phrase(r, "hi"))
        }
    }

    @Test
    fun gateSpeaksAtTheSameMoments() {
        val steps = vectors.getJSONArray("gate")
        val gate = AlertGate()
        for (i in 0 until steps.length()) {
            val s = steps.getJSONArray(i)
            assertEquals("step $i $s", s.getBoolean(2), gate.offer(s.getInt(0), s.getLong(1)))
        }
    }

    @Test
    fun mapMatchingPicksTheSameCarriageway() {
        val roads = listOf("nh48", "yamuna").flatMap { Carriageway.parse(File("../../data/roads/$it.json").readText()) }
        assertEquals(4, roads.size)
        val cases = vectors.getJSONArray("match")
        var matched = 0
        for (i in 0 until cases.length()) {
            val c = cases.getJSONArray(i)
            val m = matchCarriageway(roads, c.getDouble(0), c.getDouble(1), c.dOrNull(2), c.sOrNull(3))
            assertEquals("carriageway for $c", c.sOrNull(4), m?.cw?.id)
            if (m != null) {
                matched++
                assertTrue("s for $c: ${m.s}", abs(m.s - c.getDouble(5)) < 0.01)
            }
        }
        assertTrue(matched > cases.length() / 2)
    }

    @Test
    fun detectorFiresOnTheSameSamples() {
        val d = vectors.getJSONObject("detector")
        val stream = d.getJSONArray("stream")
        val want = d.getJSONArray("fired")
        val det = BrakeDetector()
        val got = mutableListOf<String>()
        for (i in 0 until stream.length()) {
            val r = stream.getJSONArray(i)
            val t = r.getLong(1)
            val e = if (r.getString(0) == "m") det.motion(t, r.getDouble(2), r.getDouble(3), r.getDouble(4), r.dOrNull(5))
            else det.gps(t, r.getDouble(2), r.dOrNull(3))
            if (e != null) got += "$t ${e.kind} ${e.source}"
        }
        val expected = (0 until want.length()).map { want.getJSONArray(it).let { w -> "${w.getLong(0)} ${w.getString(1)} ${w.getString(2)}" } }
        assertTrue("the reference stream should contain braking", expected.any { it.endsWith("brake motion") })
        assertEquals(expected, got)
    }

    @Test
    fun coverStatusMatchesReference() {
        val states = vectors.getJSONArray("coverStates")
        assertEquals(16, states.length())
        for (i in 0 until states.length()) {
            val c = states.getJSONArray(i)
            assertEquals("state for $c", c.getString(4), Cover.state(c.getBoolean(0), c.getBoolean(1), c.getBoolean(2), c.getBoolean(3)))
        }
        val phrases = vectors.getJSONArray("coverPhrases")
        assertEquals(5, phrases.length())
        for (i in 0 until phrases.length()) {
            val p = phrases.getJSONArray(i)
            assertEquals(p.getString(1), Cover.phrase(p.getString(0), "en"))
            assertEquals(p.getString(2), Cover.phrase(p.getString(0), "hi"))
        }
        val steps = vectors.getJSONArray("coverGate")
        val gate = CoverGate()
        var spoken = 0
        for (i in 0 until steps.length()) {
            val s = steps.getJSONArray(i)
            assertEquals("step $i $s", s.getBoolean(2), gate.offer(s.getString(0), s.getLong(1)))
            if (s.getBoolean(2)) spoken++
        }
        assertTrue(spoken > 3)
    }

    @Test
    fun tollZonesMatchReference() {
        val roads = listOf("nh48", "yamuna").flatMap { Carriageway.parse(File("../../data/roads/$it.json").readText()) }.associateBy { it.id }
        val cases = vectors.getJSONArray("toll")
        var inside = 0
        for (i in 0 until cases.length()) {
            val c = cases.getJSONArray(i)
            assertEquals("toll zone for $c", c.getBoolean(2), roads.getValue(c.getString(0)).inTollZone(c.getDouble(1)))
            if (c.getBoolean(2)) inside++
        }
        assertTrue(inside > 20 && inside < cases.length())
    }

    @Test
    fun roadFilesParse() {
        val nh48 = Carriageway.parse(File("../../data/roads/nh48.json").readText())
        val jaipur = nh48.first { it.id == "nh48:jaipur" }
        assertNotNull(jaipur)
        assertTrue(jaipur.length > 220_000 && jaipur.length < 270_000)
    }
}
