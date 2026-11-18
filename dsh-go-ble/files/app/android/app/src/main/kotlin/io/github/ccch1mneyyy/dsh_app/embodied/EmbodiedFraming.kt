package io.github.ccch1mneyyy.dsh_app.embodied

/**
 * BLE transport framing (protocol §4). One logical WebSocket message is carried by 1..255 BLE
 * packets, each a 7-byte header plus payload:
 *
 * ```
 * 0  magic 0xA5 | 1  type 0x01 text / 0x02 binary | 2  flags FIRST|LAST
 * 3  frag_index | 4  frag_total | 5..6  payload_len (LE) | 7.. payload
 * ```
 *
 * Pure Kotlin on purpose: the wire format is reviewable without Android, and the reassembler is
 * the part most likely to be wrong. No message content is interpreted here.
 */
object EmbodiedFraming {
    const val MAGIC = 0xA5
    const val TYPE_TEXT = 0x01
    const val TYPE_BINARY = 0x02
    const val CONTROL_TYPE_MIN = 0x10
    const val CONTROL_TYPE_MAX = 0x1F
    const val HEADER_BYTES = 7
    const val MAX_TEXT_BYTES = 4096
    const val MAX_BINARY_BYTES = 16384
    const val MAX_FRAGMENTS = 255
    const val FLAG_FIRST = 0x01
    const val FLAG_LAST = 0x02

    /** Message cap for [type]; -1 for types this gateway does not carry. */
    fun maxMessageBytes(type: Int): Int = when (type) {
        TYPE_TEXT -> MAX_TEXT_BYTES
        TYPE_BINARY -> MAX_BINARY_BYTES
        else -> -1
    }

    /**
     * Splits [payload] into packets of at most [maxPayload] bytes, the negotiated `MTU - 3 - 7`.
     * Null when the message cannot be carried: unknown type, over the type's cap, or more than
     * [MAX_FRAGMENTS] fragments (frag_total is one byte; a 16 KiB binary message needs MTU ≥ 72).
     */
    fun encode(type: Int, payload: ByteArray, maxPayload: Int): List<ByteArray>? {
        val limit = maxMessageBytes(type)
        if (limit < 0 || payload.size > limit || maxPayload < 1 || maxPayload > 0xFFFF) return null
        val total = if (payload.isEmpty()) 1 else (payload.size + maxPayload - 1) / maxPayload
        if (total > MAX_FRAGMENTS) return null
        val frames = ArrayList<ByteArray>(total)
        var offset = 0
        for (index in 0 until total) {
            val size = minOf(maxPayload, payload.size - offset)
            val flags = (if (index == 0) FLAG_FIRST else 0) or (if (index == total - 1) FLAG_LAST else 0)
            val frame = ByteArray(HEADER_BYTES + size)
            frame[0] = MAGIC.toByte()
            frame[1] = type.toByte()
            frame[2] = flags.toByte()
            frame[3] = index.toByte()
            frame[4] = total.toByte()
            frame[5] = (size and 0xFF).toByte()
            frame[6] = ((size ushr 8) and 0xFF).toByte()
            if (size > 0) System.arraycopy(payload, offset, frame, HEADER_BYTES, size)
            offset += size
            frames += frame
        }
        return frames
    }
}

/**
 * Reassembles one direction of one connection. Fragments must arrive in exact order; anything
 * inconsistent drops the message being carried, without retransmission (protocol §4.1). Two
 * in-flight messages at most, one text and one binary.
 *
 * [drops] counts every message or packet rejected; the gateway folds the delta into its rxDrop.
 * Time is caller-supplied (`SystemClock.elapsedRealtime` in the gateway) so this stays testable.
 */
class EmbodiedReassembler(private val timeoutMs: Long = TIMEOUT_MS) {

    sealed class Outcome {
        class Message(val type: Int, val payload: ByteArray) : Outcome()
        object Incomplete : Outcome()
        class Dropped(val reason: String) : Outcome()
    }

    var drops: Int = 0
        private set

    private val slots = arrayOfNulls<Slot>(2) // 0 = text, 1 = binary

    fun accept(packet: ByteArray, nowMs: Long): Outcome {
        expire(nowMs)
        if (packet.size < EmbodiedFraming.HEADER_BYTES) return drop("short-header")
        if ((packet[0].toInt() and 0xFF) != EmbodiedFraming.MAGIC) return drop("magic")
        val type = packet[1].toInt() and 0xFF
        val limit = EmbodiedFraming.maxMessageBytes(type)
        if (limit < 0) {
            return drop(if (type in EmbodiedFraming.CONTROL_TYPE_MIN..EmbodiedFraming.CONTROL_TYPE_MAX) "control-type" else "unknown-type")
        }
        val flags = packet[2].toInt() and 0xFF
        val index = packet[3].toInt() and 0xFF
        val total = packet[4].toInt() and 0xFF
        val declared = (packet[5].toInt() and 0xFF) or ((packet[6].toInt() and 0xFF) shl 8)
        if (total == 0) return drop("frag-total")
        if (declared != packet.size - EmbodiedFraming.HEADER_BYTES) return drop("length")
        if (declared > limit) return drop("fragment-oversize")
        val first = flags and EmbodiedFraming.FLAG_FIRST != 0
        val last = flags and EmbodiedFraming.FLAG_LAST != 0
        val slotIndex = if (type == EmbodiedFraming.TYPE_TEXT) 0 else 1
        var slot = slots[slotIndex]
        if (index == 0) {
            if (!first) return drop("no-first")
            // A new message replaces an unfinished one of the same type.
            if (slot != null) {
                slots[slotIndex] = null
                drops++
            }
            if (total == 1 && !last) return drop("single-flags")
            if (total == 1) return message(type, packet)
            if (last) return drop("last-too-early")
            slot = Slot(total, ByteArray(limit), declared, 1, nowMs)
            System.arraycopy(packet, EmbodiedFraming.HEADER_BYTES, slot.buffer, 0, declared)
            slots[slotIndex] = slot
            return Outcome.Incomplete
        }
        if (slot == null) return drop("continuation")
        if (first) {
            slots[slotIndex] = null
            return drop("first-not-first")
        }
        if (total != slot.total || index != slot.next) {
            slots[slotIndex] = null
            return drop("out-of-order")
        }
        if (slot.length + declared > limit) {
            slots[slotIndex] = null
            return drop("message-oversize")
        }
        System.arraycopy(packet, EmbodiedFraming.HEADER_BYTES, slot.buffer, slot.length, declared)
        slot.length += declared
        slot.next = index + 1
        if (last) {
            if (index != total - 1) {
                slots[slotIndex] = null
                return drop("last-early")
            }
            slots[slotIndex] = null
            return Outcome.Message(type, slot.buffer.copyOf(slot.length))
        }
        if (index == total - 1) {
            slots[slotIndex] = null
            return drop("missing-last")
        }
        return Outcome.Incomplete
    }

    /** Forgets in-flight messages (a link went down); counted drops stay cumulative. */
    fun reset() = slots.fill(null)

    /** Drops messages whose first fragment is older than [timeoutMs]. */
    private fun expire(nowMs: Long) {
        for (index in slots.indices) {
            val slot = slots[index] ?: continue
            if (nowMs - slot.startedAt > timeoutMs) {
                slots[index] = null
                drops++
            }
        }
    }

    private fun message(type: Int, packet: ByteArray): Outcome.Message =
        Outcome.Message(type, packet.copyOfRange(EmbodiedFraming.HEADER_BYTES, packet.size))

    private fun drop(reason: String): Outcome.Dropped {
        drops++
        return Outcome.Dropped(reason)
    }

    private class Slot(val total: Int, val buffer: ByteArray, var length: Int, var next: Int, val startedAt: Long)

    companion object {
        const val TIMEOUT_MS = 3_000L
    }
}
