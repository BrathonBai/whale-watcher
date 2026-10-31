// device.js —— 一条 WebSocket、一个事件环、一个显式采集状态机。
//
// v0.2 的问题（这次要修掉的三件）：
//   1. 图片/语音的累积器是裸变量，收到二进制帧时靠 `if (imageAcc) … else if (voiceAcc)`
//      猜当前在收什么；没有头就静默丢弃（谁也看不出丢了多少）。
//   2. 没有超时：设备传一半断线，累积器一直挂着，下一次二进制会续到旧缓冲上。
//   3. 下行不设防：`push()` 什么都发，包括 v2 根本不认识的 record/mic。
//
// 现在的规则：
//   · 采集 = 显式状态（idle | image | voice），带 startedAt/deadline；
//   · 二进制帧只喂给当前采集器；没有采集器 → 记 orphanBytes 并告警（不静默）；
//   · 超过声明长度 → 记 overflowBytes，多出来的丢掉；
//   · 下行必须命中 contract.DOWNLINK，否则 counters.rejected++ 并告警（不发出）。
//
// 单设备模型不变：新连接顶掉旧连接（设备硬复位后不会卡在僵尸 socket 上）。
import { acceptUpgrade } from './ws.js'
import { DOWNLINK, TOOLS, UNSUPPORTED, UPLINK } from './contract.js'
import { audioEnd, audioHead, face, ping, say, shot, welcome } from './protocol.js'

const COLLECTOR_TIMEOUT_MS = 30000
const SWEEP_MS = 2000

export function createDevice({ cfg, log, onMessage, onVoice, onImage, onOpen, onClose }) {
  let conn = null
  let connectedAt = 0
  let lastEvent = null
  let lastSpoken = ''
  let hello = null
  let collector = null // { kind, seq, bytes, got, buf, startedAt, meta }
  let seq = 0
  let warnedOrphan = false

  const ringCap = Math.max(20, Number(cfg.get().eventRing) || 200)
  const ring = []
  const counters = { up: 0, down: 0, rejected: 0, orphanBytes: 0, overflowBytes: 0, collectorTimeouts: 0 }

  const record0 = (kind, msg) => {
    ring.push({ seq: ++seq, at: Date.now(), kind, msg })
    while (ring.length > ringCap) ring.shift()
  }

  // ---------------- 采集状态机 ----------------
  function abortCollector(why) {
    if (!collector) return
    const c = collector
    collector = null
    if (why === 'timeout') ++counters.collectorTimeouts
    log.warn(`采集中断（${c.kind} seq=${c.seq} ${c.got}/${c.bytes} B）：${why}`)
  }

  function beginCollector(kind, meta) {
    if (collector) abortCollector('被新的 ' + kind + ' 顶掉（上一段没传完）')
    collector = {
      kind,
      seq: meta.seq ?? 0,
      bytes: meta.bytes,
      got: 0,
      buf: Buffer.alloc(meta.bytes),
      startedAt: Date.now(),
      meta,
    }
  }

  function feed(buf) {
    if (!collector) {
      counters.orphanBytes += buf.length
      if (!warnedOrphan) {
        warnedOrphan = true
        log.warn(`收到无头的二进制帧 ${buf.length} B（没有 image/voice 头）——已丢弃，后续同类不再刷屏`)
      }
      return
    }
    if (Date.now() - collector.startedAt > COLLECTOR_TIMEOUT_MS) {
      abortCollector('timeout（超过 30 s 没传完）')
      return
    }
    const room = collector.bytes - collector.got
    const take = Math.min(buf.length, room)
    buf.copy(collector.buf, collector.got, 0, take)
    collector.got += take
    if (buf.length > room) {
      counters.overflowBytes += buf.length - room
      log.warn(`采集溢出（${collector.kind}）：多收 ${buf.length - room} B，已丢弃`)
    }
    if (collector.got >= collector.bytes) {
      const done = collector
      collector = null
      const acc = { ...done.meta, got: done.got, buf: done.buf, ms: Date.now() - done.startedAt }
      if (done.kind === 'image') {
        log.info(`图片接收完成 ${acc.bytes} B ${acc.w}x${acc.h}（${acc.ms} ms）`)
        onImage?.(acc)
      } else {
        log.info(`语音接收完成 ${acc.bytes} B @${acc.rate}Hz（${acc.ms} ms）`)
        onVoice?.(acc)
      }
    }
  }

  const sweep = setInterval(() => {
    if (collector && Date.now() - collector.startedAt > COLLECTOR_TIMEOUT_MS) {
      abortCollector('timeout（sweep）')
    }
  }, SWEEP_MS)
  sweep.unref?.()

  // ---------------- 下行（带契约闸门） ----------------
  function send(obj) {
    const t = obj?.t
    if (!DOWNLINK.includes(t)) {
      ++counters.rejected
      log.warn(`拒绝下发 "${t}"：v2 契约里没有这条（只有 ${DOWNLINK.join('/')}）`)
      return false
    }
    if (!conn?.alive) return false
    const ok = conn.send(obj)
    if (ok) ++counters.down
    return ok
  }

  const device = {
    get online() {
      return Boolean(conn?.alive)
    },
    get connectedMs() {
      return conn?.alive ? Date.now() - connectedAt : 0
    },
    get lastEvent() {
      return lastEvent
    },
    get counters() {
      return { ...counters, seq }
    },
    get lastSpoken() {
      return lastSpoken
    },
    /** 设备自报身份（hello 里来的）；没握手前是契约里的预期值。 */
    get version() {
      return hello ?? { fw: '', board: '', ver: '', cam: 0, w: 0, h: 0 }
    },
    get capabilities() {
      return {
        uplink: [...UPLINK],
        downlink: [...DOWNLINK],
        unsupported: { ...UNSUPPORTED },
        tools: [...TOOLS],
      }
    },
    /** 当前是否正在收图片/语音（面板与 /health 用）。 */
    get collecting() {
      return collector ? { kind: collector.kind, seq: collector.seq, got: collector.got, bytes: collector.bytes } : null
    },
    setLastSpoken(t) {
      lastSpoken = String(t ?? '')
    },
    since(after = 0, limit = 30) {
      const a = Number(after) || 0
      const n = Math.min(200, Math.max(1, Number(limit) || 30))
      return ring.filter((e) => e.seq > a).slice(-n)
    },
    events() {
      return ring.slice()
    },

    // ---- 下行助手：全部走 send() 的契约闸门 ----
    push: send,
    sendBinary(buf) {
      if (!conn?.alive || typeof conn.sendBinary !== 'function') return false
      return conn.sendBinary(buf)
    },
    say(text, mood) {
      const msg = say(text, mood)
      const sent = send(msg)
      if (sent) lastSpoken = msg.text
      return { sent, mood: msg.mood, text: msg.text }
    },
    face(mood) {
      return send(face(mood))
    },
    shot() {
      return send(shot())
    },
    ping() {
      return send(ping())
    },
    welcome() {
      return send(welcome())
    },
    audioHead(info) {
      return send(audioHead(info))
    },
    audioEnd(s) {
      return send(audioEnd(s))
    },
    close(code = 1000, reason = 'byebye') {
      try {
        conn?.close(code, reason)
      } catch {}
      conn = null
      abortCollector('连接关闭')
    },

    // ---------------- 上行 ----------------
    handleUpgrade(req, socket, head) {
      if (conn?.alive) {
        try {
          conn.close(4000, 'replaced')
        } catch {}
        conn = null
        log.warn('已有连接，被新连接顶掉（设备可能刚重启）')
      }
      const c = acceptUpgrade(req, socket, head, {
        path: cfg.get().path,
        onMessage: (raw) => {
          ++counters.up
          onMessage(raw)
        },
        onBinary: feed,
        onOpen: () => {
          connectedAt = Date.now()
          log.info('设备 WebSocket 已连接')
          onOpen?.()
        },
        onClose: () => {
          if (conn === c) {
            conn = null
            abortCollector('连接断开')
            log.info('设备断开')
            onClose?.()
          }
        },
      })
      if (c) conn = c
      return c
    },

    /** 上行分发：进环、进日志，再交给业务层。 */
    ingest(msg) {
      lastEvent = { at: Date.now(), msg }
      if (msg.t === 'hello') hello = { fw: msg.fw, board: msg.board, ver: msg.ver, cam: msg.cam, w: msg.w, h: msg.h }
      record0(msg.t, msg)

      if (msg.t === 'image') {
        beginCollector('image', { seq: msg.seq, bytes: msg.bytes, w: msg.w, h: msg.h })
        log.info(`图片上行 seq=${msg.seq} ${msg.bytes} B ${msg.w}x${msg.h}`)
        return
      }
      if (msg.t === 'voice') {
        beginCollector('voice', { seq: msg.seq, bytes: msg.bytes, rate: msg.rate })
        log.info(`语音上行 seq=${msg.seq} ${msg.bytes} B @${msg.rate}Hz`)
        return
      }
      if (msg.t === 'pong') return
      log.info(`← ${msg.t}`)
    },

    dispose() {
      clearInterval(sweep)
      abortCollector('插件停止')
      try {
        conn?.close(1001, 'dsh shutting down')
      } catch {}
      conn = null
    },
  }

  return device
}
