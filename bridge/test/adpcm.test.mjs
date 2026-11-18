// adpcm 单测：格式与 ffmpeg adpcm_ima_wav 同构 + 与固件共享的向量 + 往返质量 + 末块/裁剪。
//
// 跑：node test/adpcm.test.mjs
//
// 为什么这么测：
//   · decode[] 向量由 **ffmpeg 8.1.1** 的 adpcm_ima_wav 编码、ffmpeg 解码产生 → 验证我们的
//     解码器与参考实现逐采样一致（不是"自己和自己一致"）；
//   · encode[] 向量是 bridge/lib/adpcm.js 的输出，**固件 adpcm.cc 必须逐字节一致**；
//     两者合起来等价于"固件编码 → 桥解码"一定对（桥解码已被 ffmpeg 验证）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADPCM, CONSTANTS, decodeBlocks, encodeBlock, encodePcm, encodedBytesFor } from '../lib/adpcm.js'
import { AUDIO } from '../lib/contract.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'adpcm-vectors.json'), 'utf8'))

const hex = (s) => Buffer.from(s, 'hex')

/** 确定性 PCM（正弦+斜坡+噪声），用来做往返测试。 */
function makePcm(seconds = 0.35, rate = 24000, seed = 42) {
  const n = Math.round(seconds * rate)
  const buf = Buffer.alloc(n * 2)
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const sine = Math.round(12000 * Math.sin(2 * Math.PI * 440 * t))
    const ramp = Math.round(((i / n) * 2 - 1) * 20000)
    const noise = Math.round((rnd() * 2 - 1) * 800)
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(0.5 * sine + 0.4 * ramp + 0.1 * noise))), i * 2)
  }
  return buf
}

function snrDb(orig, dec) {
  let sig = 0
  let err = 0
  const n = Math.min(orig.length, dec.length)
  for (let i = 0; i < n; i += 2) {
    const s = orig.readInt16LE(i)
    const v = dec.readInt16LE(i)
    sig += s * s
    err += (s - v) * (s - v)
  }
  return err === 0 ? Infinity : 10 * Math.log10(sig / err)
}

test('常量：块对齐 / 每块采样 / 码率 / 与 contract.AUDIO.adpcm 一致', () => {
  assert.equal(ADPCM.blockAlign, 1024)
  assert.equal(ADPCM.headerBytes, 4)
  assert.equal(ADPCM.samplesPerBlock, 2041)
  assert.equal(ADPCM.rate, 24000)
  assert.ok(Math.abs(ADPCM.bytesPerSecond - 12042) <= 1)
  assert.equal(encodedBytesFor(24000 * 2), Math.ceil((24000 / 2041) * 1024))
  // contract 里的公开参数必须和实现一致（两处都写死过常量，避免漂移）
  assert.deepEqual({ ...AUDIO.adpcm }, {
    rate: ADPCM.rate,
    blockAlign: ADPCM.blockAlign,
    headerBytes: ADPCM.headerBytes,
    samplesPerBlock: ADPCM.samplesPerBlock,
    bytesPerSecond: ADPCM.bytesPerSecond,
    maxVoiceBytes: ADPCM.maxVoiceBytes,
  })
  assert.ok(AUDIO.uplinkCodecs.includes('adpcm'))
  assert.ok(AUDIO.codecs.includes('adpcm'))
})

test('解码器 vs ffmpeg：decode 向量逐采样 0 差异', () => {
  assert.ok(FIXTURE.decode.length >= 1, 'fixture 至少一条 decode 向量')
  for (const v of FIXTURE.decode) {
    const dec = decodeBlocks(hex(v.adpcmHex))
    const want = hex(v.pcmHex)
    assert.equal(dec.samples, v.samples, '采样数')
    assert.equal(dec.pcm.length, want.length, 'PCM 字节数')
    let maxd = 0
    for (let i = 0; i < want.length; i += 2) maxd = Math.max(maxd, Math.abs(dec.pcm.readInt16LE(i) - want.readInt16LE(i)))
    assert.equal(maxd, 0, `${v.source || 'ffmpeg'} 解码结果应与参考逐采样一致`)
  }
})

test('编码器 vs 共享向量：C（adpcm.cc）必须逐字节一致', () => {
  assert.ok(FIXTURE.encode.length >= 2, 'fixture 至少一条整块 + 一条短块')
  for (const v of FIXTURE.encode) {
    const pcm = hex(v.pcmHex)
    const enc = encodePcm(pcm)
    assert.equal(enc.encoded.toString('hex'), v.adpcmHex, `encode 向量 ${v.samples} 采样`)
  }
})

test('往返：编码→解码 SNR ≥ 30 dB，且采样数严格保留', () => {
  for (const seconds of [0.05, 0.35, 1.0]) {
    const pcm = makePcm(seconds)
    const enc = encodePcm(pcm)
    const dec = decodeBlocks(enc.encoded, { samples: enc.samples })
    assert.equal(dec.samples, pcm.length / 2, 'samples 裁剪后必须与原始采样数一致')
    const snr = snrDb(pcm, dec.pcm)
    assert.ok(snr >= 30, `${seconds}s 语音 SNR ${snr.toFixed(2)} dB 应 ≥ 30`)
  }
})

test('短块：奇数采样数（含 1）能编码/解码；偶数会补 1 个采样并由 samples 裁掉', () => {
  const samples = 2041 * 2 + 113 // 两个整块 + 113（奇数）
  const pcm = makePcm(samples / 24000 + 0.01)
  const trimmedPcm = pcm.subarray(0, samples * 2)
  const enc = encodePcm(trimmedPcm)
  assert.equal(enc.samples, samples)
  const lastBlock = enc.encoded.subarray((enc.blocks - 1) * 1024)
  assert.ok(lastBlock.length < 1024, '末块必须是短块')
  assert.equal(lastBlock.readInt16LE(0), trimmedPcm.readInt16LE((samples - 113) * 2), '末块头 predictor = 本块首采样')
  const dec = decodeBlocks(enc.encoded, { samples })
  assert.equal(dec.samples, samples)
  assert.equal(dec.trimmed, 0, '奇数采样不需要裁剪')

  // 偶数：编码器补 1 个采样，解码后按 samples 裁掉
  const evenSamples = 2041 * 2 + 114
  const evenPcm = pcm.subarray(0, evenSamples * 2)
  const enc2 = encodePcm(evenPcm)
  const dec2 = decodeBlocks(enc2.encoded, { samples: evenSamples })
  assert.equal(dec2.trimmed, 1, '偶数末块补的 1 个采样应被裁掉')
  assert.equal(dec2.samples, evenSamples)

  // 1 个采样也能编（短到极限）
  const one = Buffer.alloc(2)
  one.writeInt16LE(-1234, 0)
  const encOne = encodePcm(one)
  assert.equal(encOne.encoded.length, 4, '1 个采样 = 只有块头')
  assert.equal(decodeBlocks(encOne.encoded).samples, 1)
})

test('错误/边界：截断块不崩、trailing 计数、非 Buffer 抛错', () => {
  const pcm = makePcm(0.1)
  const enc = encodePcm(pcm)
  // 整块之后只剩 2 字节（不够一个块头）→ 应计入 trailing 而不是抛
  const cut = enc.encoded.subarray(0, 1024 + 2)
  const dec = decodeBlocks(cut)
  assert.equal(dec.trailing, 2, `trailing=${dec.trailing}`)
  assert.equal(dec.blocks, 1)
  assert.throws(() => decodeBlocks('nope'), /Buffer/)
  assert.throws(() => encodePcm(new Uint8Array(2)), /Buffer/)
  // 空流
  assert.deepEqual({ ...decodeBlocks(Buffer.alloc(0)) }, { pcm: Buffer.alloc(0), samples: 0, blocks: 0, trailing: 0, trimmed: 0 })
})

test('encodeBlock 状态跨块延续（index 不回零），块头 predictor 取本块首采样', () => {
  const pcm = makePcm(0.5)
  const all = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
  const state = { predictor: 0, index: 0 }
  const b0 = encodeBlock(all, 0, ADPCM.samplesPerBlock, state)
  const b1 = encodeBlock(all, ADPCM.samplesPerBlock, ADPCM.samplesPerBlock, state)
  assert.equal(b0.bytes.readInt16LE(0), all[0])
  assert.equal(b1.bytes.readInt16LE(0), all[ADPCM.samplesPerBlock])
  // index 由数据驱动：一块之后不应该还是 0（除非全静音）
  assert.ok(state.index > 0, `index=${state.index}`)
  assert.ok(CONSTANTS.STEP_TABLE.length === 89 && CONSTANTS.INDEX_TABLE.length === 16)
})
