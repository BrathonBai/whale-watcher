// TTS 冒烟：真调 Breeze、真起桥、真让"设备"收 PCM。
//
// 跑：set BREEZE_API_KEY=brz_...  然后 node test/tts-smoke.mjs
// 没配 key 就跳过（不算失败）——这是唯一需要外网的测试。
//
// 为什么单列一个文件：`loop.mjs` 里 tts:false，只能验到"下行帧发出去了"，
// 验不到"设备真的收到音频字节"。2026-10-31 就是靠这条冒烟发现
// `/say` 回了 ok、日志也打了 TTS 字节数，但设备侧 0 字节的。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEY = process.env.BREEZE_API_KEY || ''
// 音色 ID 从环境变量给（不写死在仓库里）；没有就跳过。
const VOICE = process.env.BREEZE_VOICE_ID || ''
const PROXY = process.env.BREEZE_PROXY || 'http://127.0.0.1:7897'

if (!KEY || !VOICE) {
  console.log('跳过：需要 BREEZE_API_KEY + BREEZE_VOICE_ID（唯一需要外网的测试）')
  process.exit(0)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-smoke-'))
process.env.DSH_HOME = TMP
const PORT = 7810

const { apply } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pass = (m) => console.log(`  ✓ ${m}`)

const tools = new Map()
const provided = {}
const ctx = {
  tools: { register(t) { tools.set(t.name, t); return () => tools.delete(t.name) } },
  llm: {
    listProviders: () => [],
    listModels: () => [],
    async *stream() { yield { type: 'text-delta', text: '好' }; yield { type: 'finish', kind: 'completed' } },
  },
  provided,
  provide(n, s) { provided[n] = s },
  get: () => undefined,
  on() { return () => {} },
  effect(fn) { return fn() },
}

const dispose = apply(ctx, {
  host: '127.0.0.1',
  port: PORT,
  discoverPort: PORT + 1,
  brain: 'llm',
  provider: 'smoke',
  model: 'smoke',
  tts: true,
  ttsEngine: 'breeze',
  breezeApiKey: KEY,
  breezeVoiceId: VOICE,
  breezeModel: 'breeze-tts-2',
  breezeProxy: PROXY,
  breezeStream: true,
  asr: 'off',
  filler: false,
  heartbeatMs: 60000,
})
await sleep(300)

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/device`)
ws.binaryType = 'arraybuffer' // 关键：默认是 Blob，按 arraybuffer 才数得清字节
let bin = 0
let frames = 0
const frameSizes = []
const texts = []
ws.addEventListener('message', (e) => {
  if (typeof e.data === 'string') {
    try { texts.push(JSON.parse(e.data)) } catch {}
  } else {
    const n = e.data.byteLength ?? e.data.size ?? 0
    bin += n
    frames++
    frameSizes.push(n)
  }
})
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
ws.send(JSON.stringify({ t: 'hello', fw: 'hub_v2', board: 'watcher', ver: '0.2', cam: 1, w: 240, h: 240 }))
await sleep(300)

const t0 = Date.now()
const r = await fetch(`http://127.0.0.1:${PORT}/say`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '你好，我是鲸鲸。' }),
})
const body = await r.json()
assert.equal(body.ok, true, JSON.stringify(body))
assert.equal(body.sent, true, '设备在线时应下发成功')
pass(`/say ok（mood=${body.mood}）`)

for (let i = 0; i < 200; i++) {
  if (texts.some((m) => m.t === 'audio_end')) break
  await sleep(100)
}
const head = texts.find((m) => m.t === 'audio')
const end = texts.find((m) => m.t === 'audio_end')
assert.ok(head, '设备应该收到 audio 头')
assert.equal(head.rate, 24000, '设备固定 24 kHz')
assert.ok(end, '设备应该收到 audio_end')
pass(`audio 头 + audio_end 都到了（seq=${head.seq}）`)
assert.ok(bin > 10000, `设备收到的音频字节太少：${bin} B（说明 PCM 没真正下发）`)
// 2026-10-31 的教训：只数总字节不够。流式分块奇偶混排时总字节是对的，
// 但设备端按 int16 解析会整体错位 → 听感是满耳噪声。这里逐帧验。
const odd = frameSizes.filter((n) => n % 2 === 1)
assert.equal(odd.length, 0, `有 ${odd.length} 个奇数字节帧（设备会错位）：${odd.slice(0, 8).join(',')}`)
const tooBig = frameSizes.filter((n) => n > 16384)
assert.equal(tooBig.length, 0, `有超过 16 KB 的帧：${tooBig.join(',')}`)
pass(`${frames} 帧全部偶数且 ≤16 KB（最大 ${Math.max(...frameSizes)} B）`)
pass(`设备收到 ${frames} 帧 / ${bin} B（${(bin / 48000).toFixed(2)} s 音频），整体 ${Date.now() - t0} ms`)

ws.close()
dispose()
await sleep(200)
console.log('\n全部通过 ✅')
