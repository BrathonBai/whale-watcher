// 端到端：假设备（真 WebSocket）↔ 真桥 ↔ 假 DSH 宿主。
//
// 跑：node test/loop.mjs
//
// 覆盖的是 v2 契约的全链路：
//   hello → welcome/face；/say；/api/face；/shot 下发 → 设备回 image → 落盘；
//   voice 上行 → WAV →（asr=off）显式说"没听清"；/listen 与 /mic 返回 501。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'embodied-loop-'))
process.env.DSH_HOME = TMP
const PORT = 7806

const { apply } = await import('../lib/index.js')
const { UPLINK, DOWNLINK } = await import('../lib/contract.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pass = (m) => console.log(`  ✓ ${m}`)

function makeHost() {
  const tools = new Map()
  const listeners = new Map()
  return {
    ctx: {
      tools: { register(t) { tools.set(t.name, t); return () => tools.delete(t.name) } },
      llm: {
        listProviders: () => [],
        listModels: () => [],
        async *stream() {
          yield { type: 'text-delta', text: '晚上好呀。' }
          yield { type: 'finish', kind: 'completed' }
        },
      },
      provided: {},
      provide(n, s) { this.provided[n] = s },
      get: () => undefined,
      on(ev, fn) { listeners.set(ev, fn); return () => listeners.delete(ev) },
      effect(fn) { return fn() },
    },
    tools,
    listeners,
  }
}

function openDevice() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/device`)
  ws.binaryType = 'arraybuffer'
  const inbox = []
  const waiters = []
  const binaries = []
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') {
      binaries.push(e.data.byteLength)
      return
    }
    let m
    try { m = JSON.parse(e.data) } catch { return }
    inbox.push(m)
    for (let i = waiters.length - 1; i >= 0; --i) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1) }
    }
  })
  return {
    ws,
    binaries,
    open: () => new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    binary: (buf) => ws.send(buf),
    clear: () => { inbox.length = 0 },
    waitFor: (pred, ms = 3000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred)
      if (hit) return resolve(hit)
      const t = setTimeout(() => reject(new Error('超时：' + pred)), ms)
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m) } })
    }),
  }
}

// ---------------- 起桥 ----------------
const { ctx, tools } = makeHost()
const dispose = apply(ctx, {
  host: '127.0.0.1',
  port: PORT,
  discoverPort: PORT + 1,
  brain: 'llm',
  provider: 'loop',
  model: 'loop-1',
  tts: false,          // 不出声，只看下行帧
  asr: 'off',          // 识别关掉：验证"显式说没听清"
  filler: false,
  heartbeatMs: 60000,
})
await sleep(300)

try {
  const base = `http://127.0.0.1:${PORT}`
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    return { code: r.status, body: await r.json().catch(() => ({})) }
  }

  console.log('1) 握手')
  const dev = openDevice()
  await dev.open()
  dev.send({ t: 'hello', fw: 'hub_v2', board: 'watcher', ver: '0.2', cam: 1, w: 240, h: 240 })
  const welcome = await dev.waitFor((m) => m.t === 'welcome')
  assert.equal(welcome.ver, 2)
  await dev.waitFor((m) => m.t === 'face' && m.mood === 'idle')
  const svc = ctx.provided.embodied
  assert.equal(svc.status().online, true)
  assert.equal(svc.status().version.ver, '0.2', 'hello.ver 必须原样保留为字符串')
  pass('welcome / face idle / 在线状态都对，ver="0.2"')

  console.log('2) 说话（HTTP /say → 设备收 say）')
  dev.clear()
  const said = await post('/say', { text: '你好' })
  assert.equal(said.code, 200)
  assert.equal(said.body.sent, true)
  const sayFrame = await dev.waitFor((m) => m.t === 'say')
  assert.equal(sayFrame.text, '你好')
  pass(`say 下发：${sayFrame.text}（mood=${sayFrame.mood}）`)

  console.log('3) 表情')
  dev.clear()
  const f = await post('/api/face', { mood: 'happy' })
  assert.equal(f.body.ok, true)
  await dev.waitFor((m) => m.t === 'face' && m.mood === 'happy')
  pass('face happy 下发')

  console.log('4) 按需拍照：shot → image → 落盘')
  const shotP = post('/shot', { timeoutMs: 5000 })
  const shot = await dev.waitFor((m) => m.t === 'shot')
  assert.equal(shot.t, 'shot')
  const jpg = Buffer.alloc(1200, 0x11)
  jpg[0] = 0xff
  jpg[1] = 0xd8
  jpg[jpg.length - 1] = 0xd9
  dev.send({ t: 'image', bytes: jpg.length, w: 240, h: 240, seq: 1 })
  await sleep(30)
  dev.binary(new Uint8Array(jpg))
  const shotRes = await shotP
  assert.equal(shotRes.code, 200, JSON.stringify(shotRes.body))
  assert.equal(shotRes.body.ok, true)
  assert.ok(fs.existsSync(shotRes.body.path), '照片应该落盘')
  assert.equal(shotRes.body.w, 240)
  pass(`拍到 ${shotRes.body.bytes} B → ${shotRes.body.path}`)

  console.log('4b) 链路自检：灌 1 s 静音（不碰 TTS）')
  dev.clear()
  dev.binaries.length = 0
  const lt = await post('/api/linktest?seconds=1')
  assert.equal(lt.code, 200, JSON.stringify(lt.body))
  assert.ok(lt.body.bytes >= 48000, `应灌入 1 s 静音：${lt.body.bytes} B`)
  await dev.waitFor((m) => m.t === 'audio')
  await dev.waitFor((m) => m.t === 'audio_end', 5000)
  const binTotal = dev.binaries.reduce((a, b) => a + b, 0)
  assert.equal(binTotal, lt.body.bytes, `二进制合计必须等于声明：${binTotal} vs ${lt.body.bytes}`)
  assert.ok(dev.binaries.every((n) => n % 2 === 0), '每帧都必须是偶数字节')
  pass(`静音 ${lt.body.seconds} s / ${lt.body.bytes} B / ${dev.binaries.length} 帧，写入 ${lt.body.writeMs} ms`)

  console.log('5) 语音上行（asr=off → 必须显式说没听清）')
  dev.clear()
  const pcm = Buffer.alloc(24000, 0) // 0.5 s 静音
  dev.send({ t: 'voice', bytes: pcm.length, rate: 24000, seq: 2 })
  await sleep(30)
  dev.binary(new Uint8Array(pcm))
  const hint = await dev.waitFor((m) => m.t === 'say' && /没听清/.test(m.text), 6000)
  assert.ok(hint)
  const voiceDir = path.join(TMP, 'plugins-data', 'embodied-bridge', 'voice')
  const voiceFiles = fs.readdirSync(voiceDir).filter((x) => x.endsWith('.wav'))
  assert.ok(voiceFiles.length >= 1, 'WAV 应该落盘')
  pass(`voice → WAV（${voiceFiles.length} 个）+ 显式提示「${hint.text}」`)

  console.log('6) v2 做不到的接口要 501 说清楚，不是 404')
  const listen = await post('/listen?seconds=1')
  assert.equal(listen.code, 501)
  assert.equal(listen.body.error.code, 'UNSUPPORTED')
  const mic = await post('/mic', { auto: true })
  assert.equal(mic.code, 501)
  pass(' /listen、/mic → 501 UNSUPPORTED（带原因）')

  console.log('7) /health 如实报告能力边界')
  const h = await (await fetch(base + '/health')).json()
  assert.deepEqual(h.capabilities.uplink, [...UPLINK])
  assert.deepEqual(h.capabilities.downlink, [...DOWNLINK])
  for (const k of ['press', 'record', 'mic', 'state', 'level', 'sound', 'diag', 'text']) {
    assert.ok(h.capabilities.unsupported[k], `unsupported 缺 ${k}`)
  }
  assert.equal(h.device.version.ver, '0.2')
  pass(`health: 上行 ${h.capabilities.uplink.length} / 下行 ${h.capabilities.downlink.length} / 不具备 ${Object.keys(h.capabilities.unsupported).length}`)

  console.log('8) 工具清单里没有会空转的两个')
  assert.ok(!tools.has('device_listen'), 'device_listen 不该注册（v2 没有 record）')
  assert.ok(!tools.has('device_mic'), 'device_mic 不该注册（v2 没有 mic）')
  assert.ok(tools.has('device_shot'), 'device_shot 应该注册（v2 支持 shot）')
  pass(`工具：${[...tools.keys()].join(' / ')}`)

  dev.ws.close()
} catch (e) {
  console.error('\n失败：', e)
  dispose()
  process.exit(1)
}

dispose()
console.log('\n全部通过 ✅')
