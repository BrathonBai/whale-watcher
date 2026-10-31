// 极简 RFC 6455 WebSocket 服务端实现（无第三方依赖）。
//
// 只覆盖本桥需要的子集：
//   - 服务端完成握手（Sec-WebSocket-Accept）
//   - 解析客户端帧（必须带 mask），支持分段（continuation）累积
//   - 发送文本帧（不掩码）、ping/pong、close
//
// 明确不支持：扩展（permessage-deflate）、二进制业务负载、服务端主动分段。
// 帧大小有硬上限，避免设备端异常把宿主内存吃掉。
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const MAX_FRAME_BYTES = 64 * 1024

export const OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

/** 计算握手应答值。 */
export function wsAccept(key) {
  return createHash('sha1').update(key + GUID, 'utf8').digest('base64')
}

/** 生成一个服务端帧（不掩码）。payload 为 Buffer。 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | (opcode & 0x0f) // FIN=1
  return Buffer.concat([header, payload])
}

/** 便捷：发送一个 JSON 文本帧。 */
export function encodeText(objOrString) {
  const s = typeof objOrString === 'string' ? objOrString : JSON.stringify(objOrString)
  return encodeFrame(OPCODE.TEXT, Buffer.from(s, 'utf8'))
}

export function encodeClose(code = 1000, reason = '') {
  const p = Buffer.alloc(2 + Buffer.byteLength(reason))
  p.writeUInt16BE(code, 0)
  p.write(reason, 2, 'utf8')
  return encodeFrame(OPCODE.CLOSE, p)
}

export function encodePong(payload) {
  return encodeFrame(OPCODE.PONG, payload ?? Buffer.alloc(0))
}

/**
 * 增量帧解析器。把 socket 上读到的字节丢进来，吐出完整的应用消息。
 *
 * 返回 { messages: [{opcode, payload}], closed: bool, error?: string }
 * - 只把 FIN=1 的完整消息放进 messages；分段消息会被累积。
 * - 控制帧（ping/pong/close）不参与分段累积。
 *
 * 两侧通用：
 *   new FrameParser()                         服务端解析客户端帧（要求 mask）
 *   new FrameParser({ requireMask: false })   客户端解析服务端帧（mask 可选）
 */
export class FrameParser {
  constructor(opts = {}) {
    if (typeof opts === 'number') opts = { maxFrameBytes: opts } // 旧签名兼容
    this.buf = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.max = opts.maxFrameBytes ?? MAX_FRAME_BYTES
    this.requireMask = opts.requireMask ?? true
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const messages = []
    let closed = false

    for (;;) {
      const need = this.#peekHeader()
      if (!need) break
      if (need.error) return { messages, closed, error: need.error }
      if (this.buf.length < need.total) break

      const frame = this.buf.subarray(0, need.total)
      this.buf = this.buf.subarray(need.total)

      let payload = frame.subarray(need.headerLen, need.total)
      if (need.masked) {
        const key = frame.subarray(need.headerLen - 4, need.headerLen)
        const out = Buffer.allocUnsafe(payload.length)
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3]
        payload = out
      }

      if (need.opcode === OPCODE.CLOSE) {
        closed = true
        messages.push({ opcode: need.opcode, payload })
        continue
      }
      if (need.opcode === OPCODE.PING || need.opcode === OPCODE.PONG) {
        messages.push({ opcode: need.opcode, payload })
        continue
      }
      if (need.opcode === OPCODE.CONT) {
        if (!this.fragmentOpcode) return { messages, closed, error: 'continuation without start' }
        this.fragments.push(payload)
      } else {
        if (this.fragmentOpcode) return { messages, closed, error: 'interleaved fragment' }
        this.fragments = [payload]
        this.fragmentOpcode = need.opcode
      }

      const buffered = this.fragments.reduce((n, b) => n + b.length, 0)
      if (buffered > this.max) return { messages, closed, error: 'message too large' }

      if (need.fin) {
        messages.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) })
        this.fragments = []
        this.fragmentOpcode = 0
      }
    }
    return { messages, closed }
  }

  #peekHeader() {
    if (this.buf.length < 2) return null
    const b0 = this.buf[0]
    const b1 = this.buf[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let off = 2

    if (len === 126) {
      if (this.buf.length < 4) return null
      len = this.buf.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (this.buf.length < 10) return null
      const big = this.buf.readBigUInt64BE(2)
      if (big > BigInt(this.max)) return { error: 'frame too large' }
      len = Number(big)
      off = 10
    }
    if (len > this.max) return { error: 'frame too large' }
    if (this.requireMask && !masked) return { error: 'client frame not masked' }

    const headerLen = off + (masked ? 4 : 0)
    return { fin, opcode, masked, headerLen, total: headerLen + len }
  }
}

/** 在 http server 的 'upgrade' 事件上完成握手，回调拿到一个已就绪的连接。 */
export function acceptUpgrade(req, socket, head, { path = '/device', onMessage, onBinary, onClose, onOpen } = {}) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== path) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return null
  }
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return null
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  )
  socket.setNoDelay(true)

  const parser = new FrameParser()
  let alive = true

  const conn = {
    socket,
    get alive() {
      return alive && !socket.destroyed
    },
    send(objOrString) {
      if (!conn.alive) return false
      try {
        socket.write(encodeText(objOrString))
        return true
      } catch {
        return false
      }
    },
    // 二进制帧：TTS 的 PCM 走这里（服务端帧不掩码，见 RFC 6455 §5.1）
    sendBinary(buf) {
      if (!conn.alive || !buf || buf.length === 0) return false
      try {
        socket.write(encodeFrame(OPCODE.BINARY, buf))
        return true
      } catch {
        return false
      }
    },
    close(code = 1000, reason = '') {
      if (!alive) return
      alive = false
      try {
        socket.write(encodeClose(code, reason))
      } catch {}
      socket.end()
    },
    destroy() {
      alive = false
      socket.destroy()
    },
  }

  const ingest = (chunk) => {
    const { messages, closed, error } = parser.push(chunk)
    if (error) {
      conn.close(1002, error)
      return
    }
    for (const m of messages) {
      if (m.opcode === OPCODE.TEXT || m.opcode === OPCODE.BINARY) {
        // 文本帧 = 控制消息；二进制帧 = 设备上传的语音 PCM（不是错误）。
        if (m.opcode === OPCODE.TEXT) onMessage?.(m.payload.toString('utf8'), conn)
        else if (onBinary) onBinary(m.payload, conn)
        else conn.close(1003, 'binary unsupported')
      } else if (m.opcode === OPCODE.PING) {
        try {
          socket.write(encodePong(m.payload))
        } catch {}
      } else if (m.opcode === OPCODE.CLOSE) {
        conn.close(1000, '')
      }
    }
    if (closed) conn.destroy()
  }

  socket.on('data', ingest)
  socket.on('error', () => {
    alive = false
  })
  socket.on('close', () => {
    alive = false
    onClose?.(conn)
  })

  if (head && head.length) ingest(head)
  onOpen?.(conn)
  return conn
}
