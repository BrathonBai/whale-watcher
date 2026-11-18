package io.github.ccch1mneyyy.dsh_app.embodied

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The smallest WebSocket client that can talk to the injected bridge (protocol §8.2). Hand-rolled
 * because the app has no OkHttp/coroutines: `java.net.Socket`, one reader thread, and a lock around
 * writes.
 *
 * Plain `ws://` only — the bridge listens on loopback (PRoot shares the app's network namespace),
 * so TLS would add nothing. Client frames are always masked; server frames are accepted either way
 * (the bridge never masks, but a proxy might). Text, binary, ping, pong and close are handled;
 * fragmented server messages are reassembled.
 *
 * Callbacks run on the reader/connect thread; the gateway posts them onto its own single-thread
 * executor before touching state. [onClosed] is called exactly once, also when [close] is called
 * from outside.
 */
class EmbodiedWebSocket(private val url: String, private val listener: Listener) {

    interface Listener {
        fun onOpen(socket: EmbodiedWebSocket)
        fun onText(socket: EmbodiedWebSocket, text: String)
        fun onBinary(socket: EmbodiedWebSocket, bytes: ByteArray)
        fun onClosed(socket: EmbodiedWebSocket, reason: String)
    }

    @Volatile private var socket: Socket? = null
    @Volatile private var output: OutputStream? = null
    @Volatile var isOpen: Boolean = false
        private set

    /** Set by [close] before the connect finishes, so a cancelled start never opens a lone link. */
    @Volatile private var cancelled = false
    private val closed = AtomicBoolean(false)
    private val writeLock = Any()
    private val random = SecureRandom()
    private val thread = Thread({ run() }, "embodied-ws").apply { isDaemon = true }

    fun start() {
        thread.start()
    }

    fun sendText(text: String): Boolean = send(OPCODE_TEXT, text.toByteArray(Charsets.UTF_8))

    fun sendBinary(payload: ByteArray): Boolean = send(OPCODE_BINARY, payload)

    /** Closes the socket; the reader thread reports [Listener.onClosed] from its finally block. */
    fun close() {
        cancelled = true
        isOpen = false
        runCatching { socket?.close() }
    }

    private fun send(opcode: Int, payload: ByteArray): Boolean {
        if (!isOpen) return false
        return try {
            writeFrame(opcode, payload)
            true
        } catch (_: IOException) {
            close()
            false
        }
    }

    private fun run() {
        var reason = "closed"
        try {
            if (cancelled) throw IOException("closed before connect")
            val uri = URI(url)
            if (!uri.scheme.equals("ws", ignoreCase = true) || uri.host.isNullOrEmpty()) {
                throw IOException("only ws:// bridge URLs are supported: $url")
            }
            val target = Socket()
            target.connect(InetSocketAddress(uri.host, if (uri.port > 0) uri.port else 80), CONNECT_TIMEOUT_MS)
            target.tcpNoDelay = true
            socket = target
            val input = BufferedInputStream(target.getInputStream())
            output = target.getOutputStream()
            handshake(uri, input)
            // close() may have raced with the handshake: never hand out a link nobody owns.
            if (cancelled) throw IOException("closed during handshake")
            isOpen = true
            listener.onOpen(this)
            reason = readLoop(input)
        } catch (e: Exception) {
            reason = e.message ?: e.javaClass.simpleName
        } finally {
            isOpen = false
            runCatching { socket?.close() }
            if (closed.compareAndSet(false, true)) listener.onClosed(this, reason)
        }
    }

    /**
     * HTTP Upgrade, then the RFC 6455 accept check. A non-101 answer is reported verbatim: the
     * bridge answers 401 when its `wsToken` does not match (protocol §8.2), which is the one
     * failure worth surfacing unchanged.
     */
    private fun handshake(uri: URI, input: InputStream) {
        val key = Base64.getEncoder().encodeToString(ByteArray(16).also { random.nextBytes(it) })
        val path = buildString {
            append(uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/")
            uri.rawQuery?.let { append('?').append(it) }
        }
        val hostHeader = if (uri.port > 0 && uri.port != 80) "${uri.host}:${uri.port}" else uri.host
        val request = buildString {
            append("GET ").append(path).append(" HTTP/1.1\r\n")
            append("Host: ").append(hostHeader).append("\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: ").append(key).append("\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("\r\n")
        }
        val out = output ?: throw IOException("not connected")
        out.write(request.toByteArray(Charsets.US_ASCII))
        out.flush()
        val status = readHeaderLine(input) ?: throw IOException("no handshake response")
        if (!status.startsWith("HTTP/1.1 101") && !status.startsWith("HTTP/1.0 101")) {
            throw IOException("handshake refused: ${status.take(120)}")
        }
        var accept: String? = null
        var budget = 0
        while (true) {
            val line = readHeaderLine(input) ?: throw IOException("truncated handshake")
            budget += line.length + 2
            if (budget > MAX_HEADER_BYTES) throw IOException("handshake headers too large")
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0 && line.substring(0, colon).trim().equals("Sec-WebSocket-Accept", ignoreCase = true)) {
                accept = line.substring(colon + 1).trim()
            }
        }
        val expected = Base64.getEncoder().encodeToString(
            MessageDigest.getInstance("SHA-1").digest((key + ACCEPT_GUID).toByteArray(Charsets.US_ASCII)),
        )
        if (accept != expected) throw IOException("handshake accept mismatch")
    }

    private fun readHeaderLine(input: InputStream): String? {
        val line = StringBuilder()
        while (true) {
            val byte = input.read()
            if (byte < 0) return if (line.isEmpty()) null else line.toString()
            if (byte == '\n'.code) return line.toString().trimEnd('\r')
            if (line.length > MAX_HEADER_LINE) throw IOException("handshake line too long")
            line.append(byte.toChar())
        }
    }

    /** Reads frames until the peer closes, a protocol violation appears, or the socket fails. */
    private fun readLoop(input: InputStream): String {
        var fragmentOpcode = 0
        var fragment = ByteArrayOutputStream()
        while (true) {
            val first = input.read()
            if (first < 0) return "peer closed"
            val second = input.read()
            if (second < 0) return "peer closed"
            val fin = first and 0x80 != 0
            val opcode = first and 0x0F
            val masked = second and 0x80 != 0
            var length = (second and 0x7F).toLong()
            if (length == 126L) {
                length = ((readByte(input) shl 8) or readByte(input)).toLong()
            } else if (length == 127L) {
                length = 0
                repeat(8) { length = (length shl 8) or readByte(input).toLong() }
            }
            if (length < 0 || length > MAX_MESSAGE_BYTES) throw IOException("frame too large: $length")
            val mask = if (masked) readBytes(input, 4) else null
            val payload = readBytes(input, length.toInt())
            if (mask != null) {
                for (index in payload.indices) {
                    payload[index] = (payload[index].toInt() xor mask[index and 3].toInt()).toByte()
                }
            }
            when (opcode) {
                OPCODE_TEXT, OPCODE_BINARY -> {
                    if (fragmentOpcode != 0) return "protocol: nested data frame"
                    if (fin) {
                        deliver(opcode, payload)
                    } else {
                        fragmentOpcode = opcode
                        fragment = ByteArrayOutputStream(payload.size * 2)
                        fragment.write(payload)
                    }
                }
                OPCODE_CONTINUATION -> {
                    if (fragmentOpcode == 0) return "protocol: stray continuation"
                    fragment.write(payload)
                    if (fragment.size() > MAX_MESSAGE_BYTES) throw IOException("message too large")
                    if (fin) {
                        val data = fragment.toByteArray()
                        val completed = fragmentOpcode
                        fragmentOpcode = 0
                        fragment = ByteArrayOutputStream()
                        deliver(completed, data)
                    }
                }
                OPCODE_CLOSE -> {
                    runCatching { writeFrame(OPCODE_CLOSE, ByteArray(0)) }
                    return "closed by peer"
                }
                OPCODE_PING -> runCatching { writeFrame(OPCODE_PONG, payload) }
                OPCODE_PONG -> Unit
                else -> return "protocol: opcode $opcode"
            }
        }
    }

    private fun deliver(opcode: Int, payload: ByteArray) {
        if (opcode == OPCODE_TEXT) listener.onText(this, String(payload, Charsets.UTF_8))
        else listener.onBinary(this, payload)
    }

    private fun writeFrame(opcode: Int, payload: ByteArray) {
        synchronized(writeLock) {
            val out = output ?: throw IOException("not connected")
            // FIN is always set: this client sends one whole message per frame.
            out.write(0x80 or opcode)
            val mask = ByteArray(4).also { random.nextBytes(it) }
            when {
                payload.size < 126 -> out.write(0x80 or payload.size)
                payload.size <= 0xFFFF -> {
                    out.write(0x80 or 126)
                    out.write((payload.size ushr 8) and 0xFF)
                    out.write(payload.size and 0xFF)
                }
                else -> {
                    out.write(0x80 or 127)
                    for (shift in 7 downTo 0) out.write(((payload.size.toLong() ushr (8 * shift)) and 0xFF).toInt())
                }
            }
            out.write(mask)
            for (index in payload.indices) out.write(payload[index].toInt() xor mask[index and 3].toInt())
            out.flush()
        }
    }

    private fun readByte(input: InputStream): Int {
        val byte = input.read()
        if (byte < 0) throw IOException("unexpected end of stream")
        return byte
    }

    private fun readBytes(input: InputStream, count: Int): ByteArray {
        val bytes = ByteArray(count)
        var offset = 0
        while (offset < count) {
            val read = input.read(bytes, offset, count - offset)
            if (read < 0) throw IOException("unexpected end of stream")
            offset += read
        }
        return bytes
    }

    private companion object {
        const val OPCODE_CONTINUATION = 0x0
        const val OPCODE_TEXT = 0x1
        const val OPCODE_BINARY = 0x2
        const val OPCODE_CLOSE = 0x8
        const val OPCODE_PING = 0x9
        const val OPCODE_PONG = 0xA
        const val ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        const val CONNECT_TIMEOUT_MS = 5_000
        const val MAX_HEADER_BYTES = 16 * 1024
        const val MAX_HEADER_LINE = 8 * 1024
        const val MAX_MESSAGE_BYTES = 64 * 1024
    }
}
