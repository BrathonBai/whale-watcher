// DeepSeek 官方 TTS/ASR（2026-11-13）单测：**不出网**，全部 fetch 注入 mock。
//
// 跑：node test/deepseek-speech.test.mjs
//
// 覆盖：
//   · TTS 请求 URL / Authorization / JSON body（text·voice_id·format·filter_markdown）；
//   · TTS 下行：audio 头 rate/bits/ch/bytes 正确、分块偶数且 ≤ wsFrameBytes/MTU、总量对账、audio_end；
//   · TTS 429/503 退避重试；截断（content-length 对不上）/奇数字节/超时 → 失败，半截不当成功；
//   · ASR multipart 字段 file + WAV 头 RIFF/WAVE/fmt/data、24k/16bit/mono、text/request_id 解析；
//   · ASR 429/503 退避、504 只重试一次、400 不重试、8 MiB/120 s 预检、空文本；
//   · auto 解析：有 key → deepseek，无 key → 老引擎；显式旧引擎不被 key 抢走；
//   · 本地台词包键：音色/引擎不同不复用。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEEPSEEK_ASR_PATH,
  DEEPSEEK_TTS_PATH,
  normalizeVoice,
  parseWav,
  pcmToWav,
  synthesizeDeepseek,
  transcribeDeepseek,
} from '../lib/deepseek.js'
import { cacheKeyOf, createSpeaker, pcmFrameBytes } from '../lib/speech.js'
import { createAsr } from '../lib/asr.js'
import { DEFAULTS, asrModeOf, deepseekApiKeyOf, deepseekBaseUrlOf, ttsEngineOf } from '../lib/config.js'
import { ttsConfigured } from '../lib/http.js'

// ---------------- 环境隔离：不依赖宿主是否配了真 key，测试里改的 env 也不外泄 ----------------
const ENV_KEY = 'DEEPSEEK_API_KEY'
const ENV_BASE = 'DEEPSEEK_BASE_URL'
const savedEnv = { key: process.env[ENV_KEY], base: process.env[ENV_BASE] }
delete process.env[ENV_KEY]
delete process.env[ENV_BASE]

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-speech-'))
after(() => {
  if (savedEnv.key === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv.key
  if (savedEnv.base === undefined) delete process.env[ENV_BASE]
  else process.env[ENV_BASE] = savedEnv.base
  if (process.env.DSH_VOICEPACK_DIR) {
    try {
      fs.rmSync(process.env.DSH_VOICEPACK_DIR, { recursive: true, force: true })
    } catch {}
  }
  delete process.env.DSH_VOICEPACK_DIR
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {}
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 收集日志：断言"带 request_id、不带 key"。 */
function makeLog() {
  const lines = []
  return {
    lines,
    info: (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    warn: (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
  }
}

/** 24 kHz/16 bit/mono 测试 PCM（正弦，能听出是"有内容"的）。 */
function makePcm(samples = 4800, amp = 8000) {
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amp * Math.sin((i / 24000) * 2 * Math.PI * 440)), i * 2)
  }
  return buf
}

function ttsResponse(pcm, { status = 200, headers = {} } = {}) {
  return new Response(pcm, {
    status,
    headers: { 'content-type': 'application/octet-stream', 'x-request-id': 'req-tts-1', ...headers },
  })
}

function jsonResponse(obj, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** fetch 记录器：handler 返回 Response（或抛错）。 */
function recordFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(url, init, calls.length)
  }
  return { calls, fetchImpl }
}

/** 假设备：只记录 audio 头/二进制/audio_end，够 speech.js 的 PCM 下发路径用。 */
function fakeDevice({ codecs = [], mtu = 0, transport = 'wifi' } = {}) {
  const events = []
  const device = {
    online: true,
    codecs,
    mtu,
    transport,
    pongHistory: [],
    pongAgeMs: null,
    connectedMs: 1000,
    lastDiag: null,
    lastPongAt: null,
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
      return true
    },
  }
  return { device, events }
}

async function waitIdle(speaker, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!speaker.busy && speaker.pending === 0) return
    await sleep(5)
  }
  throw new Error('speaker 没在超时内跑完')
}

function writeWav(name, pcm, rate = 24000) {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, pcmToWav(pcm, { rate }))
  return p
}

const tmpVoicepack = () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'voicepack-'))
  process.env.DSH_VOICEPACK_DIR = dir
  return dir
}

// ============================ TTS 请求形状 ============================

test('TTS 请求：URL / Bearer / JSON body（text·voice_id·format·filter_markdown）', async () => {
  const pcm = makePcm(480) // 20 ms
  const log = makeLog()
  const { calls, fetchImpl } = recordFetch(() => ttsResponse(pcm))
  const r = await synthesizeDeepseek('你好，鲸鲸。', {
    apiKey: 'sk-test-123',
    baseUrl: 'https://api.deepseek.com/',
    voice: 'tide',
    fetchImpl,
    log,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://api.deepseek.com${DEEPSEEK_TTS_PATH}`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-123')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: '你好，鲸鲸。',
    voice_id: 'tide',
    format: 'pcm',
    filter_markdown: true,
  })

  assert.equal(r.rate, 24000)
  assert.equal(r.bits, 16)
  assert.equal(r.channels, 1)
  assert.equal(r.bytes, pcm.length)
  assert.deepEqual(r.pcm, pcm)
  assert.equal(r.ms, 20)
  assert.equal(r.requestId, 'req-tts-1')
  assert.equal(r.attempts, 1)

  // 日志纪律：带 request_id / 字符数 / 音频时长；绝不带 key。
  const joined = log.lines.join('\n')
  assert.match(joined, /req-tts-1/)
  assert.match(joined, /6 字/)
  assert.ok(!joined.includes('sk-test-123'), '日志不能打印 API key')
})

test('TTS 音色：stella/tide 原样；老 edge 音色名回退 stella；非法值不炸', async () => {
  assert.equal(normalizeVoice('stella'), 'stella')
  assert.equal(normalizeVoice('TIDE'), 'tide')
  assert.equal(normalizeVoice('zh-CN-XiaoxiaoNeural'), 'stella')
  assert.equal(normalizeVoice(''), 'stella')
  assert.equal(normalizeVoice(undefined), 'stella')

  // 显式 tide 进 body
  const { calls, fetchImpl } = recordFetch(() => ttsResponse(makePcm(480)))
  await synthesizeDeepseek('你好', { apiKey: 'sk', voice: 'tide', fetchImpl })
  assert.equal(JSON.parse(calls[0].init.body).voice_id, 'tide')

  // 不传 voice → 默认 stella
  const rec2 = recordFetch(() => ttsResponse(makePcm(480)))
  await synthesizeDeepseek('你好', { apiKey: 'sk', fetchImpl: rec2.fetchImpl })
  assert.equal(JSON.parse(rec2.calls[0].init.body).voice_id, 'stella')
})

// ============================ TTS 重试 / 失败路径 ============================

test('TTS 429：按 retry-after 退避后重试成功', async () => {
  const pcm = makePcm(960)
  const sleeps = []
  const { calls, fetchImpl } = recordFetch((url, init, n) => {
    if (n === 1) return new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'retry-after': '1' } })
    return ttsResponse(pcm)
  })
  const r = await synthesizeDeepseek('你好', {
    apiKey: 'sk',
    fetchImpl,
    maxRetries: 2,
    backoffMs: 100,
    sleepImpl: async (ms) => sleeps.push(ms),
  })
  assert.equal(calls.length, 2, '429 应重试一次后成功')
  assert.deepEqual(sleeps, [1000], '优先按 retry-after 退避')
  assert.equal(r.attempts, 2)
  assert.deepEqual(r.pcm, pcm)
})

test('TTS 503：重试到上限后仍失败（不会把错误响应当音频）', async () => {
  const { calls, fetchImpl } = recordFetch(
    () => new Response('{"error":{"message":"busy"}}', { status: 503, headers: { 'retry-after': '0' } }),
  )
  await assert.rejects(
    synthesizeDeepseek('你好', { apiKey: 'sk', fetchImpl, maxRetries: 1 }),
    (e) => {
      assert.equal(e.name, 'DeepSeekError')
      assert.equal(e.status, 503)
      assert.equal(e.code, 'HTTP_503')
      assert.match(e.message, /服务忙/)
      return true
    },
  )
  assert.equal(calls.length, 2, 'maxRetries=1 → 共 2 次尝试')
})

test('TTS 截断：content-length 对不上 / 奇数字节 PCM → 报错（半截绝不当成功）', async () => {
  // 声明 960 B，实际只给 480 B → 截断
  const truncated = recordFetch(
    () => new Response(Buffer.alloc(480), { status: 200, headers: { 'content-length': '960' } }),
  )
  await assert.rejects(
    synthesizeDeepseek('你好', { apiKey: 'sk', fetchImpl: truncated.fetchImpl, maxRetries: 0 }),
    (e) => {
      assert.equal(e.code, 'TRUNCATED')
      assert.match(e.message, /截断/)
      return true
    },
  )

  // 16 bit 采样被砍成奇数字节 → 截断
  const odd = recordFetch(
    () => new Response(Buffer.alloc(481), { status: 200, headers: { 'content-length': '481' } }),
  )
  await assert.rejects(
    synthesizeDeepseek('你好', { apiKey: 'sk', fetchImpl: odd.fetchImpl, maxRetries: 0 }),
    (e) => {
      assert.equal(e.code, 'ODD_PCM')
      assert.match(e.message, /奇数/)
      return true
    },
  )
})

test('TTS 超时 / 网络错误 / 4xx：显式失败且错误信息可读', async () => {
  const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  await assert.rejects(
    synthesizeDeepseek('你好', { apiKey: 'sk', fetchImpl: async () => { throw timeoutErr }, maxRetries: 0 }),
    (e) => {
      assert.equal(e.code, 'TIMEOUT')
      assert.equal(e.retryable, true)
      return true
    },
  )

  const http400 = recordFetch(() => new Response('{"error":{"message":"bad voice_id"}}', { status: 400 }))
  await assert.rejects(
    synthesizeDeepseek('你好', { apiKey: 'sk', fetchImpl: http400.fetchImpl, maxRetries: 2 }),
    (e) => {
      assert.equal(e.code, 'HTTP_400')
      assert.match(e.message, /bad voice_id/)
      return true
    },
  )
  assert.equal(http400.calls.length, 1, '400 不重试')

  await assert.rejects(
    synthesizeDeepseek('你好', { apiKey: '', fetchImpl: async () => ttsResponse(Buffer.alloc(2)), maxRetries: 0 }),
    (e) => {
      assert.equal(e.code, 'NO_API_KEY')
      assert.match(e.message, /deepseekApiKey/)
      return true
    },
  )
})

// ============================ TTS 下行（speech.js） ============================

const deepseekCfg = (extra = {}) => ({
  get: () => ({
    tts: true,
    ttsEngine: 'deepseek',
    deepseekApiKey: 'sk-test',
    ttsVoice: 'stella',
    ttsPreBufferMs: 0,
    wsFrameBytes: 1024,
    audioCodec: 'pcm',
    audioAdaptive: false,
    opusBitrate: 16000,
    opusFrameMs: 20,
    ttsFfmpeg: 'ffmpeg',
    maxReplyChars: 240,
    ...extra,
  }),
})

test('TTS 下行：audio 头 rate=24000/bits=16/ch=1/bytes 总长，分块偶数字节且总量对账，audio_end 收尾', async () => {
  tmpVoicepack()
  const pcm = makePcm(4800) // 0.2 s → 9600 B
  const { device, events } = fakeDevice()
  const { calls, fetchImpl } = recordFetch(() => ttsResponse(pcm))
  const speaker = createSpeaker({ cfg: deepseekCfg(), log: makeLog(), device, fetchImpl })

  speaker.speak('你好，鲸鲸。')
  await waitIdle(speaker)

  const heads = events.filter((e) => e.kind === 'head')
  assert.equal(heads.length, 1, 'DeepSeek 整段一次合成 → 只发 1 个 audio 头')
  const head = heads[0].info
  assert.equal(head.codec, 'pcm', 'DeepSeek 路径固定 pcm')
  assert.equal(head.rate, 24000)
  assert.equal(head.bits, 16)
  assert.equal(head.ch, 1)
  assert.equal(head.bytes, pcm.length, 'audio 头必须带总字节数')

  const bins = events.filter((e) => e.kind === 'bin').map((e) => e.buf)
  assert.ok(bins.length >= 2, '应分成多帧下发')
  for (const b of bins) {
    assert.equal(b.length % 2, 0, `下行帧必须偶数：${b.length}`)
    assert.ok(b.length <= 1024, `帧不能超过 wsFrameBytes：${b.length}`)
  }
  const sent = Buffer.concat(bins)
  assert.deepEqual(sent, pcm, '拼回去必须与原 PCM 逐字节一致')
  assert.equal(sent.length, head.bytes, '实发字节数必须与 audio 头对账')

  const ends = events.filter((e) => e.kind === 'end')
  assert.equal(ends.length, 1, '必须有且只有一个 audio_end')
  assert.equal(ends[0].seq, heads[0].info.seq, 'audio_end 的 seq 与头一致')
  assert.equal(calls.length, 1)

  // 第二遍：本地台词包命中 → 不再出网（计费只花一次）
  speaker.speak('你好，鲸鲸。')
  await waitIdle(speaker)
  assert.equal(calls.length, 1, '同一句第二次应命中本地台词包，不再调 DeepSeek')
  assert.equal(events.filter((e) => e.kind === 'head').length, 2)
  assert.equal(events.filter((e) => e.kind === 'end').length, 2)
})

test('TTS 下行：协商成 adpcm/opus 也强制 pcm（BLE 按 MTU 收窄帧），diag 如实显示 pcm', async () => {
  tmpVoicepack()
  const pcm = makePcm(4800) // 9600 B
  const { device, events } = fakeDevice({ codecs: ['pcm', 'adpcm'], transport: 'ble', mtu: 247 })
  const { fetchImpl } = recordFetch(() => ttsResponse(pcm))
  const speaker = createSpeaker({
    cfg: deepseekCfg({ audioCodec: 'adpcm', wsFrameBytes: 4096 }),
    log: makeLog(),
    device,
    fetchImpl,
  })
  speaker.speak('测试')
  await waitIdle(speaker)

  const head = events.find((e) => e.kind === 'head').info
  assert.equal(head.codec, 'pcm', 'DeepSeek 只出 pcm：协商成 adpcm 也不能按 adpcm 发')
  assert.equal(head.bytes, pcm.length)
  const bins = events.filter((e) => e.kind === 'bin').map((e) => e.buf)
  for (const b of bins) {
    assert.equal(b.length % 2, 0)
    assert.ok(b.length <= 244, `BLE MTU=247 → 单帧 ≤ MTU-3：${b.length}`)
  }
  assert.equal(Buffer.concat(bins).length, pcm.length)
  const ast = speaker.audioState()
  assert.equal(ast.effective, 'pcm', 'diag 不能谎报 adpcm')
  assert.match(ast.lastFallback?.reason ?? '', /DeepSeek/)
})

test('TTS 下行：合成失败 → 不发 audio 头/audio_end，engineError 可读', async () => {
  tmpVoicepack()
  const { device, events } = fakeDevice()
  const { fetchImpl } = recordFetch(() => new Response('{"error":{"message":"synthesis failed"}}', { status: 500 }))
  const speaker = createSpeaker({ cfg: deepseekCfg(), log: makeLog(), device, fetchImpl })
  speaker.speak('这句会失败')
  await waitIdle(speaker)

  assert.equal(events.filter((e) => e.kind === 'head').length, 0, '失败时一个 audio 头都不能发')
  assert.equal(events.filter((e) => e.kind === 'end').length, 0)
  assert.match(speaker.engineError, /DeepSeek TTS HTTP 500/)
})

test('pcmFrameBytes：wsFrameBytes 上限 / 16 KB 封顶 / BLE MTU 收窄 / 永远偶数', () => {
  assert.equal(pcmFrameBytes({ wsFrameBytes: 4096 }, {}), 4096)
  assert.equal(pcmFrameBytes({ wsFrameBytes: 4095 }, {}), 4094)
  assert.equal(pcmFrameBytes({ wsFrameBytes: 999999 }, {}), 16384)
  assert.equal(pcmFrameBytes({}, {}), 4096)
  assert.equal(pcmFrameBytes({ wsFrameBytes: 4096 }, { transport: 'ble', mtu: 247 }), 244)
  assert.equal(pcmFrameBytes({ wsFrameBytes: 4096 }, { transport: 'wifi', mtu: 247 }), 4096, 'WiFi 不受 BLE MTU 影响')
})

// ============================ ASR（multipart / WAV） ============================

async function inspectAsrForm(calls) {
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, `https://api.deepseek.com${DEEPSEEK_ASR_PATH}`)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer sk-test')
  assert.equal(init.headers['content-type'], undefined, 'content-type 必须交给 fetch/FormData 自动加 boundary')
  assert.ok(init.body instanceof FormData, 'body 必须是 multipart FormData')
  const entries = [...init.body.entries()]
  assert.equal(entries.length, 1)
  assert.equal(entries[0][0], 'file', 'multipart 字段名必须是 file')
  const file = entries[0][1]
  assert.equal(file.type, 'audio/wav')
  assert.match(file.name, /\.wav$/)
  return Buffer.from(await file.arrayBuffer())
}

test('ASR：multipart 有 file，WAV 头 RIFF/WAVE/fmt/data 正确且 24k/16bit/mono，解析 text/request_id', async () => {
  const pcm = makePcm(4800) // 0.2 s
  const wavPath = writeWav('voice-up.wav', pcm)
  const log = makeLog()
  const { calls, fetchImpl } = recordFetch(() =>
    jsonResponse({ request_id: 'req-asr-1', text: '  你好鲸鲸  ', duration_ms: 200 }),
  )

  const r = await transcribeDeepseek(wavPath, { apiKey: 'sk-test', fetchImpl, log })

  const uploaded = await inspectAsrForm(calls)
  assert.equal(uploaded.toString('ascii', 0, 4), 'RIFF')
  assert.equal(uploaded.toString('ascii', 8, 12), 'WAVE')
  assert.equal(uploaded.toString('ascii', 12, 16), 'fmt ')
  assert.equal(uploaded.toString('ascii', 36, 40), 'data')
  const wav = parseWav(uploaded)
  assert.equal(wav.format, 1)
  assert.equal(wav.channels, 1)
  assert.equal(wav.rate, 24000)
  assert.equal(wav.bits, 16)
  assert.equal(wav.dataBytes, pcm.length, '上传的 WAV data 必须就是设备上行 PCM')
  assert.deepEqual(Buffer.from(wav.pcm), pcm)

  assert.equal(r.text, '你好鲸鲸', '响应 text 要 trim 后返回')
  assert.equal(r.requestId, 'req-asr-1')
  assert.equal(r.durationMs, 200)

  const joined = log.lines.join('\n')
  assert.match(joined, /req-asr-1/)
  assert.ok(!joined.includes('sk-test'), '日志不能打印 API key')
})

test('ASR：直接给裸 PCM 时补 44 字节 WAV 头（rate 24000 / 16bit / mono）', async () => {
  const pcm = makePcm(2400) // 0.1 s
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ request_id: 'r2', text: '收到', duration_ms: 100 }))
  const r = await transcribeDeepseek({ pcm, rate: 24000 }, { apiKey: 'sk-test', fetchImpl })
  const uploaded = await inspectAsrForm(calls)
  assert.equal(uploaded.length, 44 + pcm.length, '必须正好是 44 B 头 + PCM')
  const wav = parseWav(uploaded)
  assert.equal(wav.rate, 24000)
  assert.equal(wav.bits, 16)
  assert.equal(wav.channels, 1)
  assert.equal(r.text, '收到')
})

test('ASR 错误码：429/503 退避重试，504 只重试一次，400 不重试且说明原因', async () => {
  const wavPath = writeWav('voice-err.wav', makePcm(480))

  // 429 → 重试后成功
  const rec429 = recordFetch((url, init, n) =>
    n === 1 ? new Response('{"error":{"message":"concurrency"}}', { status: 429, headers: { 'retry-after': '0' } }) : jsonResponse({ request_id: 'r429', text: '好了' }),
  )
  const ok = await transcribeDeepseek(wavPath, { apiKey: 'sk', fetchImpl: rec429.fetchImpl, maxRetries: 2, backoffMs: 10 })
  assert.equal(rec429.calls.length, 2)
  assert.equal(ok.text, '好了')

  // 503 → 重试后成功
  const rec503 = recordFetch((url, init, n) =>
    n === 1 ? new Response('busy', { status: 503, headers: { 'retry-after': '0' } }) : jsonResponse({ request_id: 'r503', text: '也行' }),
  )
  const ok2 = await transcribeDeepseek(wavPath, { apiKey: 'sk', fetchImpl: rec503.fetchImpl, maxRetries: 2, backoffMs: 10 })
  assert.equal(rec503.calls.length, 2)
  assert.equal(ok2.text, '也行')

  // 504 → 只额外重试一次（maxRetries 给 5 也不放大）
  const rec504 = recordFetch(() => new Response('recognize timeout', { status: 504, headers: { 'retry-after': '0' } }))
  await assert.rejects(
    transcribeDeepseek(wavPath, { apiKey: 'sk', fetchImpl: rec504.fetchImpl, maxRetries: 5, backoffMs: 1 }),
    (e) => {
      assert.equal(e.status, 504)
      assert.match(e.message, /识别\/合成超时/)
      return true
    },
  )
  assert.equal(rec504.calls.length, 2, '504 只重试一次（首次 + 1）')

  // 400 → 不重试
  const rec400 = recordFetch(() => new Response('{"error":{"message":"bad format"}}', { status: 400 }))
  await assert.rejects(
    transcribeDeepseek(wavPath, { apiKey: 'sk', fetchImpl: rec400.fetchImpl, maxRetries: 3 }),
    (e) => {
      assert.equal(e.status, 400)
      assert.match(e.message, /bad format/)
      return true
    },
  )
  assert.equal(rec400.calls.length, 1, '400 不重试')
})

test('ASR 预检：WAV 超过 8 MiB / 超过 120 s 直接报错（不上传、不浪费一次 413）', async () => {
  const tooBig = writeWav('voice-big.wav', Buffer.alloc(8 * 1024 * 1024)) // WAV = 8 MiB + 44 B
  const { calls, fetchImpl } = recordFetch(() => jsonResponse({ text: '不该到这儿' }))
  await assert.rejects(
    transcribeDeepseek(tooBig, { apiKey: 'sk', fetchImpl }),
    (e) => {
      assert.equal(e.code, 'TOO_LARGE')
      assert.match(e.message, /8 MiB/)
      return true
    },
  )
  assert.equal(calls.length, 0, '超限必须在本地拦住，不上传')

  // 121 s @ 8 kHz = 1.9 MB（<8 MiB，专门测时长上限）
  const longPcm = Buffer.alloc(121 * 8000 * 2)
  const tooLong = writeWav('voice-long.wav', longPcm, 8000)
  const rec2 = recordFetch(() => jsonResponse({ text: '不该到这儿' }))
  await assert.rejects(
    transcribeDeepseek(tooLong, { apiKey: 'sk', fetchImpl: rec2.fetchImpl }),
    (e) => {
      assert.equal(e.code, 'TOO_LONG')
      assert.match(e.message, /120 s/)
      return true
    },
  )
  assert.equal(rec2.calls.length, 0)
})

test('ASR 空文本：显式报错（带 request_id），asr 路由写进 lastReason', async () => {
  const wavPath = writeWav('voice-empty.wav', makePcm(480))
  const rec = recordFetch(() => jsonResponse({ request_id: 'req-empty', text: '   ', duration_ms: 0 }))
  await assert.rejects(
    transcribeDeepseek(wavPath, { apiKey: 'sk', fetchImpl: rec.fetchImpl }),
    (e) => {
      assert.equal(e.code, 'EMPTY_TEXT')
      assert.match(e.message, /req-empty/)
      assert.match(e.message, /空文本/)
      return true
    },
  )

  // 接到 asr.js：显式 asr=deepseek 时失败不静默换引擎，lastReason 说清原因
  const asrLog = makeLog()
  const asr = createAsr({
    cfg: {
      get: () => ({
        asr: 'deepseek',
        deepseekApiKey: 'sk-test',
        deepseekBaseUrl: 'https://api.deepseek.com',
        deepseekTimeoutMs: 5000,
        deepseekMaxRetries: 0,
        deepseekRetryBackoffMs: 1,
      }),
    },
    log: asrLog,
    dsh: null,
    fetchImpl: rec.fetchImpl,
  })
  const out = await asr.transcribe(wavPath)
  assert.equal(out.route, 'none')
  assert.equal(out.text, '')
  assert.match(asr.lastReason, /DeepSeek ASR/)
  assert.match(asr.lastReason, /空文本/)
})

// ============================ ASR 接入（asr.js 路由） ============================

test('ASR 路由：auto + 有 key → route=deepseek；显式 asr=deepseek 也只走它', async () => {
  const wavPath = writeWav('voice-route.wav', makePcm(960))
  const fetchImpl = async () =>
    jsonResponse({ request_id: 'req-route', text: '今天天气不错', duration_ms: 120 })

  for (const asrMode of ['auto', 'deepseek']) {
    const log = makeLog()
    const asr = createAsr({
      cfg: {
        get: () => ({
          asr: asrMode,
          deepseekApiKey: 'sk-test',
          deepseekBaseUrl: 'https://api.deepseek.com',
          deepseekTimeoutMs: 5000,
          deepseekMaxRetries: 0,
          deepseekRetryBackoffMs: 1,
        }),
      },
      log,
      dsh: null,
      fetchImpl,
    })
    const r = await asr.transcribe(wavPath)
    assert.equal(r.route, 'deepseek', `asr=${asrMode} + key 应走 DeepSeek`)
    assert.equal(r.text, '今天天气不错')
    assert.equal(asr.lastReason, '')
  }
})

test('ASR 路由：没 key 时 asr=auto 保持老链路（route=none 且原因可读）', async () => {
  const wavPath = writeWav('voice-legacy.wav', makePcm(480))
  const asrLog = makeLog()
  const fetches = []
  const asr = createAsr({
    cfg: { get: () => ({ asr: 'auto', asrCommand: '', asrServerCommand: '' }) },
    log: asrLog,
    dsh: null,
    fetchImpl: async (...a) => {
      fetches.push(a)
      throw new Error('没 key 时不该出网')
    },
  })
  const r = await asr.transcribe(wavPath)
  assert.equal(r.route, 'none')
  assert.equal(r.text, '')
  assert.match(asr.lastReason, /asrServerCommand/)
  assert.equal(fetches.length, 0, '没有 key 时不能偷偷打 DeepSeek')
})

test('ASR 路由：设备上行 PCM 直通（补 44 B WAV 头后上传），不用盘上旧 WAV 内容', async () => {
  const upPcm = makePcm(2400) // 0.1 s：本次上行
  // 盘上的 WAV 故意写成另一段内容：必须证明上传的是 extra.pcm，而不是重读文件。
  const wavPath = writeWav('voice-direct.wav', Buffer.alloc(960))
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ request_id: 'r-direct', text: '直通', duration_ms: 100 })
  }
  const asr = createAsr({
    cfg: {
      get: () => ({
        asr: 'deepseek',
        deepseekApiKey: 'sk-test',
        deepseekBaseUrl: 'https://api.deepseek.com',
        deepseekTimeoutMs: 1000,
        deepseekMaxRetries: 0,
        deepseekRetryBackoffMs: 1,
      }),
    },
    log: makeLog(),
    dsh: null,
    fetchImpl,
  })
  const r = await asr.transcribe(wavPath, { pcm: upPcm, rate: 24000 })
  assert.equal(r.route, 'deepseek')
  assert.equal(r.text, '直通')
  assert.equal(calls.length, 1)
  const file = [...calls[0].init.body.entries()][0][1]
  const uploaded = Buffer.from(await file.arrayBuffer())
  assert.equal(uploaded.length, 44 + upPcm.length, '必须 44 B 头 + 本次上行 PCM')
  assert.deepEqual(Buffer.from(parseWav(uploaded).pcm), upPcm)
})

// ============================ 配置解析 / 台词包键 ============================

test('配置解析：有 key 默认 DeepSeek，无 key 回退老引擎；显式值优先；环境变量兜底', () => {
  // DEFAULTS 形状
  assert.equal(DEFAULTS.ttsEngine, 'auto')
  assert.equal(DEFAULTS.asr, 'auto')
  assert.equal(DEFAULTS.deepseekBaseUrl, 'https://api.deepseek.com')
  assert.ok(Object.prototype.hasOwnProperty.call(DEFAULTS, 'deepseekApiKey'))
  for (const k of ['deepseekTimeoutMs', 'deepseekMaxRetries', 'deepseekRetryBackoffMs']) {
    assert.ok(Object.prototype.hasOwnProperty.call(DEFAULTS, k), `DEFAULTS 缺 ${k}`)
  }

  // 无 key：auto → 老引擎（edge）/ 老 ASR 链路
  assert.equal(deepseekApiKeyOf(''), '')
  assert.equal(deepseekBaseUrlOf(''), 'https://api.deepseek.com')
  assert.equal(ttsEngineOf({ ttsEngine: 'auto' }), 'edge')
  assert.equal(asrModeOf({ asr: 'auto' }), 'auto')
  assert.equal(ttsConfigured({ ttsEngine: 'auto' }), true, '无 key 的 auto 回退 edge，仍算配置好')
  assert.equal(ttsConfigured({ ttsEngine: 'deepseek' }), false, '显式 deepseek 但没 key → 没配好')

  try {
    process.env[ENV_KEY] = 'sk-env-test'
    process.env[ENV_BASE] = 'http://127.0.0.1:9999/'
    assert.equal(deepseekApiKeyOf(''), 'sk-env-test', '环境变量 DEEPSEEK_API_KEY 兜底')
    assert.equal(deepseekApiKeyOf('sk-config'), 'sk-config', '配置层优先于环境变量')
    assert.equal(ttsEngineOf({ ttsEngine: 'auto' }), 'deepseek', '有 key 时 auto 默认 DeepSeek')
    assert.equal(asrModeOf({ asr: 'auto' }), 'deepseek')
    assert.equal(ttsEngineOf({ ttsEngine: 'edge' }), 'edge', '显式 edge 不被 key 抢走（强制回退老引擎）')
    assert.equal(ttsEngineOf({ ttsEngine: 'sapi', deepseekApiKey: '' }), 'sapi')
    assert.equal(asrModeOf({ asr: 'dsh' }), 'dsh', '显式 dsh 不被 key 抢走')
    assert.equal(deepseekBaseUrlOf(''), 'http://127.0.0.1:9999')
    assert.equal(deepseekBaseUrlOf('https://api.deepseek.com/'), 'https://api.deepseek.com', '尾部斜杠要去掉')
    assert.equal(ttsConfigured({ ttsEngine: 'deepseek', deepseekApiKey: '' }), true, '环境变量里的 key 也算配置好')
  } finally {
    delete process.env[ENV_KEY]
    delete process.env[ENV_BASE]
  }
})

test('台词包键：DeepSeek 音色/引擎不同不复用；auto 解析后与显式 deepseek 同键', () => {
  const base = { ttsEngine: 'deepseek', deepseekApiKey: 'sk-test', ttsVoice: 'stella' }
  const kStella = cacheKeyOf('你好', base, { codec: 'pcm' })
  const kTide = cacheKeyOf('你好', { ...base, ttsVoice: 'tide' }, { codec: 'pcm' })
  assert.notEqual(kStella, kTide, '换音色必须换键')

  const kAuto = cacheKeyOf('你好', { ttsEngine: 'auto', deepseekApiKey: 'sk-test' }, { codec: 'pcm' })
  assert.equal(kAuto, kStella, 'auto 解析成 deepseek 后应与显式 deepseek 同键')

  const kEdge = cacheKeyOf('你好', { ttsEngine: 'edge', ttsVoice: 'stella' }, { codec: 'pcm' })
  assert.notEqual(kEdge, kStella, '换引擎必须换键（别把 edge 的音频当 DeepSeek 的）')
})
