package app.foglink

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * WebSocket link to the FogLink relay. Reconnects by itself and keeps an estimate
 * of the relay's clock, so event-to-alert delay can be measured across two phones.
 * Wire format: see server/relay.go.
 */
class RelayLink(private val url: String, private val onAlert: (JSONObject) -> Unit, private val onState: () -> Unit) {
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private var ws: WebSocket? = null
    private var pinger: ScheduledFuture<*>? = null
    private var bestRtt = Long.MAX_VALUE
    @Volatile private var closed = false
    @Volatile var open = false
        private set
    @Volatile var rttMs: Long = -1
        private set
    @Volatile private var offsetMs = 0.0 // relay clock minus phone clock

    init { connect() }

    /** Phone time expressed on the relay's clock: this goes in `ts`. */
    fun now(): Long = (System.currentTimeMillis() + offsetMs).roundToLong()

    private fun connect() {
        if (closed) return
        val request = try {
            Request.Builder().url(url).build()
        } catch (e: IllegalArgumentException) {
            return // not a usable address; the user fixes it on screen
        }
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                open = true
                onState()
                pinger = timer.scheduleWithFixedDelay({ send(JSONObject().put("t", "ping").put("ts", System.currentTimeMillis())) }, 0, 5, TimeUnit.SECONDS)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = try { JSONObject(text) } catch (e: Exception) { return }
                when (m.optString("t")) {
                    "pong" -> {
                        val now = System.currentTimeMillis()
                        val rtt = now - m.optLong("ts")
                        rttMs = rtt
                        if (rtt <= min(bestRtt, Long.MAX_VALUE - 20) + 20) { // the quickest round trips give the best clock estimate
                            bestRtt = min(rtt, bestRtt)
                            offsetMs = m.optLong("rts") - (m.optLong("ts") + now) / 2.0
                        }
                        onState()
                    }
                    "alert" -> onAlert(m)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry()
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry()
        })
    }

    private fun retry() {
        open = false
        pinger?.cancel(false)
        onState()
        if (!closed) timer.schedule({ connect() }, 1500, TimeUnit.MILLISECONDS)
    }

    fun send(m: JSONObject): Boolean = open && ws?.send(m.toString()) == true

    fun close() {
        closed = true
        open = false
        ws?.close(1000, null)
        timer.shutdownNow()
        client.dispatcher.executorService.shutdown()
    }

    companion object {
        /** Random anonymous vehicle ID; the caller replaces it every 10 minutes. */
        fun randomId(): String = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    }
}
