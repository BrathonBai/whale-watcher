// opus 单测：Ogg 拆包 + ffmpeg 编码流水线 + 能力协商 + 自适应码率 + 回退策略。
//
// 跑：node test/opus.test.mjs
//
// 为什么不用真 ffmpeg：
//   本机沙箱里从测试 spawn 子进程会 EPERM；而且真编码几分钟内不可复现。
//   这里用三重覆盖：
//     1) bridge/test/fixtures/*.ogg（pwsh 里 ffmpeg 预生成的真实 Ogg Opus 夹具）→ 只读解析；
//     2) 测试内手工拼 Ogg page → 覆盖 lacing 255 / 跨页 continued 包这类夹具不容易造出来的边界；
//     3) encodePcmToOggOpus 注入假 spawn → 覆盖参数、错误码、超时/退出码路径，不真的起进程。
//   真机音质/延迟/ffmpeg 编码耗时属于"离线不可验证项"，见 docs/迭代-2026-11-03-桥Opus与自适应.md。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

import {
  OPUS_DECODE_RATE,
  OPUS_FRAME_MS,
  OPUS_MAX_PACKET_BYTES,
  OggOpusParser,
  buildFfmpegArgs,
  clampOpusBitrate,
  clampOpusFrameMs,
  encodePcmToOggOpus,
  ffmpegLooksUsable,
  parseOggOpus,
} from '../lib/opus_encode.js'
import {
  ADAPTIVE,
  bitrateForTier,
  classifyHealth,
  createAudioController,
  summarizePongWindow,
} from '../lib/audio_profile.js'
import { AUDIO } from '../lib/contract.js'
import { audioHead, parseDeviceMessage } from '../lib/protocol.js'
import { cacheKeyOf, createSpeaker, voiceIdentity } from '../lib/speech.js'
import * as voiceCache from '../lib/voicecache.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures')
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name))
const silentLog = { info: () => {}, warn: () => {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

// ------------------------------------------------------------------ 夹具

test('Ogg 夹具（1 s / 16 kbps）：包数≈时长/20ms，每包 1..1275 B，头包被跳过', () => {
  const buf = fixture('opus-1s-16k.ogg')
  const r = parseOggOpus(buf)
  assert.equal(r.ok, true, `解析失败：${r.error}`)
  assert.equal(r.headers, 2, 'OpusHead + OpusTags 两个头包应被跳过并记录')
  assert.ok(r.pages >= 2, `页数应 >1（实际 ${r.pages}）`)
  // 1 s / 20 ms = 50 个包；libopus 会在首尾补 padding，允许 ±2。
  assert.ok(Math.abs(r.packets.length - 50) <= 2, `包数 ${r.packets.length} 与 50 相差过大`)
  for (const p of r.packets) {
    assert.ok(p.length >= 1 && p.length <= OPUS_MAX_PACKET_BYTES, `包长 ${p.length} 越界`)
  }
  assert.equal(r.packets.reduce((a, p) => a + p.length, 0), r.bytes, '包字节合计应等于统计值')
  assert.ok(r.bytes > 0)
  console.log(`  · 夹具 1s：${r.pages} 页 / ${r.packets.length} 包 / ${r.bytes} B / 头 ${r.headers}`)
})

test('任意分块喂入（跨 chunk 的 page 边界）结果与一次性解析一致', () => {
  const buf = fixture('opus-1s-16k.ogg')
  const oneShot = parseOggOpus(buf)
  for (const sizes of [[1], [7], [13, 100, 5], [255, 1, 1024, 3, 64]]) {
    const parser = new OggOpusParser()
    const packets = []
    let off = 0
    let i = 0
    while (off < buf.length) {
      const n = Math.min(sizes[i % sizes.length], buf.length - off)
      packets.push(...parser.push(buf.subarray(off, off + n)))
      off += n
      i += 1
    }
    const tail = parser.finish()
    assert.equal(tail.ok, true, `分块 ${sizes} 解析失败：${tail.error}`)
    assert.equal(packets.length, oneShot.packets.length, `分块 ${sizes} 包数不一致`)
    assert.deepEqual(Buffer.concat(packets), Buffer.concat(oneShot.packets), `分块 ${sizes} 包内容不一致`)
  }
})

test('lacing 255：单包 >255 B（128 kbps 夹具）也能正确切出', () => {
  const r = parseOggOpus(fixture('opus-80ms-128k.ogg'))
  assert.equal(r.ok, true, `解析失败：${r.error}`)
  assert.ok(r.packets.length >= 4, `80 ms 应有约 4 个包，实际 ${r.packets.length}`)
  assert.ok(Math.abs(r.packets.length - 4) <= 1, `包数 ${r.packets.length} 与 4 相差过大`)
  const big = r.packets.filter((p) => p.length > 255)
  assert.ok(big.length >= 1, '128 kbps 夹具应至少有一个包 >255 B（用到 lacing 255）')
  for (const p of r.packets) assert.ok(p.length <= OPUS_MAX_PACKET_BYTES)
  console.log(`  · 夹具 80ms/128k：${r.packets.length} 包，最大 ${Math.max(...r.packets.map((p) => p.length))} B`)
})

// ------------------------------------------------------------------ 手工拼 Ogg page

/**
 * 拼一个 Ogg page。segments 是"每段多少字节"的 Buffer 数组：
 * 每段长度就是 lacing value；长度 255 表示该包未结束（要继续读下一页）。
 * CRC 不校验（解析器只做结构校验），所以填 0。
 */
function oggPage({ flags = 0, sequence = 0, serial = 0x5a17, segments = [] } = {}) {
  assert.ok(segments.length <= 255)
  const header = Buffer.alloc(27)
  header.write('OggS', 0, 'latin1')
  header[4] = 0
  header[5] = flags
  header.writeUInt32LE(0, 6)
  header.writeUInt32LE(0, 10)
  header.writeUInt32LE(serial, 14)
  header.writeUInt32LE(sequence, 18)
  header.writeUInt32LE(0, 22)
  header[26] = segments.length
  for (const s of segments) assert.ok(s.length <= 255, '单段不能超过 255 B')
  const lacing = Buffer.from(segments.map((s) => s.length))
  return Buffer.concat([header, lacing, ...segments])
}

const headPage = () =>
  oggPage({
    flags: 0x02, // BOS
    sequence: 0,
    segments: [Buffer.from('OpusHead' + '\x01\x01\x38\x01\x80\xbb\x00\x00\x00\x00\x00'), Buffer.from('OpusTags\x04\x00\x00\x00abcd')],
  })

test('跨页 continued 包（lacing 255 + 下一页 continued 标志）必须拼回一整个包', () => {
  const pkt = Buffer.concat([Buffer.alloc(255, 0xaa), Buffer.alloc(45, 0xbb)]) // 300 B
  const stream = Buffer.concat([
    headPage(),
    oggPage({ flags: 0x00, sequence: 1, segments: [pkt.subarray(0, 255)] }), // 末尾 lacing=255 → 半包
    oggPage({ flags: 0x01, sequence: 2, segments: [pkt.subarray(255)] }), // continued → 补完
    oggPage({ flags: 0x00, sequence: 3, segments: [Buffer.alloc(20, 0xcc)] }),
  ])
  const r = parseOggOpus(stream)
  assert.equal(r.ok, true, `解析失败：${r.error}`)
  assert.equal(r.continuedPages, 1, '应识别出 1 个 continued 页')
  assert.equal(r.packets.length, 2)
  assert.equal(r.packets[0].length, 300)
  assert.deepEqual(r.packets[0], pkt, '跨页包内容必须完整')
  assert.equal(r.packets[1].length, 20)
})

test('结构损坏必须显式报错，不静默丢包', () => {
  // 1) 不是 Ogg（长度必须够一页，短输入会先被判"尾部残缺"）
  const junk = Buffer.concat([Buffer.from('not an ogg stream at all'), Buffer.alloc(32, 0x20)])
  assert.match(parseOggOpus(junk).error, /不是 Ogg/)
  // 2) continued 标志但没有上一页半包
  const contWithoutPending = new OggOpusParser()
  contWithoutPending.push(oggPage({ flags: 0x01, segments: [Buffer.alloc(10)] }))
  assert.match(contWithoutPending.error, /continued/)
  // 3) 有半包但下一页没 continued
  const lostFlag = new OggOpusParser()
  lostFlag.push(headPage())
  lostFlag.push(oggPage({ flags: 0x00, sequence: 1, segments: [Buffer.alloc(255)] }))
  lostFlag.push(oggPage({ flags: 0x00, sequence: 2, segments: [Buffer.alloc(10)] }))
  assert.match(lostFlag.error, /continued/)
  // 4) 单包超过 1275 B
  const tooBig = new OggOpusParser()
  tooBig.push(headPage())
  tooBig.push(
    oggPage({
      flags: 0x00,
      sequence: 1,
      segments: [Buffer.alloc(255), Buffer.alloc(255), Buffer.alloc(255), Buffer.alloc(255), Buffer.alloc(255), Buffer.alloc(10)],
    }),
  )
  assert.match(tooBig.error, /越界/)
  // 5) 尾部残缺（半个包）
  const truncated = new OggOpusParser()
  truncated.push(headPage())
  truncated.push(oggPage({ flags: 0x00, sequence: 1, segments: [Buffer.alloc(255)] }))
  const tail = truncated.finish()
  assert.equal(tail.ok, false)
  assert.match(tail.error, /残缺/)
})

// ------------------------------------------------------------------ ffmpeg 参数/编码流水线（假 spawn）

function makeFakeSpawn({ replay = Buffer.alloc(0), chunks = [3, 7, 64, 1024], exitCode = 0, stderr = '', errorCode = '' } = {}) {
  const calls = []
  const written = []
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
    }
    child.stdin = {
      on() {},
      end(buf) {
        written.push(buf ? Buffer.from(buf) : Buffer.alloc(0))
        setImmediate(() => {
          if (errorCode) {
            const e = new Error(`spawn ${errorCode}`)
            e.code = errorCode
            child.emit('error', e)
            return
          }
          let off = 0
          let i = 0
          const pump = () => {
            if (off >= replay.length) {
              if (stderr) child.stderr.emit('data', Buffer.from(stderr))
              child.emit('close', exitCode, null)
              return
            }
            const n = Math.min(chunks[i % chunks.length], replay.length - off)
            i += 1
            child.stdout.emit('data', replay.subarray(off, off + n))
            off += n
            setImmediate(pump)
          }
          pump()
        })
      },
    }
    return child
  }
  return { spawnImpl, calls, written }
}

test('buildFfmpegArgs：libopus / 20ms / 16k 输出 / 24k 输入 / Ogg 走管道', () => {
  const args = buildFfmpegArgs({ bitrate: 16000, frameMs: 20, inputRate: 24000 })
  const pairs = (flag) => args.reduce((acc, v, i) => (args[i] === flag ? [...acc, args[i + 1]] : acc), [])
  assert.deepEqual(pairs('-f'), ['s16le', 'ogg'], '-f 分别是输入 s16le 与输出 ogg')
  assert.deepEqual(pairs('-ar'), ['24000', '16000'], '-ar 输入 24k、输出 16k')
  assert.deepEqual(pairs('-ac'), ['1'])
  assert.deepEqual(pairs('-c:a'), ['libopus'])
  assert.deepEqual(pairs('-b:a'), ['16000'])
  assert.deepEqual(pairs('-application'), ['voip'])
  assert.deepEqual(pairs('-frame_duration'), ['20'])
  assert.equal(args[args.length - 1], 'pipe:1')
  assert.ok(args.includes('pipe:0'))
  // 输入参数要在 -i pipe:0 之前，输出参数在它之后
  const iFlag = args.indexOf('-i')
  assert.ok(iFlag > 0)
  assert.equal(args[iFlag + 1], 'pipe:0')
  assert.ok(args.lastIndexOf('-ar') > iFlag)
})

test('encodePcmToOggOpus：假 spawn 回放夹具 → 包数与时长对得上（不真起 ffmpeg）', async () => {
  const replay = fixture('opus-1s-16k.ogg')
  const fake = makeFakeSpawn({ replay, chunks: [5, 100, 777, 2] })
  const pcm = Buffer.alloc(24000 * 2, 0) // 1 s 24 kHz mono 静音
  const r = await encodePcmToOggOpus({ pcm, inputRate: 24000, bitrate: 16000, frameMs: 20, ffmpegPath: 'ffmpeg', spawnImpl: fake.spawnImpl })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(fake.calls.length, 1, '应只 spawn 一次')
  assert.equal(fake.calls[0].cmd, 'ffmpeg')
  assert.equal(fake.calls[0].args.includes('libopus'), true)
  assert.equal(fake.written[0].length, pcm.length, 'PCM 必须整段写进 stdin')
  assert.ok(Math.abs(r.packetCount - 50) <= 2, `包数 ${r.packetCount} 应≈50`)
  assert.ok(Math.abs(r.durationMs - 1000) < 1, `时长应≈1000 ms，实际 ${r.durationMs}`)
  assert.equal(r.bitrate, 16000)
  assert.equal(r.frameMs, 20)
  assert.equal(r.inputRate, 24000)
  assert.ok(r.encodeMs >= 0)
  for (const p of r.packets) assert.ok(p.length >= 1 && p.length <= OPUS_MAX_PACKET_BYTES)
  console.log(`  · 假 spawn：${r.packetCount} 包 / ${r.bytes} B / encodeMs=${r.encodeMs}`)
})

test('encodePcmToOggOpus：ffmpeg 路径不存在 → OPUS_UNAVAILABLE（且不 spawn）', async () => {
  let spawned = false
  const ghost = path.join(os.tmpdir(), `no-such-ffmpeg-${Date.now()}.exe`)
  const r = await encodePcmToOggOpus({
    pcm: Buffer.alloc(4800),
    ffmpegPath: ghost,
    spawnImpl: () => {
      spawned = true
      throw new Error('不该被调用')
    },
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'OPUS_UNAVAILABLE')
  assert.match(r.message, /opus encode unavailable/)
  assert.equal(spawned, false, '路径不存在时不该尝试 spawn')
  assert.equal(ffmpegLooksUsable(ghost), false)
  assert.equal(ffmpegLooksUsable('ffmpeg'), true, '裸命令名交给 spawn 判（不假装不可用）')
})

test('encodePcmToOggOpus：spawn ENOENT / 退出码非 0 / 空输入 → 各自的显式错误码', async () => {
  const enoent = makeFakeSpawn({ errorCode: 'ENOENT' })
  const r1 = await encodePcmToOggOpus({ pcm: Buffer.alloc(4800), ffmpegPath: 'ffmpeg', spawnImpl: enoent.spawnImpl })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'OPUS_UNAVAILABLE')
  assert.match(r1.message, /opus encode unavailable/)

  const crashed = makeFakeSpawn({ replay: Buffer.alloc(0), exitCode: 1, stderr: 'libopus not found' })
  const r2 = await encodePcmToOggOpus({ pcm: Buffer.alloc(4800), ffmpegPath: 'ffmpeg', spawnImpl: crashed.spawnImpl })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'OPUS_FFMPEG_FAILED')
  assert.match(r2.message, /退出码 1/)
  assert.match(r2.stderrTail, /libopus not found/)

  const empty = await encodePcmToOggOpus({ pcm: Buffer.alloc(0) })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'OPUS_EMPTY')
  const odd = await encodePcmToOggOpus({ pcm: Buffer.alloc(101) })
  assert.equal(odd.ok, false)
  assert.equal(odd.code, 'OPUS_PARSE')
})

test('clamp 助手：码率/帧长落在 libopus 能接受的范围', () => {
  assert.equal(clampOpusBitrate(16000), 16000)
  assert.equal(clampOpusBitrate(1), 6000)
  assert.equal(clampOpusBitrate(999999), 510000)
  assert.equal(clampOpusBitrate(undefined), 16000)
  assert.equal(clampOpusFrameMs(20), 20)
  assert.equal(clampOpusFrameMs(7), 20)
  assert.equal(clampOpusFrameMs(40), 40)
})

// ------------------------------------------------------------------ 协商 + 自适应（纯函数/状态机）

function makeCfg(extra = {}) {
  const base = {
    tts: true,
    ttsEngine: 'breeze',
    breezeVoiceId: 'v-opus',
    breezeStream: false,
    ttsPreBufferMs: 1000,
    wsFrameBytes: 4096,
    audioCodec: 'auto',
    opusBitrate: 16000,
    audioAdaptive: true,
    opusFrameMs: 20,
    ttsFfmpeg: 'ffmpeg',
    ...extra,
  }
  return { get: () => base }
}

function makeDevice({ codecs = [], history = [], connectedMs = 60000, pongAgeMs = 1000, online = true } = {}) {
  return {
    codecs,
    connectedMs,
    pongAgeMs,
    _history: history,
    opusRate: codecs.includes('opus') ? 16000 : 0,
    get pongHistory() {
      return this._history.slice()
    },
    get lastDiag() {
      return this._history.length ? this._history[this._history.length - 1] : null
    },
    get lastPongAt() {
      return this.pongAgeMs == null ? null : Date.now() - this.pongAgeMs
    },
    get online() {
      return online
    },
    audioHead() {
      return true
    },
    sendBinary() {
      return true
    },
    audioEnd() {
      return true
    },
  }
}

const healthyHistory = () => [
  { at: 1, bufMs: 200, underruns: 1, reconnects: 0, rssi: -48, codec: 'opus' },
  { at: 2, bufMs: 180, underruns: 1 },
  { at: 3, bufMs: 220, underruns: 1 },
]
const mediumHistory = () => [
  { at: 1, bufMs: 80, underruns: 1 },
  { at: 2, bufMs: 75, underruns: 2 },
  { at: 3, bufMs: 70, underruns: 3 },
]
const poorHistory = () => [
  { at: 1, bufMs: 5, underruns: 1 },
  { at: 2, bufMs: 8, underruns: 9 },
]

test('健康度分类：healthy / medium / poor / unknown / 无 pong', () => {
  assert.equal(classifyHealth(healthyHistory()).tier, 'healthy')
  assert.equal(classifyHealth(mediumHistory()).tier, 'medium')
  assert.equal(classifyHealth(poorHistory()).tier, 'poor')
  assert.equal(classifyHealth([]).tier, 'unknown')
  assert.equal(classifyHealth([], { pongAgeMs: 70000 }).tier, 'poor')
  assert.match(classifyHealth([], { pongAgeMs: 70000 }).reason, /没有 pong/)
  assert.equal(classifyHealth([], { pongAgeMs: null, connectedMs: 90000 }).tier, 'poor')
  // 老固件 pong 只有 {"t":"pong"}：没有健康字段 → unknown（不是 poor，不能误回退）
  assert.equal(classifyHealth([{ at: 1 }, { at: 2 }]).tier, 'unknown')
  // underruns 计数归零（设备重启）不能被当成巨量欠载
  const reset = summarizePongWindow([
    { at: 1, bufMs: 200, underruns: 500 },
    { at: 2, bufMs: 200, underruns: 2 },
    { at: 3, bufMs: 200, underruns: 4 },
  ])
  assert.equal(reset.underrunsDelta, 2, `重启后增量应为 2，实际 ${reset.underrunsDelta}`)
})

test('档位→码率：健康 24k / 中 16k / 差 8k / 未知用基准', () => {
  assert.equal(bitrateForTier('healthy'), ADAPTIVE.HEALTHY_BPS)
  assert.equal(bitrateForTier('medium'), ADAPTIVE.MEDIUM_BPS)
  assert.equal(bitrateForTier('poor'), ADAPTIVE.LOW_BPS)
  assert.equal(bitrateForTier('unknown', 12000), 12000)
  assert.equal(ADAPTIVE.HEALTHY_BPS, 24000)
  assert.equal(ADAPTIVE.MEDIUM_BPS, 16000)
  assert.equal(ADAPTIVE.LOW_BPS, 8000)
  assert.deepEqual(Object.values(AUDIO.adaptive), [24000, 16000, 8000])
})

test('协商：老设备（无 codecs）→ PCM；声明 codecs 含 opus → opus', () => {
  const legacy = createAudioController({ cfg: makeCfg(), log: silentLog, device: makeDevice({ codecs: [] }) })
  const pLegacy = legacy.selectProfile()
  assert.equal(pLegacy.codec, 'pcm')
  assert.match(pLegacy.reason, /未声明|PCM/)

  const modern = createAudioController({ cfg: makeCfg(), log: silentLog, device: makeDevice({ codecs: ['pcm', 'opus'], history: healthyHistory() }) })
  const pModern = modern.selectProfile()
  assert.equal(pModern.codec, 'opus')
  assert.equal(pModern.bitrate, 24000, '健康档应选 24 kbps')
  assert.equal(pModern.tier, 'healthy')
  assert.equal(pModern.frameMs, 20)
  assert.equal(pModern.rate, OPUS_DECODE_RATE)
})

test('协商：audioCodec=pcm 强制；audioCodec=opus 但设备不支持 → 显式 PCM', () => {
  const forcedPcm = createAudioController({
    cfg: makeCfg({ audioCodec: 'pcm' }),
    log: silentLog,
    device: makeDevice({ codecs: ['pcm', 'opus'], history: healthyHistory() }),
  })
  assert.equal(forcedPcm.selectProfile().codec, 'pcm')

  const forcedOpusButLegacy = createAudioController({ cfg: makeCfg({ audioCodec: 'opus' }), log: silentLog, device: makeDevice({ codecs: [] }) })
  const p = forcedOpusButLegacy.selectProfile()
  assert.equal(p.codec, 'pcm')
  assert.match(p.reason, /未声明|不含 opus/)
})

test('自适应：连续 2 段差 → 回退 PCM；恢复健康后自动回 opus', () => {
  const dev = makeDevice({ codecs: ['pcm', 'opus'], history: poorHistory() })
  const ctrl = createAudioController({ cfg: makeCfg(), log: silentLog, device: dev })

  const p1 = ctrl.selectProfile()
  assert.equal(p1.codec, 'opus', '第一次差仍给最低档 opus')
  assert.equal(p1.bitrate, 8000, '差档应选 8 kbps')
  const p2 = ctrl.selectProfile()
  assert.equal(p2.codec, 'pcm', '连续两段差应回退 PCM')
  assert.match(p2.reason, /连续 2 段/)
  assert.equal(ctrl.state().lastSwitch.to.codec, 'pcm', '切换原因必须可在 diag 解释')

  // 健康度还没恢复：维持 PCM，不来回抖（HOLD 语义）
  const p2b = ctrl.selectProfile()
  assert.equal(p2b.codec, 'pcm')
  assert.match(p2b.reason, /维持 PCM/)

  dev._history = healthyHistory()
  const p3 = ctrl.selectProfile()
  assert.equal(p3.codec, 'opus')
  assert.equal(p3.bitrate, 24000)
  assert.equal(ctrl.state().lastSwitch.to.codec, 'opus', '恢复健康要记录切回 opus')
})

test('自适应关闭：固定用配置里的基准码率（tier=fixed）', () => {
  const dev = makeDevice({ codecs: ['pcm', 'opus'], history: poorHistory() })
  const ctrl = createAudioController({ cfg: makeCfg({ audioAdaptive: false, opusBitrate: 12000 }), log: silentLog, device: dev })
  const p = ctrl.selectProfile()
  assert.equal(p.codec, 'opus')
  assert.equal(p.bitrate, 12000)
  assert.equal(p.tier, 'fixed')
})

test('编码连续失败 2 次 → 冷却期回退 PCM，错误在 state 可见', () => {
  const dev = makeDevice({ codecs: ['pcm', 'opus'], history: healthyHistory() })
  const ctrl = createAudioController({ cfg: makeCfg(), log: silentLog, device: dev })
  ctrl.noteEncode({ ok: false, error: 'OPUS_FFMPEG_FAILED: boom' })
  assert.equal(ctrl.selectProfile().codec, 'opus', '只失败 1 次不切换')
  ctrl.noteEncode({ ok: false, error: 'OPUS_FFMPEG_FAILED: boom again' })
  const p = ctrl.selectProfile()
  assert.equal(p.codec, 'pcm')
  assert.match(p.reason, /冷却/)
  const st = ctrl.state()
  assert.match(st.lastEncodeError, /OPUS_FFMPEG_FAILED/)
  assert.ok(st.opusBlockedUntil > Date.now() - 1000)
  // 编码恢复后清掉错误
  ctrl.noteEncode({ ok: true, ms: 12 })
  assert.equal(ctrl.state().lastEncodeError, '')
  assert.equal(ctrl.state().lastEncodeMs, 12)
})

test('回退留痕：noteFallback 后 state.effective 如实变成 pcm', () => {
  const dev = makeDevice({ codecs: ['pcm', 'opus'], history: healthyHistory() })
  const ctrl = createAudioController({ cfg: makeCfg(), log: silentLog, device: dev })
  assert.equal(ctrl.selectProfile().codec, 'opus')
  ctrl.noteFallback({ reason: 'opus 编码失败 → 本段回退 PCM' })
  const st = ctrl.state()
  assert.equal(st.effective, 'pcm')
  assert.equal(st.bitrate, 0)
  assert.equal(st.tier, 'fallback')
  assert.match(st.lastFallback.reason, /回退 PCM/)
})

test('state() 满足 /api/diag.audio 的字段契约', () => {
  const dev = makeDevice({ codecs: ['pcm', 'opus'], history: healthyHistory() })
  const ctrl = createAudioController({ cfg: makeCfg(), log: silentLog, device: dev })
  ctrl.selectProfile()
  const st = ctrl.state()
  for (const k of ['codec', 'effective', 'bitrate', 'adaptive', 'lastEncodeMs', 'lastEncodeError', 'pong']) {
    assert.ok(k in st, `audio 缺字段 ${k}`)
  }
  assert.equal(st.codec, 'auto')
  assert.equal(st.effective, 'opus')
  assert.equal(st.adaptive, true)
  assert.equal(st.pong.bufMs, 220, 'pong 应带最近一次诊断字段')
  assert.equal(st.device.supportsOpus, true)
  assert.equal(st.device.codecs.length, 2)
  assert.ok(st.rates.healthy === 24000)
})

// ------------------------------------------------------------------ 协议字段（跨线契约）

test('hello：codecs/opusRate 被保留；老 hello 缺字段也正常', () => {
  const modern = parseDeviceMessage('{"t":"hello","fw":"hub_v2","ver":"0.2","codecs":["pcm","opus"],"opusRate":16000}')
  assert.equal(modern.ok, true)
  assert.deepEqual(modern.msg.codecs, ['pcm', 'opus'])
  assert.equal(modern.msg.opusRate, 16000)

  const legacy = parseDeviceMessage('{"t":"hello","fw":"hub_v2","board":"watcher","ver":"0.2","cam":1,"w":240,"h":240}')
  assert.equal(legacy.ok, true)
  assert.deepEqual(legacy.msg.codecs, [])
  assert.equal(legacy.msg.opusRate, 0)

  // 乱类型不能把后续判断带偏（不报错，但只收合法字符串）
  const weird = parseDeviceMessage('{"t":"hello","codecs":["opus",3,"",null],"opusRate":"fast"}')
  assert.equal(weird.ok, true)
  assert.deepEqual(weird.msg.codecs, ['opus'])
  assert.equal(weird.msg.opusRate, 0)
})

test('pong：诊断字段可选；缺字段不能报错（老固件）', () => {
  const rich = parseDeviceMessage('{"t":"pong","bufMs":120,"underruns":4,"reconnects":2,"rssi":-51,"codec":"opus"}')
  assert.equal(rich.ok, true)
  assert.deepEqual(rich.msg, { t: 'pong', bufMs: 120, underruns: 4, reconnects: 2, rssi: -51, codec: 'opus' })

  const plain = parseDeviceMessage('{"t":"pong"}')
  assert.equal(plain.ok, true)
  assert.deepEqual(plain.msg, { t: 'pong' })

  const partial = parseDeviceMessage('{"t":"pong","bufMs":33}')
  assert.deepEqual(partial.msg, { t: 'pong', bufMs: 33 })
})

test('audioHead：codec 合法化（缺省/乱写 → pcm），opus 头字段符合跨线约定', () => {
  const pcm = audioHead({ bytes: 4800, seq: 3 })
  assert.equal(pcm.codec, 'pcm')
  assert.equal(pcm.t, 'audio')

  const opus = audioHead({ codec: 'opus', rate: OPUS_DECODE_RATE, bits: 16, ch: 1, bytes: 0, seq: 7 })
  assert.deepEqual(opus, { t: 'audio', rate: 24000, bits: 16, ch: 1, bytes: 0, seq: 7, codec: 'opus' })

  assert.equal(audioHead({ codec: '乱写' }).codec, 'pcm')
  assert.equal(OPUS_FRAME_MS, 20)
  assert.equal(AUDIO.opus.maxPacketBytes, OPUS_MAX_PACKET_BYTES)
  assert.equal(AUDIO.defaultCodec, 'pcm')
})

// ------------------------------------------------------------------ speech 集成（注入编码器，不 spawn）

function makeRecordingDevice({ codecs = ['pcm', 'opus'], history = healthyHistory() } = {}) {
  const calls = { head: [], frames: [], end: [] }
  const dev = {
    calls,
    codecs,
    connectedMs: 60000,
    pongAgeMs: 1000,
    _history: history,
    opusRate: 16000,
    get pongHistory() {
      return this._history.slice()
    },
    get lastDiag() {
      return this._history.length ? this._history[this._history.length - 1] : null
    },
    get lastPongAt() {
      return Date.now() - this.pongAgeMs
    },
    get online() {
      return true
    },
    audioHead(info) {
      // 模拟 device.js：真正的 audio 头由 protocol.audioHead() 补 t/字段
      calls.head.push({ t: 'audio', ...info })
      return true
    },
    sendBinary(buf) {
      calls.frames.push(Buffer.from(buf))
      return true
    },
    audioEnd(seq) {
      calls.end.push(seq)
      return true
    },
  }
  return dev
}

async function waitIdle(speaker, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!speaker.busy && speaker.pending === 0) return
    await sleep(5)
  }
  throw new Error('speaker 没有在超时内跑完')
}

test('speech opus：audio 头 codec=opus/rate=24000/bytes=0，每帧一包，20ms 节奏，audio_end 收尾', async () => {
  const dir = tmpDir('opus-speech-')
  process.env.DSH_VOICEPACK_DIR = dir
  const packets = [Buffer.alloc(40, 1), Buffer.alloc(50, 2), Buffer.alloc(45, 3), Buffer.alloc(60, 4)]
  const encodeCalls = []
  const encodePcm = async (opts) => {
    encodeCalls.push(opts)
    return {
      ok: true,
      packets: packets.map((p) => Buffer.from(p)),
      packetCount: packets.length,
      bytes: packets.reduce((a, p) => a + p.length, 0),
      durationMs: 1000,
      encodeMs: 3,
      bitrate: opts.bitrate,
      frameMs: opts.frameMs,
      inputRate: opts.inputRate,
      expectedPackets: 50,
      warnings: [],
    }
  }
  const cfg = makeCfg({ ttsPreBufferMs: 0 })
  const device = makeRecordingDevice()
  const speaker = createSpeaker({
    cfg,
    log: silentLog,
    device,
    encodePcm,
    synthesizeImpl: async () => ({ rate: 24000, bits: 16, channels: 1, pcm: Buffer.alloc(24000 * 2, 0) }),
  })

  const t0 = Date.now()
  speaker.speak('你好呀')
  await waitIdle(speaker)
  const elapsed = Date.now() - t0

  assert.equal(encodeCalls.length, 1, '应调用一次编码器')
  assert.equal(encodeCalls[0].inputRate, 24000)
  assert.equal(encodeCalls[0].bitrate, 24000, '健康档 24 kbps')
  assert.equal(encodeCalls[0].frameMs, 20)

  assert.equal(device.calls.head.length, 1)
  const head = device.calls.head[0]
  assert.equal(head.t, 'audio')
  assert.equal(head.codec, 'opus')
  assert.equal(head.rate, 24000, 'opus 头 rate 必须是设备解码输出率 24000')
  assert.equal(head.bits, 16)
  assert.equal(head.ch, 1)
  assert.equal(head.bytes, 0, 'opus 是流式，长度未知 → bytes=0')
  assert.equal(device.calls.frames.length, packets.length, '每帧必须是一个裸 Opus 包')
  device.calls.frames.forEach((f, i) => assert.deepEqual(f, packets[i], `第 ${i} 帧内容不得拼接/截断`))
  assert.equal(device.calls.end.length, 1)
  assert.equal(device.calls.end[0], head.seq)
  // ttsPreBufferMs=0 → 首包立即发，其余每 20ms 一包：4 包 ≈ 60ms
  assert.ok(elapsed >= 40, `节流没生效？4 包只用了 ${elapsed} ms`)
  assert.ok(elapsed < 2000, `节流过慢：${elapsed} ms`)

  const ast = speaker.audioState()
  assert.equal(ast.effective, 'opus')
  assert.equal(ast.bitrate, 24000)
  assert.equal(ast.lastEncodeMs, 3)
  assert.equal(ast.lastEncodeError, '')

  // 第二遍应命中 Opus 台词包：不再编码，直接按包重放
  speaker.speak('你好呀')
  await waitIdle(speaker)
  assert.equal(encodeCalls.length, 1, '缓存命中不应再编码')
  assert.equal(device.calls.head.length, 2)
  assert.equal(device.calls.frames.length, packets.length * 2, '缓存命中要整段重放')
  assert.deepEqual(device.calls.head[1], { ...device.calls.head[1], codec: 'opus', bytes: 0 })

  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.DSH_VOICEPACK_DIR
})

test('speech 回退：opus 编码失败 → 同一段显式改发 PCM（不静默），diag 留痕', async () => {
  const dir = tmpDir('opus-fallback-')
  process.env.DSH_VOICEPACK_DIR = dir
  const cfg = makeCfg({ ttsPreBufferMs: 0 })
  const device = makeRecordingDevice()
  const pcm = Buffer.alloc(24000 * 2 * 0.2, 0) // 0.2 s
  const speaker = createSpeaker({
    cfg,
    log: silentLog,
    device,
    encodePcm: async () => ({ ok: false, code: 'OPUS_FFMPEG_FAILED', message: 'boom', encodeMs: 1 }),
    synthesizeImpl: async () => ({ rate: 24000, bits: 16, channels: 1, pcm }),
  })

  speaker.speak('失败也要出声')
  await waitIdle(speaker)

  assert.equal(device.calls.head.length, 1, '回退后仍应有 1 个 audio 头')
  assert.equal(device.calls.head[0].codec, 'pcm', '回退后头必须是 pcm')
  assert.ok(device.calls.head[0].bytes > 0, 'PCM 头要带真实字节数')
  const sent = device.calls.frames.reduce((a, b) => a + b.length, 0)
  assert.equal(sent, pcm.length, 'PCM 回退要真的把整段发出去')
  assert.equal(device.calls.end.length, 1)

  const ast = speaker.audioState()
  assert.equal(ast.effective, 'pcm', 'diag 必须如实显示本段是 pcm')
  assert.match(ast.lastEncodeError, /OPUS_FFMPEG_FAILED/)
  assert.ok(ast.lastFallback, '回退必须留痕（可在 /api/diag 解释）')

  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.DSH_VOICEPACK_DIR
})

// ------------------------------------------------------------------ 台词包（voicecache）版本化

test('voicecache：opus 包序列往返；键含语速/模型/引擎（换了就不命中）', () => {
  const dir = tmpDir('voicecache-')
  process.env.DSH_VOICEPACK_DIR = dir
  const c = { ttsEngine: 'breeze', breezeVoiceId: 'v1', breezeModel: 'm1', breezeSpeed: 1.0, breezeGuidance: 4.0, ttsRate: '+0%' }
  const baseOpts = { ...voiceIdentity(c), codec: 'opus', bitrate: 24000, rate: 24000, frameMs: 20 }
  const key = voiceCache.keyOf('你好', baseOpts)

  const packets = [Buffer.alloc(40, 1), Buffer.alloc(50, 2), Buffer.alloc(60, 3)]
  const w = voiceCache.beginWrite(key, { codec: 'opus', rate: 24000, bits: 16, ch: 1, frameMs: 20, bitrate: 24000, ...voiceIdentity(c) })
  for (const p of packets) w.pushPacket(p)
  assert.equal(w.commit(), true)

  const hit = voiceCache.get(key)
  assert.equal(hit.codec, 'opus')
  assert.equal(hit.packets.length, 3)
  assert.deepEqual(hit.packets, packets, '包边界/内容必须原样恢复')
  assert.equal(hit.bytes, packets.reduce((a, p) => a + p.length, 0))

  // 语速不同 → 不同键 → 不命中（不许拿 1.0x 的包去播 1.5x）
  assert.notEqual(voiceCache.keyOf('你好', { ...baseOpts, speed: 1.5 }), key)
  // 模型不同 → 不命中
  assert.notEqual(voiceCache.keyOf('你好', { ...baseOpts, model: 'm2' }), key)
  // PCM/Opus 键必须不同（编码混用会变噪声）
  assert.notEqual(voiceCache.keyOf('你好', { ...baseOpts, codec: 'pcm', bitrate: 0 }), key)

  // 旧版（无 v 字段）meta 一律作废
  const legacyKey = 'legacykey000001'
  fs.writeFileSync(path.join(dir, legacyKey + '.pcm'), Buffer.alloc(8, 1))
  fs.writeFileSync(path.join(dir, legacyKey + '.json'), JSON.stringify({ bytes: 8, rate: 24000, bits: 16, ch: 1 }))
  assert.equal(voiceCache.get(legacyKey), null, '旧 PCM 缓存必须自动失效（不混用）')

  const st = voiceCache.stats()
  assert.ok(st.opus >= 1)
  assert.ok(st.count >= 2)

  // prune 连 .opus 数据文件一起删
  assert.equal(voiceCache.prune(1), undefined)
  const left = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  assert.equal(left.length, 1, 'prune(1) 只应留最新一条 meta')
  const leftBase = left[0].replace(/\.json$/, '')
  assert.equal(fs.existsSync(path.join(dir, leftBase + '.opus')), true)

  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.DSH_VOICEPACK_DIR
})

test('cacheKeyOf：PCM 与 Opus 键不同，且编码参数进入键', () => {
  const c = { ttsEngine: 'breeze', breezeVoiceId: 'v1', breezeModel: 'm', breezeSpeed: 1, breezeGuidance: 4 }
  const pcm = cacheKeyOf('你好', c, { codec: 'pcm' })
  const opus24 = cacheKeyOf('你好', c, { codec: 'opus', bitrate: 24000, rate: 24000, frameMs: 20 })
  const opus16 = cacheKeyOf('你好', c, { codec: 'opus', bitrate: 16000, rate: 24000, frameMs: 20 })
  assert.notEqual(pcm, opus24)
  assert.notEqual(opus24, opus16, '码率变化必须换键')
})

test('待机 pong（bufMs=0 且无新增欠载）→ unknown，不误判 poor 回退 PCM', () => {
  const idle = [
    { at: 1, bufMs: 0, underruns: 9, reconnects: 4 },
    { at: 2, bufMs: 0, underruns: 9 },
    { at: 3, bufMs: 0, underruns: 9 },
  ]
  const r = classifyHealth(idle)
  assert.equal(r.tier, 'unknown')
  assert.match(r.reason, /待机|暂不降档/)
  // 真欠载（同一 buffer 里 underruns 增加）仍然判 poor
  const bad = [
    { at: 1, bufMs: 170, underruns: 1 },
    { at: 2, bufMs: 0, underruns: 5 },
  ]
  assert.equal(classifyHealth(bad).tier, 'poor')
})
