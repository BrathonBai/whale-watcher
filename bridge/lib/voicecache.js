// 本地台词包：把"说过的句子"按编码格式存到磁盘，第二次开始完全不出外网。
//
// 为什么插在 speech 层而不是文本层：
//   TTS 的产物就是音频。按文本缓存音频，命中与否跟引擎无关（Breeze/edge/sapi 都能用），
//   也不需要在固件里加什么"I need line id 12"的协议——设备照旧只认 audioHead + 帧 + audioEnd。
//
// 现场意义：黑客松会场 2.4G 拥挤，云端 TTS 是最大不确定源。演示脚本跑过一遍后，
// 开场白、问候、吐槽这些固定句都在本地，断网也照样出声。
//
// 2026-11-03 升级（Opus 下发）：
//   · 缓存格式显式版本化：meta.v = 2；v1 的旧 PCM 缓存（无 v 字段）一律当未命中，
//     绝不混用——旧缓存是 24k PCM，新缓存可能是 Opus 包序列，混播会变噪声；
//   · 键包含 codec/bitrate/engine/voice/model/speed/guidance/rate/frameMs：
//     改语速、模型、引擎、码率、编码都不能播旧包（换声音是事故，不是优化）；
//   · opus 缓存的数据文件是 .opus，meta.sizes 记录每个包的长度（裸 Opus 包无长度前缀，
//     必须显式记边界），get() 时按 sizes 切片并校验 1..1275 B。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const MAX_FILES = 80 // 超过就按 mtime 删最旧的；一条 6 秒 PCM ≈ 288 KB，80 条约 23 MB
export const CACHE_VERSION = 2
const OPUS_MAX_PACKET = 1275

export function cacheDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return process.env.DSH_VOICEPACK_DIR || path.join(home, 'plugins-data', 'embodied-bridge', 'voicepack')
}

const normCodec = (v) => (v === 'opus' ? 'opus' : 'pcm')

/**
 * 键 = 文本 + 编码 + 影响声音的一切参数。
 * 换音色/模型/语速/引导/引擎/码率 → 不同键 → 不会复用旧音频（换声音是事故，不是优化）。
 * 第二个参数兼容旧签名 keyOf(text, voiceId)。
 */
export function keyOf(text, opts = {}) {
  const o = typeof opts === 'string' ? { voice: opts } : opts || {}
  const payload = {
    v: CACHE_VERSION,
    text: String(text ?? '').trim(),
    codec: normCodec(o.codec),
    bitrate: Math.round(Number(o.bitrate) || 0),
    engine: String(o.engine ?? ''),
    voice: String(o.voice ?? ''),
    model: String(o.model ?? ''),
    speed: String(o.speed ?? ''),
    guidance: String(o.guidance ?? ''),
    rate: Math.round(Number(o.rate) || 0),
    frameMs: Number(o.frameMs) || 0,
  }
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

function files(key, codec = 'pcm') {
  const dir = cacheDir()
  const ext = normCodec(codec) === 'opus' ? '.opus' : '.pcm'
  return { dir, data: path.join(dir, key + ext), meta: path.join(dir, key + '.json') }
}

/**
 * 命中返回：
 *   PCM  → {codec:'pcm', pcm:Buffer, rate, bits, ch, bytes, at}
 *   Opus → {codec:'opus', packets:Buffer[], sizes:number[], rate, frameMs, bitrate, bytes, at}
 * 没有/读坏/版本不对 → null（调用方按未命中处理，重新合成）。
 */
export function get(key) {
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(cacheDir(), key + '.json'), 'utf8'))
  } catch {
    return null
  }
  if (!meta || typeof meta !== 'object' || meta.v !== CACHE_VERSION) return null
  const codec = normCodec(meta.codec)
  const f = files(key, codec)
  try {
    const data = fs.readFileSync(f.data)
    if (!data.length || data.length !== meta.bytes) return null
    if (codec === 'opus') {
      const sizes = Array.isArray(meta.sizes) ? meta.sizes.map((n) => Number(n)) : []
      if (sizes.length !== meta.packets || sizes.length === 0) return null
      if (sizes.some((n) => !Number.isFinite(n) || n < 1 || n > OPUS_MAX_PACKET)) return null
      if (sizes.reduce((a, b) => a + b, 0) !== data.length) return null
      const packets = []
      let off = 0
      for (const n of sizes) {
        packets.push(data.subarray(off, off + n))
        off += n
      }
      return {
        codec: 'opus',
        packets,
        sizes,
        bytes: data.length,
        rate: Number(meta.rate) || 24000,
        frameMs: Number(meta.frameMs) || 20,
        bitrate: Number(meta.bitrate) || 0,
        at: meta.at || 0,
      }
    }
    return {
      codec: 'pcm',
      pcm: data,
      bytes: data.length,
      rate: Number(meta.rate) || 24000,
      bits: Number(meta.bits) || 16,
      ch: Number(meta.ch) || 1,
      at: meta.at || 0,
    }
  } catch {
    return null
  }
}

/**
 * 边收边写。commit() 才落盘——半截音频比没有音频更糟（会放出一句断掉的话）。
 * meta.v 是提交标记：先写数据、再写 meta；进程中途挂掉时旧 meta 不会指向半截数据。
 * 写失败一律静默返回 false：缓存是优化项，不该影响正在进行的播放。
 */
export function beginWrite(key, meta = {}) {
  const codec = normCodec(meta.codec)
  const f = files(key, codec)
  const chunks = []
  const packets = []
  let bytes = 0
  let done = false
  try {
    fs.mkdirSync(f.dir, { recursive: true })
  } catch {
    /* 目录建不出来就退化成不缓存 */
  }
  return {
    codec,
    /** PCM：逐块收集。 */
    push(buf) {
      if (done || codec !== 'pcm' || !buf?.length) return
      chunks.push(Buffer.from(buf)) // 复制：上层可能复用同一块内存
      bytes += buf.length
    },
    /** Opus：逐个裸包收集（一个包一个 Buffer，边界不能靠拼接恢复）。 */
    pushPacket(pkt) {
      if (done || codec !== 'opus' || !pkt?.length) return
      if (!Number.isFinite(pkt.length) || pkt.length < 1 || pkt.length > OPUS_MAX_PACKET) return
      packets.push(Buffer.from(pkt))
      bytes += pkt.length
    },
    commit(extra = {}) {
      if (done) return false
      const okSize = codec === 'pcm' ? chunks.length > 0 && bytes > 0 : packets.length > 0 && bytes > 0
      if (!okSize) {
        done = true
        return false
      }
      done = true
      try {
        const data = codec === 'pcm' ? Buffer.concat(chunks, bytes) : Buffer.concat(packets, bytes)
        const outMeta = {
          v: CACHE_VERSION,
          codec,
          bytes,
          at: Date.now(),
          ...meta,
          ...extra,
        }
        if (codec === 'opus') {
          outMeta.packets = packets.length
          outMeta.sizes = packets.map((p) => p.length)
        }
        fs.writeFileSync(f.data, data)
        fs.writeFileSync(f.meta, JSON.stringify(outMeta))
        prune()
        return true
      } catch {
        return false
      }
    },
    abort() {
      done = true
      chunks.length = 0
      packets.length = 0
      bytes = 0
    },
  }
}

const cacheExts = ['.pcm', '.opus']

/** 只保留最近的 MAX_FILES 条（按 meta 里的 at）。pcm/opus 两种数据文件都要清。 */
export function prune(max = MAX_FILES) {
  try {
    const dir = cacheDir()
    const metas = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        try {
          return { n, at: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).at || 0 }
        } catch {
          return { n, at: 0 }
        }
      })
      .sort((a, b) => b.at - a.at)
    for (const { n } of metas.slice(max)) {
      const base = n.replace(/\.json$/, '')
      for (const ext of cacheExts) fs.rmSync(path.join(dir, base + ext), { force: true })
      fs.rmSync(path.join(dir, n), { force: true })
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

export function stats() {
  try {
    const dir = cacheDir()
    const names = fs.readdirSync(dir).filter((n) => cacheExts.some((e) => n.endsWith(e)))
    let bytes = 0
    let opus = 0
    for (const n of names) {
      bytes += fs.statSync(path.join(dir, n)).size
      if (n.endsWith('.opus')) opus += 1
    }
    return { count: names.length, bytes, dir, opus, pcm: names.length - opus }
  } catch {
    return { count: 0, bytes: 0, dir: cacheDir(), opus: 0, pcm: 0 }
  }
}
