// 真 API 集成测：假设备 ↔ 同代码的桥 ↔ 真 Breeze 流式，量"预缓冲"是否真的挡住了断粮。
//
// 跑法（需要 key）：
//   $env:BREEZE_API_KEY='...'; $env:BREEZE_VOICE_ID='...'; node test/prebuf-live.mjs
//
// 断言：audio 头 → 第一批二进制 → … → audio_end 的顺序与节奏；
//      起播后（t ≥ 100 ms，避开首个 flush 脉冲的采样毛刺）领先量 ≥ 400 ms。
//
// 为什么不是"数一数发了多少字节"：总字节对、节奏错的时候声音照样卡（同 §10 噪音的教训）。
// 这里量的是设备视角的"缓冲里还剩多少毫秒"，即 t 时刻累计音频毫秒 − 已流逝毫秒。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuf-live-'))
process.env.DSH_HOME = TMP
const PORT = 7807
const TEXT = process.argv[2] || '收到，我把客厅的灯关掉，然后给自己倒一杯温水，慢慢说。'

const { apply } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BYTES_PER_MS = 48

const ctx = {
  tools: { register: () => () => {} },
  llm: { listProviders: () => [], listModels: () => [], async *stream() { yield { type: 'finish', kind: 'completed' } } },
  provided: {},
  provide(n, s) { this.provided[n] = s },
  get: () => undefined,
  on: () => () => {},
  effect: (fn) => fn(),
}

const dispose = apply(ctx, {
  host: '127.0.0.1',
  port: PORT,
  discoverPort: PORT + 1,
  brain: 'llm',
  provider: 'x',
  model: 'x',
  tts: true,
  ttsEngine: 'breeze',
  breezeApiKey: process.env.BREEZE_API_KEY,
  breezeVoiceId: process.env.BREEZE_VOICE_ID,
  breezeModel: process.env.BREEZE_MODEL || 'breeze-tts-2',
  breezeProxy: process.env.BREEZE_PROXY || undefined,
  breezeStream: true,
  ttsPreBufferMs: 1000,
  asr: 'off',
  filler: false,
  heartbeatMs: 60000,
})
await sleep(300)

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/device`)
ws.binaryType = 'arraybuffer'
const order = []
const samples = [] // [相对首批的 ms, 累计字节]
let t0 = 0
let headAt = -1
let firstBinAt = -1
let cum = 0
let lastBinAt = -1
let maxFrame = 0
let oddFrames = 0
let maxGap = 0
let endAt = -1

ws.addEventListener('message', (e) => {
  const now = Date.now() - t0
  if (typeof e.data === 'string') {
    const m = JSON.parse(e.data)
    if (m.t === 'audio') {
      headAt = now
      order.push(`audio@${now}`)
    } else if (m.t === 'audio_end') {
      endAt = now
      order.push(`audio_end@${now}`)
    }
    return
  }
  const n = e.data.byteLength
  cum += n
  maxFrame = Math.max(maxFrame, n)
  if (n % 2) ++oddFrames
  if (firstBinAt < 0) {
    firstBinAt = now
    lastBinAt = now
  } else {
    maxGap = Math.max(maxGap, now - lastBinAt)
    lastBinAt = now
  }
  samples.push([now, cum])
})

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
ws.send(JSON.stringify({ t: 'hello', fw: 'hub_v2', board: 'watcher', ver: '0.2', cam: 1, w: 240, h: 240 }))
await sleep(300)

t0 = Date.now()
const r = await fetch(`http://127.0.0.1:${PORT}/say`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: TEXT }),
})
const body = await r.json()
if (!body.sent) throw new Error('say 没发出去: ' + JSON.stringify(body))

for (let i = 0; i < 100 && endAt < 0; ++i) await sleep(100)
await sleep(200)

const audioMs = Math.round(cum / BYTES_PER_MS)

// 设备是连续播放的：按 5 ms 时间栅格算"那一刻缓冲里还剩多少毫秒"。
// 同一毫秒内连发多帧会让逐帧采样失真（flush 脉冲），所以用栅格累计值。
function leadOnGrid() {
  let min = Infinity
  let minAt = 0
  let i = 0
  let cur = 0
  const early = []
  for (let t = 0; t <= lastBinAt - firstBinAt; t += 5) {
    while (i < samples.length && samples[i][0] - firstBinAt <= t) {
      cur = samples[i][1]
      ++i
    }
    const lead = cur / BYTES_PER_MS - t
    if (t <= 40) early.push(`${t}:${Math.round(lead)}`)
    // t < 100 ms 时 flush 脉冲还没落完，逐毫秒都可能是毛刺，不参与判定
    if (t >= 100 && lead < min) {
      min = lead
      minAt = t
    }
  }
  return { min: Math.round(min), at: minAt, early: early.join(' ') }
}
const grid = leadOnGrid()
const endLead = Math.round(cum / BYTES_PER_MS - (endAt - firstBinAt))

console.log(`音频 ${cum} B（${audioMs} ms），${order[0]}`)
console.log(`audio 头 @${headAt} ms，首批 @${firstBinAt} ms，末尾 @${endAt} ms`)
console.log(`首 40 ms 领先轨迹 ${grid.early}`)
console.log(`起播后最小领先 ${grid.min} ms（在 +${grid.at} ms），结束时领先 ${endLead} ms`)
console.log(`最大块间隔 ${maxGap} ms，最大帧 ${maxFrame} B，奇数帧 ${oddFrames} 个`)

try {
  assert.equal(order[0].startsWith('audio@'), true, 'audio 头必须是下行里的第一个音频消息')
  assert.ok(headAt <= firstBinAt, 'audio 头必须在第一批二进制之前')
  assert.ok(headAt < 2500, `audio 头来得太晚：${headAt} ms`)
  assert.equal(oddFrames, 0, '不允许奇数字节帧')
  assert.ok(maxFrame <= 16384, `帧超过 16 KB：${maxFrame}`)
  assert.ok(grid.min >= 400, `起播后领先掉到 ${grid.min} ms（应 ≥ 400）`)
  assert.ok(endAt > firstBinAt, 'audio_end 必须在音频之后')
  assert.ok(audioMs > 1500, '音频太短，测不出节奏')
  console.log('\n全部通过 ✅（预缓冲生效）')
} finally {
  ws.close()
  dispose()
}
