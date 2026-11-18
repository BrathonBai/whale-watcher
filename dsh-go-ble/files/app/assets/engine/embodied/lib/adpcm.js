// adpcm.js —— IMA/DVI ADPCM 编解码（鲸鲸 BLE 链路用，2026-11-13）。
//
// 为什么是它：BLE 实际可用吞吐 20–60 KB/s，而 mic/播放都是 24 kHz/16 bit/mono
// （裸 PCM = 48 KB/s，传都传不完）。IMA ADPCM 固定 4:1 → 约 12 KB/s，编解码各只有
// 一张 89 项 step 表 + 16 项 index 表，C 端（firmware-v2/main/adpcm.cc）与这里逐样本一致。
//
// 块格式与 **ffmpeg 的 adpcm_ima_wav 完全同构**（这样能拿 ffmpeg 当独立参考解码器验证）：
//   block = 1024 字节 = 4 字节头 + 1020 字节 nibbles
//   头： [0..1] predictor int16 LE = **本块第一个 PCM 采样**（不是"上一块末状态"）
//        [2]    index  uint8       = 本块起点 step index
//        [3]    reserved = 0
//   nibbles：每个字节两个采样，**低半字节在前**（第 1 个采样在 bit0-3）
//   一个整块 = **2041 采样**（头部那个采样 + 1020×2）= 85.04 ms @24 kHz。
//   流末尾允许短块：4 B 头 + ceil((n-1)/2) B nibbles，n 为**奇数**采样数。
//   （n 为偶数时编码器会补 1 个采样变成奇数，解码端用 `samples` 字段裁掉；见下。）
//
// 关键设计：**块头自带 predictor/index** → BLE 丢一帧只影响这一块（85 ms），下一块立刻
// 自愈，不会像裸 nibble 流那样一丢就整段变噪。
//
// `samples` 字段（可选但推荐）：voice/audio 头里的 `samples` = 解码后应有的采样数。
// 末块补齐用的 1 个采样靠它裁掉，保证 24k 采样数与录音/合成时严格一致。

/** 标准 IMA ADPCM step 表（89 项）。 */
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
]

/** 标准 IMA index 调整表（16 项）。 */
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]

const HEADER_BYTES = 4
const BLOCK_ALIGN = 1024
const NIBBLES_PER_BLOCK = BLOCK_ALIGN - HEADER_BYTES // 1020 → 2040 nibble 采样
const SAMPLES_PER_BLOCK = NIBBLES_PER_BLOCK * 2 + 1 // 2041（含头里的第一个采样）

/** 线上参数（固件/桥/文档引用同一组常量）。 */
export const ADPCM = Object.freeze({
  rate: 24000,
  bits: 16,
  ch: 1,
  blockAlign: BLOCK_ALIGN,
  headerBytes: HEADER_BYTES,
  /** 一个整块的 PCM 采样数（含块头里的第一个采样）。 */
  samplesPerBlock: SAMPLES_PER_BLOCK,
  /** 10 s 语音上限约 120 KB；上限给到 20 s。 */
  maxVoiceBytes: 240000,
  /** 实测码率：1024 B / 2041 采样 × 24000 = 12041.6 B/s。 */
  bytesPerSecond: Math.round((BLOCK_ALIGN * 24000) / SAMPLES_PER_BLOCK),
})

const clip16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v)
const clipIndex = (i) => (i < 0 ? 0 : i > 88 ? 88 : i)

/** 解码一个 nibble：更新 state，返回新 predictor。 */
function expandNibble(state, nib) {
  const step = STEP_TABLE[state.index]
  let diffq = step >> 3
  if (nib & 4) diffq += step
  if (nib & 2) diffq += step >> 1
  if (nib & 1) diffq += step >> 2
  state.predictor = clip16(state.predictor + (nib & 8 ? -diffq : diffq))
  state.index = clipIndex(state.index + INDEX_TABLE[nib & 0xf])
  return state.predictor
}

/**
 * 编码一个块。
 * @param {Int16Array} samples 采样数组
 * @param {number} startSample 本块第一个采样下标
 * @param {number} count 本块采样数（1..2041）。**奇数**时 nibbles 数 = count-1；
 *   偶数时补 1 个采样（编码进 nibbles）变奇数，调用方用 covered 前进即可。
 * @param {{predictor:number,index:number}} state index 跨块延续；predictor 被本块首采样覆盖
 * @returns {{bytes:Buffer, covered:number, padded:boolean}}
 */
export function encodeBlock(samples, startSample, count, state) {
  const n = Math.max(1, Math.min(count | 0, SAMPLES_PER_BLOCK))
  const padded = n % 2 === 0
  const nibbleSamples = padded ? n : n - 1 // 头采样 + 偶数个 nibble 才自洽
  const out = Buffer.alloc(HEADER_BYTES + Math.ceil(nibbleSamples / 2))
  const first = samples[startSample] ?? 0
  state.predictor = clip16(first)
  out.writeInt16LE(state.predictor, 0)
  out.writeUInt8(state.index & 0xff, 2)
  out.writeUInt8(0, 3)
  let o = HEADER_BYTES
  for (let i = 0; i < nibbleSamples; i += 2) {
    let byte = compressSample(state, samples[startSample + 1 + i] ?? 0) & 0xf
    if (i + 1 < nibbleSamples) byte |= (compressSample(state, samples[startSample + 1 + i + 1] ?? 0) & 0xf) << 4
    out[o++] = byte
  }
  return { bytes: out, covered: n, padded }
}

/** 单个采样的 IMA 编码：就地更新 state，返回 4 bit code（与 ffmpeg adpcm_ima_compress_sample 同序）。 */
function compressSample(state, sample) {
  const step = STEP_TABLE[state.index]
  let diff = sample - state.predictor
  let nib = 0
  if (diff < 0) {
    nib = 8
    diff = -diff
  }
  if (diff >= step) {
    nib |= 4
    diff -= step
  }
  if (diff >= step >> 1) {
    nib |= 2
    diff -= step >> 1
  }
  if (diff >= step >> 2) nib |= 1
  // 与解码端同一张表推进状态：先按旧 index 的 step 更新 predictor，再调 index。
  expandNibble(state, nib)
  return nib
}

/**
 * PCM（s16le Buffer）→ 整段 ADPCM 块流。
 * @param {Buffer} pcm
 * @returns {{encoded:Buffer, samples:number, blocks:number}}
 */
export function encodePcm(pcm) {
  if (!Buffer.isBuffer(pcm)) throw new TypeError('encodePcm expects Buffer')
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  const state = { predictor: 0, index: 0 }
  const chunks = []
  let off = 0
  let blocks = 0
  while (off < samples.length) {
    const n = Math.min(SAMPLES_PER_BLOCK, samples.length - off)
    const blk = encodeBlock(samples, off, n, state)
    chunks.push(blk.bytes)
    off += blk.covered
    ++blocks
  }
  return { encoded: Buffer.concat(chunks), samples: samples.length, blocks }
}

/**
 * ADPCM 块流 → PCM（s16le Buffer）。
 * 约定：按 1024 字节步进；**剩余不足 1024 字节的块是末块（短块）**。
 * @param {Buffer} buf
 * @param {{samples?:number}} [opts] samples = 期望的 PCM 采样数（末块补齐采样会被裁掉）
 * @returns {{pcm:Buffer, samples:number, blocks:number, trailing:number}}
 */
export function decodeBlocks(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('decodeBlocks expects Buffer')
  const state = { predictor: 0, index: 0 }
  const chunks = []
  let off = 0
  let blocks = 0
  let total = 0
  while (buf.length - off >= HEADER_BYTES) {
    const remain = buf.length - off
    const full = remain >= BLOCK_ALIGN
    const blockBytes = full ? BLOCK_ALIGN : remain
    const nibbles = blockBytes - HEADER_BYTES
    const n = nibbles * 2 + 1
    const samples = new Int16Array(n)
    state.predictor = clip16(buf.readInt16LE(off))
    state.index = clipIndex(buf.readUInt8(off + 2))
    samples[0] = state.predictor
    let p = off + HEADER_BYTES
    let s = 1
    for (let i = 0; i < nibbles; i++) {
      const byte = buf[p++]
      samples[s++] = expandNibble(state, byte & 0xf)
      if (s < n) samples[s++] = expandNibble(state, (byte >> 4) & 0xf)
    }
    chunks.push(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    off += blockBytes
    total += n
    ++blocks
  }
  let pcm = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)
  const want = Number(opts.samples)
  let trimmed = 0
  if (Number.isFinite(want) && want >= 0 && want < total) {
    trimmed = total - want
    pcm = pcm.subarray(0, want * 2)
    total = want
  }
  return { pcm, samples: total, blocks, trailing: buf.length - off, trimmed }
}

/** PCM 字节数 → ADPCM 字节数（上限/日志用）。 */
export const encodedBytesFor = (pcmBytes) => Math.ceil((pcmBytes / 2 / SAMPLES_PER_BLOCK) * BLOCK_ALIGN) || 0

export const CONSTANTS = Object.freeze({ STEP_TABLE, INDEX_TABLE, HEADER_BYTES, BLOCK_ALIGN, SAMPLES_PER_BLOCK })
