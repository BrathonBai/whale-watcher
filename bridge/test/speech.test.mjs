// speech 单测：PCM 汇聚器必须只发偶数字节（设备按 int16_t 解析）。
//
// 跑：node test/speech.test.mjs
//
// 背景（2026-10-31）：Breeze 流式分块 121 块里 72 块是奇数字节，
// 设备端 `(const int16_t*)p` + `n/2` 会丢掉最后 1 字节，之后整体错位 → 满耳噪声。
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEvenSink, makePrebufferGate, splitForTts } from '../lib/speech.js'

const collect = (chunks, maxBytes) => {
  const out = []
  const sink = makeEvenSink((b) => out.push(Buffer.from(b)), maxBytes)
  for (const c of chunks) sink.push(Buffer.from(c))
  const left = sink.end()
  return { out, left }
}

test('任意分块长度 → 发出的每一帧都是偶数且 ≤ 上限', () => {
  // 复刻实测里那些奇怪的长度
  const sizes = [8836, 4898, 1225, 377, 3621, 27, 2422, 1226, 1199, 27, 1250, 171, 1180, 27]
  const chunks = sizes.map((n) => Buffer.alloc(n, 7))
  const total = sizes.reduce((a, b) => a + b, 0)
  const { out, left } = collect(chunks)
  for (const b of out) {
    assert.equal(b.length % 2, 0, `发出了奇数字节帧：${b.length}`)
    assert.ok(b.length <= 16384, `帧太大：${b.length}`)
  }
  const sent = out.reduce((a, b) => a + b.length, 0)
  assert.equal(sent + left, total, '字节不能凭空消失')
  assert.ok(left <= 1, '最多留 1 个字节的 carry')
})

test('单帧超过 16 KB 会被切开', () => {
  const { out } = collect([Buffer.alloc(40001, 1)])
  for (const b of out) assert.ok(b.length <= 16384, `帧太大：${b.length}`)
  assert.equal(out.reduce((a, b) => a + b.length, 0), 40000, '偶数部分应全部发出')
})

test('字节顺序保持不变（拼回去与原始偶数前缀一致）', () => {
  const chunks = [3, 5, 7, 9].map((n, i) => Buffer.alloc(n, i + 1))
  const total = chunks.reduce((a, b) => a + b.length, 0)
  const { out } = collect(chunks)
  const joined = Buffer.concat(out)
  const original = Buffer.concat(chunks).subarray(0, joined.length)
  assert.deepEqual(joined, original, '拼接结果必须与原始字节顺序一致')
  assert.equal(joined.length % 2, 0)
  assert.ok(joined.length <= total)
})

test('空输入不出帧', () => {
  const { out, left } = collect([])
  assert.equal(out.length, 0)
  assert.equal(left, 0)
})

test('splitForTts 仍然按句切', () => {
  const parts = splitForTts('第一句。第二句！')
  assert.deepEqual(parts, ['第一句。', '第二句！'])
})

// ---- 预缓冲闸门（2026-10-31：首包 1117 ms + 块间隔 393 ms → 边到边播会卡顿）----
test('预缓冲：没攒够一个字节都不发，攒够了才发头+首批', () => {
  const sent = []
  let started = 0
  const gate = makePrebufferGate({
    bytes: 480, // 10 ms
    onStart: () => {
      ++started
      return true
    },
    send: (b) => sent.push(Buffer.from(b)),
  })
  gate.push(Buffer.alloc(100, 1))
  gate.push(Buffer.alloc(200, 2))
  assert.equal(sent.length, 0, '没攒够之前一帧都不该发')
  assert.equal(started, 0, 'onStart 也不该被调用')
  gate.push(Buffer.alloc(200, 3)) // 到 500 ≥ 480
  assert.equal(started, 1, 'onStart 只调用一次')
  assert.equal(sent.reduce((a, b) => a + b.length, 0), 500, '首批必须一次性全发（保持顺序）')
  assert.equal(sent[0][0], 1)
  assert.equal(gate.primed, 500)
})

test('预缓冲：起播之后的帧直通，不再攒', () => {
  const sent = []
  const gate = makePrebufferGate({ bytes: 100, onStart: () => true, send: (b) => sent.push(b.length) })
  gate.push(Buffer.alloc(120, 1))
  assert.equal(sent.length, 1)
  gate.push(Buffer.alloc(4, 1))
  gate.push(Buffer.alloc(6, 1))
  assert.deepEqual(sent, [120, 4, 6])
})

test('预缓冲：短句不足预缓冲时，start() 兜底全发一次', () => {
  const sent = []
  const gate = makePrebufferGate({ bytes: 1000, onStart: () => true, send: (b) => sent.push(b.length) })
  gate.push(Buffer.alloc(48, 1))
  assert.equal(sent.length, 0)
  gate.start()
  assert.equal(gate.started, true)
  assert.deepEqual(sent, [48])
  gate.start() // 幂等
  assert.deepEqual(sent, [48])
})

test('预缓冲：onStart 放弃（设备下线/被打断）→ 一个字节都不发', () => {
  const sent = []
  const gate = makePrebufferGate({ bytes: 10, onStart: () => false, send: (b) => sent.push(b) })
  gate.push(Buffer.alloc(20, 1))
  gate.push(Buffer.alloc(20, 1))
  gate.start()
  assert.equal(sent.length, 0)
  assert.equal(gate.aborted, true)
  assert.equal(gate.started, true, 'aborted 之后也不能重复触发 onStart')
})

test('预缓冲：0 即"来了就发"，行为与旧版一致', () => {
  const sent = []
  let started = 0
  const gate = makePrebufferGate({ bytes: 0, onStart: () => ++started, send: (b) => sent.push(b.length) })
  gate.push(Buffer.alloc(8, 1))
  assert.deepEqual(sent, [8])
  assert.equal(started, 1)
})

// ============ 2026-11-13：ADPCM 下发（BLE 链路） ============

import { createSpeaker } from '../lib/speech.js'
import { createAudioController } from '../lib/audio_profile.js'
import { decodeBlocks } from '../lib/adpcm.js'

/** 假设备：记录 audio 头/二进制/audio_end，够 speech.js 的 adpcm 分支用。 */
function fakeDevice(codecs) {
  const events = []
  let resolveEnd
  const ended = new Promise((r) => (resolveEnd = r))
  const device = {
    online: true,
    codecs,
    opusRate: 24000,
    pongHistory: [],
    pongAgeMs: null,
    connectedMs: 1000,
    lastDiag: null,
    lastPongAt: null,
    transport: 'ble',
    uplink: 'adpcm',
    name: 'Jingjing-TEST',
    mtu: 247,
    audioHead(info) {
      events.push({ kind: 'head', info })
      return { ...info, t: 'audio' }
    },
    sendBinary(buf) {
      events.push({ kind: 'bin', buf: Buffer.from(buf) })
      return true
    },
    audioEnd(seq) {
      events.push({ kind: 'end', seq })
      resolveEnd(seq)
    },
    say() {
      return { sent: true }
    },
  }
  return { device, events, ended }
}

const silentLog = { info: () => {}, warn: () => {} }

test('adpcm 分支：头带 codec/samples，二进制块能解回原 PCM 长度，最后有 audio_end', async () => {
  const synthPcm = Buffer.alloc(9600) // 0.2 s @24k/mono/s16
  for (let i = 0; i < 4800; i++) synthPcm.writeInt16LE(Math.round(8000 * Math.sin((i / 24000) * 2 * Math.PI * 440)), i * 2)
  const { device, events, ended } = fakeDevice(['pcm', 'opus', 'adpcm'])
  const cfg = {
    get: () => ({
      tts: true,
      ttsEngine: 'sapi',
      audioCodec: 'adpcm',
      audioAdaptive: true,
      opusFrameMs: 20,
      opusBitrate: 16000,
      ttsPreBufferMs: 0,
      wsFrameBytes: 4096,
      maxReplyChars: 240,
    }),
  }
  const speaker = createSpeaker({
    cfg,
    log: silentLog,
    device,
    synthesizeImpl: async () => ({ rate: 24000, bits: 16, channels: 1, pcm: synthPcm }),
  })
  speaker.speak('测试')
  const seq = await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error('audio_end 超时')), 3000))])
  const head = events.find((e) => e.kind === 'head')
  assert.ok(head, '必须先发 audio 头')
  assert.equal(head.info.codec, 'adpcm')
  assert.equal(head.info.rate, 24000)
  assert.equal(head.info.samples, 4800, 'samples = 解码后应有采样数')
  const bins = events.filter((e) => e.kind === 'bin').map((e) => e.buf)
  assert.ok(bins.length >= 1)
  const total = Buffer.concat(bins)
  assert.equal(total.length, head.info.bytes, '二进制总量必须等于头里的 bytes')
  const dec = decodeBlocks(total, { samples: head.info.samples })
  assert.equal(dec.samples, 4800, '解码采样数必须与原始 PCM 一致')
  assert.equal(dec.trimmed, 1, '4800 是偶数，末块补了 1 个采样，应按 samples 裁掉')
  assert.equal(events.filter((e) => e.kind === 'end').length, 1)
  assert.equal(events.find((e) => e.kind === 'end').seq, seq)
})

test('adpcm 分支：合成失败 → 显式回退（返回 false，不发 audio 头）', async () => {
  const { device, events } = fakeDevice(['adpcm'])
  const cfg = {
    get: () => ({ tts: true, audioCodec: 'adpcm', ttsPreBufferMs: 0, wsFrameBytes: 4096, maxReplyChars: 240 }),
  }
  const speaker = createSpeaker({
    cfg,
    log: silentLog,
    device,
    synthesizeImpl: async () => {
      throw new Error('tts down')
    },
  })
  speaker.speak('测试')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(events.filter((e) => e.kind === 'head').length, 0, '合成失败不该发 audio 头')
  assert.equal(events.filter((e) => e.kind === 'end').length, 0)
})

test('编码协商：audioCodec=adpcm 时选 adpcm；auto+无 ffmpeg+设备支持 adpcm 也选 adpcm', () => {
  const mkDevice = (codecs) => ({ codecs, pongHistory: [], pongAgeMs: null, connectedMs: 0, lastDiag: null })
  const mkCfg = (audioCodec) => ({
    get: () => ({ audioCodec, audioAdaptive: true, opusBitrate: 16000, opusFrameMs: 20, ttsFfmpeg: '/nonexistent/ffmpeg' }),
  })
  const explicit = createAudioController({ cfg: mkCfg('adpcm'), log: silentLog, device: mkDevice(['pcm', 'opus', 'adpcm']) })
  const p1 = explicit.selectProfile()
  assert.equal(p1.codec, 'adpcm')
  assert.equal(p1.rate, 24000)

  const auto = createAudioController({ cfg: mkCfg('auto'), log: silentLog, device: mkDevice(['pcm', 'adpcm']) })
  const p2 = auto.selectProfile()
  assert.equal(p2.codec, 'adpcm', '没有 ffmpeg 时 auto 应选 adpcm（BLE 链路）')

  // 显式 adpcm 但设备不支持 → 显式回退 PCM
  const unsupported = createAudioController({ cfg: mkCfg('adpcm'), log: silentLog, device: mkDevice(['pcm', 'opus']) })
  assert.equal(unsupported.selectProfile().codec, 'pcm')

  // 老设备（无 codecs）+ 默认 auto → PCM，行为零回归
  const legacy = createAudioController({ cfg: mkCfg('auto'), log: silentLog, device: mkDevice([]) })
  assert.equal(legacy.selectProfile().codec, 'pcm')
})
