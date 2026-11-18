// opus_encode.js —— PCM(24k mono) → Ogg Opus → 裸 Opus 包序列。
//
// 为什么走 Ogg 容器再拆包（方案 A）：
//   ffmpeg 自带 libopus，但它的输出要么是 Ogg、要么是 RTP。RTP 要自己开本地 UDP 收包、
//   还要按 SSRC/seq 排序（方案 B，兜底）；Ogg 是一段顺序字节流，用 100 行解析器就能拆出
//   "一个 20 ms 帧 = 一个 Opus 包"，且能直接喂 pipe:1。所以默认 A，B 只作兜底（本轮没实现，
//   发现 A 不可用时显式回退 PCM 而不是换方案）。
//
// 拆包要点（Ogg 规范 + 固件侧消费方式）：
//   · 一个 Ogg page = "OggS" + 27 字节头 + segment table + payload；
//     segment table 每字节是该 segment 的长度（lacing value），0..255；
//   · 一个包可以跨多个 segment；lacing=255 表示"未结束，继续读下一段"；
//   · 一个包还可以跨 page：本页最后一段仍是 255 → 下一 page 的 header_type 必须带 0x01
//     (continued)。解析器必须把两页的片段拼成一个包，否则每个 20 ms 帧都会错位；
//   · 头两个包是 OpusHead / OpusTags（codec 参数与元数据），下行不需要 → 跳过；
//   · Opus 单包 1..1275 字节（RFC 6716），超出即数据损坏 → 显式报错，不静默丢。
//
// 这个文件只做"编码 + 拆包"，不做节流/网络。失败一律返回 {ok:false, code, message}：
//   OPUS_UNAVAILABLE / OPUS_SPAWN_FAILED / OPUS_FFMPEG_FAILED / OPUS_TIMEOUT /
//   OPUS_PARSE / OPUS_EMPTY
// 调用方（speech.js）必须把失败写进 /api/state.audio 并**显式回退 PCM**——不许静默换编码。
import fs from 'node:fs'
import { spawn } from 'node:child_process'

/** 设备解码输出率（audio 头的 rate 字段，与 PCM 一致）。 */
export const OPUS_DECODE_RATE = 24000
/** 编码用采样率：ffmpeg 显式 -ar 16000，让 libopus 按 16 kHz 带宽编码。 */
export const OPUS_ENCODE_RATE = 16000
/** 每帧时长（ms）：契约固定 20 ms/包。 */
export const OPUS_FRAME_MS = 20
/** 裸 Opus 包长度上下限（RFC 6716：1..1275）。 */
export const OPUS_MAX_PACKET_BYTES = 1275
export const OPUS_MIN_PACKET_BYTES = 1
/** libopus 允许的码率范围（bps），低于 6k 会直接建不起编码器。 */
export const OPUS_BITRATE_MIN = 6000
export const OPUS_BITRATE_MAX = 510000
/** 配置缺省码率（bps）。自适应关掉时也用它。 */
export const OPUS_DEFAULT_BITRATE = 16000

const OGG_HEADER_BYTES = 27
const OGG_MAGIC = 'OggS'
const OGG_FLAG_CONTINUED = 0x01
const OGG_FLAG_BOS = 0x02
const OGG_FLAG_EOS = 0x04
/** 解析器自我保护：等待中的半页超过这个大小就判定不是 Ogg 流（避免无限涨内存）。 */
const OGG_MAX_PENDING_BYTES = 1024 * 1024
/** 头两个包（OpusHead/OpusTags）允许比音频包大，但也要有上限。 */
const OGG_MAX_HEADER_PACKET_BYTES = 64 * 1024

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })

/** 码率合法化：越界就夹到编码器能接受的范围，并告诉调用方实际用了多少。 */
export function clampOpusBitrate(v, fallback = OPUS_DEFAULT_BITRATE) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(OPUS_BITRATE_MAX, Math.max(OPUS_BITRATE_MIN, n))
}

/** 帧长合法化：Opus 只支持 2.5/5/10/20/40/60 ms；契约用 20，其它值落回 20。 */
export function clampOpusFrameMs(v, fallback = OPUS_FRAME_MS) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return [2.5, 5, 10, 20, 40, 60].includes(n) ? n : fallback
}

/**
 * ffmpeg 是否"看起来可用"。
 *
 * 只做不 spawn 的判断（沙箱里 spawn 可能 EPERM，且热路径不该每次 fork 一个进程）：
 *   · 绝对/带路径 → fs 存在性检查，不存在立刻判不可用（能报出具体路径）；
 *   · 裸命令名 → 交给 spawn，由 ENOENT 转成 OPUS_UNAVAILABLE（不假装可用）。
 */
export function ffmpegLooksUsable(ffmpegPath) {
  const p = String(ffmpegPath ?? '').trim() || 'ffmpeg'
  if (p.includes('/') || p.includes('\\')) {
    try {
      fs.accessSync(p, fs.constants.F_OK)
      return true
    } catch {
      return false
    }
  }
  return true
}

/** 给日志/diag 用的可读描述（不回显密钥；这里没有密钥）。 */
export function ffmpegLabel(ffmpegPath) {
  return String(ffmpegPath ?? '').trim() || 'ffmpeg'
}

/**
 * Ogg Opus 增量解析器。
 *
 * 用法：
 *   const p = new OggOpusParser()
 *   for (const chunk of stdoutChunks) p.push(chunk)  // 返回本次新拆出的 Opus 包数组
 *   const tail = p.finish()                          // 检查尾部是否有半页/半包
 *
 * 说明：不校验 CRC32（下行链路里 ffmpeg 刚生成、没有落盘/搬运），但结构错误一律显式：
 * 坏 magic、坏版本、跨页 flag 不一致、包超长、尾部残缺 → parser.error，绝不静默丢包。
 */
export class OggOpusParser {
  constructor() {
    this.buf = Buffer.alloc(0) // 还没凑够一整页的字节
    this.segments = [] // 当前未完成包已收到的片段
    this.pendingBytes = 0 // 当前未完成包累计字节（只用于上限判断）
    this.headerCount = 0 // 已跳过的头包数（OpusHead/OpusTags）
    this.headers = [] // 头包原文（诊断用，AudioEnd 不需要）
    this.pages = 0
    this.continuedPages = 0
    this.packetCount = 0
    this.audioBytes = 0
    this.warnings = []
    this.error = null
  }

  /** 喂一段 Ogg 字节流，返回新拆出的**音频**包（Buffer 数组）。 */
  push(chunk) {
    if (this.error) return []
    if (!chunk || chunk.length === 0) return []

    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])

    const out = []
    for (;;) {
      // 1) 切一整页出来
      if (this.buf.length < OGG_HEADER_BYTES) break
      if (this.buf.toString('latin1', 0, 4) !== OGG_MAGIC) {
        this.error = `不是 Ogg 流：偏移 0 处 magic=${JSON.stringify(this.buf.toString('latin1', 0, 4))}`
        break
      }
      const version = this.buf[4]
      if (version !== 0) {
        this.error = `Ogg 版本 ${version} 不支持（只认 0）`
        break
      }
      const flags = this.buf[5]
      const segCount = this.buf[OGG_HEADER_BYTES - 1]
      const headerLen = OGG_HEADER_BYTES + segCount
      if (this.buf.length < headerLen) break
      let payloadLen = 0
      for (let i = 0; i < segCount; i++) payloadLen += this.buf[OGG_HEADER_BYTES + i]
      if (this.buf.length < headerLen + payloadLen) break

      const segments = this.buf.subarray(OGG_HEADER_BYTES, headerLen)
      const payload = this.buf.subarray(headerLen, headerLen + payloadLen)
      this.buf = this.buf.subarray(headerLen + payloadLen)
      this.pages += 1

      // 2) 跨页 flag 一致性：continued 位必须和"有未完成包"对齐
      const continued = (flags & OGG_FLAG_CONTINUED) !== 0
      if (continued) this.continuedPages += 1
      if (continued && this.segments.length === 0) {
        this.error = `第 ${this.pages} 页带 continued 标志，但没有上一页的半包（流被截断？）`
        break
      }
      if (!continued && this.segments.length > 0) {
        this.error = `第 ${this.pages} 页没有 continued 标志，但上一页留了半包（流损坏）`
        break
      }
      if ((flags & OGG_FLAG_BOS) !== 0 && this.pages !== 1) {
        this.warnings.push(`第 ${this.pages} 页再次出现 BOS（串流拼接？按单流继续解析）`)
      }

      // 3) 按 lacing value 切包
      let off = 0
      for (let i = 0; i < segCount; i++) {
        const lace = segments[i]
        if (lace > 0) {
          this.segments.push(payload.subarray(off, off + lace))
          this.pendingBytes += lace
        }
        off += lace
        if (lace < 255) {
          const packet = this.segments.length === 1 ? Buffer.from(this.segments[0]) : Buffer.concat(this.segments)
          this.segments = []
          this.pendingBytes = 0
          this._onPacket(packet, out)
          if (this.error) return out
        }
      }
      // 注意：段长为 255 的包会留到下一页（continued），这是合法且必须支持的情况。
      if ((flags & OGG_FLAG_EOS) !== 0 && this.segments.length > 0) {
        this.error = 'Ogg EOS 页结束时还有半包（流被截断）'
        break
      }
    }

    if (!this.error && this.buf.length > OGG_MAX_PENDING_BYTES) {
      this.error = `等待中的 Ogg 页超过 ${OGG_MAX_PENDING_BYTES} B 仍未凑齐（不是 Ogg 流？）`
    }
    return out
  }

  _onPacket(packet, out) {
    // 头两个包：OpusHead / OpusTags。顺序与 magic 都对才跳过，否则是流损坏。
    if (this.headerCount < 2) {
      if (packet.length > OGG_MAX_HEADER_PACKET_BYTES) {
        this.error = `Ogg 头包过大（${packet.length} B）`
        return
      }
      const magic = packet.toString('latin1', 0, 8)
      if (this.headerCount === 0) {
        if (magic !== 'OpusHead') {
          this.error = `第一个 Ogg 包不是 OpusHead（magic=${JSON.stringify(magic)}）`
          return
        }
        this.headerCount = 1
        this.headers.push(packet)
        return
      }
      if (magic === 'OpusTags') {
        this.headerCount = 2
        this.headers.push(packet)
        return
      }
      // 没有 OpusTags 的流罕见：显式记一条警告，然后把它当音频包处理（不静默丢弃）。
      this.warnings.push('第二个 Ogg 包不是 OpusTags，按音频包处理')
      this.headerCount = 2
    }

    if (packet.length < OPUS_MIN_PACKET_BYTES || packet.length > OPUS_MAX_PACKET_BYTES) {
      this.error = `Opus 包长度 ${packet.length} 越界（合法 ${OPUS_MIN_PACKET_BYTES}..${OPUS_MAX_PACKET_BYTES} B）`
      return
    }
    this.packetCount += 1
    this.audioBytes += packet.length
    out.push(packet)
  }

  /** 流结束：检查是否还有半页/半包（正常 ffmpeg 输出应当干净）。 */
  finish() {
    const leftover = this.buf.length
    const halfPacket = this.segments.length > 0
    this.buf = Buffer.alloc(0)
    this.segments = []
    this.pendingBytes = 0
    if (!this.error && (leftover > 0 || halfPacket)) {
      this.error = `Ogg 流尾部残缺（半页 ${leftover} B${halfPacket ? ' + 半包' : ''}）`
    }
    return {
      ok: !this.error,
      error: this.error,
      leftoverBytes: leftover,
      halfPacket,
      pages: this.pages,
      packets: this.packetCount,
      headers: this.headers.length,
      continuedPages: this.continuedPages,
      warnings: this.warnings,
    }
  }
}

/** 一次性解析整段 Ogg（测试/离线场景用；流式请用 OggOpusParser）。 */
export function parseOggOpus(buf) {
  const parser = new OggOpusParser()
  const packets = parser.push(buf)
  const tail = parser.finish()
  return { ...tail, packets, bytes: parser.audioBytes }
}

/** 构造 ffmpeg 参数（单独导出，测试可以直接断言参数，不用真 spawn）。 */
export function buildFfmpegArgs({ bitrate = OPUS_DEFAULT_BITRATE, frameMs = OPUS_FRAME_MS, inputRate = OPUS_DECODE_RATE } = {}) {
  const bps = clampOpusBitrate(bitrate)
  const fm = clampOpusFrameMs(frameMs)
  const ir = Math.max(8000, Math.round(Number(inputRate) || OPUS_DECODE_RATE))
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    // 输入：裸 PCM（s16le / 单声道 / 24 kHz，来自 TTS）
    '-f', 's16le',
    '-ar', String(ir),
    '-ac', '1',
    '-i', 'pipe:0',
    // 输出：Ogg 容器 + libopus，20 ms/帧；-ar 16000 显式让编码按 16 kHz 带宽
    '-c:a', 'libopus',
    '-b:a', String(bps),
    '-application', 'voip',
    '-frame_duration', String(fm),
    '-ar', String(OPUS_ENCODE_RATE),
    '-f', 'ogg',
    'pipe:1',
  ]
}

/** 从 spawn 出来的子进程收集 stdout/stderr 并等待退出（含超时杀进程）。 */
function collectFfmpeg(child, pcm, timeoutMs) {
  return new Promise((resolve) => {
    const stdout = []
    let stderr = ''
    let settled = false
    let timer = null

    const done = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      done(fail('OPUS_TIMEOUT', `ffmpeg 编码超时（>${timeoutMs} ms）`, { stderrTail: stderr.slice(-400) }))
    }, Math.max(1000, Number(timeoutMs) || 20000))
    timer.unref?.()

    child.on('error', (e) => {
      const code = e?.code === 'ENOENT' ? 'OPUS_UNAVAILABLE' : 'OPUS_SPAWN_FAILED'
      done(fail(code, `opus encode unavailable: 启动 ffmpeg 失败（${e?.code ?? ''} ${e?.message ?? e}）`))
    })
    child.stdout?.on('data', (d) => stdout.push(Buffer.from(d)))
    child.stderr?.on('data', (d) => {
      if (stderr.length < 8192) stderr += d.toString('utf8')
    })
    child.on('close', (code, signal) => {
      if (code !== 0) {
        done(
          fail('OPUS_FFMPEG_FAILED', `ffmpeg 退出码 ${code}${signal ? `（${signal}）` : ''}`, {
            stderrTail: stderr.slice(-800),
          }),
        )
        return
      }
      done({ ok: true, ogg: Buffer.concat(stdout), stderrTail: stderr.slice(-800) })
    })

    // stdin 写入错误（EPIPE 等）不能变成未捕获异常：ffmpeg 可能先退出。
    try {
      child.stdin?.on?.('error', () => {})
      child.stdin?.end?.(pcm)
    } catch (e) {
      done(fail('OPUS_SPAWN_FAILED', `写 ffmpeg stdin 失败：${e?.message ?? e}`))
    }
  })
}

/**
 * PCM → Opus 包序列。
 *
 * @param {object} o
 * @param {Buffer} o.pcm             裸 PCM（s16le；TTS 默认 24k mono）
 * @param {number} [o.inputRate]     PCM 采样率（默认 24000）
 * @param {number} [o.bitrate]       目标码率 bps（默认 16000）
 * @param {number} [o.frameMs]       帧长 ms（默认 20，契约固定）
 * @param {string} [o.ffmpegPath]    ffmpeg 路径（配置 ttsFfmpeg）
 * @param {number} [o.timeoutMs]     编码超时（默认 20 s）
 * @param {Function} [o.spawnImpl]   测试注入点（默认 child_process.spawn；测试禁止真 spawn）
 * @returns {Promise<{ok:true,packets:Buffer[],packetCount:number,bytes:number,durationMs:number,encodeMs:number,bitrate:number,frameMs:number,expectedPackets:number,warnings:string[],stderrTail:string}
 *                  |{ok:false,code:string,message:string}>}
 */
export async function encodePcmToOggOpus({
  pcm,
  inputRate = OPUS_DECODE_RATE,
  bitrate = OPUS_DEFAULT_BITRATE,
  frameMs = OPUS_FRAME_MS,
  ffmpegPath = 'ffmpeg',
  timeoutMs = 20000,
  spawnImpl = spawn,
} = {}) {
  const t0 = Date.now()
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    return fail('OPUS_EMPTY', 'PCM 为空，没什么可编码的')
  }
  if (pcm.length % 2 !== 0) {
    return fail('OPUS_PARSE', `PCM 字节数 ${pcm.length} 是奇数（s16le 必须是偶数）`)
  }
  const rate = Math.max(8000, Math.round(Number(inputRate) || OPUS_DECODE_RATE))
  const bps = clampOpusBitrate(bitrate)
  const fm = clampOpusFrameMs(frameMs)
  const durationMs = (pcm.length / 2 / rate) * 1000
  const expectedPackets = Math.max(1, Math.round(durationMs / fm))

  const bin = String(ffmpegPath ?? '').trim() || 'ffmpeg'
  if (!ffmpegLooksUsable(bin)) {
    return fail('OPUS_UNAVAILABLE', `opus encode unavailable: 找不到 ffmpeg（配置 ttsFfmpeg=${bin}）`)
  }

  let child
  try {
    child = spawnImpl(bin, buildFfmpegArgs({ bitrate: bps, frameMs: fm, inputRate: rate }), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (e) {
    return fail('OPUS_SPAWN_FAILED', `opus encode unavailable: 启动 ffmpeg 失败（${e?.message ?? e}）`)
  }
  if (!child) {
    return fail('OPUS_SPAWN_FAILED', 'opus encode unavailable: spawn ffmpeg 返回空句柄')
  }

  const run = await collectFfmpeg(child, pcm, timeoutMs)
  if (!run.ok) return { ...run, encodeMs: Date.now() - t0 }

  const parser = new OggOpusParser()
  const packets = parser.push(run.ogg)
  const tail = parser.finish()
  if (!tail.ok) {
    return fail('OPUS_PARSE', `Ogg 解析失败：${tail.error}`, {
      encodeMs: Date.now() - t0,
      stderrTail: run.stderrTail,
      packets: packets.length,
    })
  }
  if (packets.length === 0) {
    return fail('OPUS_EMPTY', 'ffmpeg 没产出任何 Opus 包（PCM 太短或编码器异常）', {
      encodeMs: Date.now() - t0,
      stderrTail: run.stderrTail,
    })
  }

  const warnings = [...tail.warnings]
  // 包数对不上不判失败（编码器会在首尾补 padding），但要显式记录下来给 diag/日志。
  if (Math.abs(packets.length - expectedPackets) > 2) {
    warnings.push(`包数 ${packets.length} 与预期 ${expectedPackets} 相差 >2（时长 ${Math.round(durationMs)} ms）`)
  }

  return {
    ok: true,
    packets,
    packetCount: packets.length,
    bytes: parser.audioBytes,
    durationMs,
    encodeMs: Date.now() - t0,
    bitrate: bps,
    frameMs: fm,
    inputRate: rate,
    expectedPackets,
    pages: tail.pages,
    continuedPages: tail.continuedPages,
    warnings,
    stderrTail: run.stderrTail,
  }
}
