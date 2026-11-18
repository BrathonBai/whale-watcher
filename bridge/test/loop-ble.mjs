// 端到端（BLE 链路语义）：假设备（ADPCM 上行）↔ 真桥 ↔ 假 DSH 宿主。
//
// 跑：node test/loop-ble.mjs
//
// 覆盖 2026-11-13 新增的桥侧能力（不依赖手机/固件）：
//   · wsToken：不带 token 的 /device 必须 401；
//   · hello 新字段（transport=ble / uplink=adpcm / mtu / name）→ /health 如实展示；
//   · ADPCM 语音上行 → 解码 → WAV 采样数/采样率与原始一致 → ASR 关掉时显式说"没听清"；
//   · audioCodec=adpcm 时协商结果就绪（state.audio.effective=adpcm）；
//   · pong 新诊断字段（transport/mtu/txDrop/rxDrop）落进 lastDiag；
//   · discover:false 不绑 UDP（起桥不报错、/health 正常）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'embodied-loop-ble-'))
process.env.DSH_HOME = TMP
const PORT = 7807
const TOKEN = 'loop-ble-token-123'

const { apply } = await import('../lib/index.js')

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
          yield { type: 'text-delta', text: '收到。' }
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

function openDevice(url) {
  const ws = new WebSocket(url)
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
      ws.addEventListener('error', (e) => rej(new Error('ws error')), { once: true })
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    binary: (buf) => ws.send(buf),
    waitFor: (pred, ms = 3000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred)
      if (hit) return resolve(hit)
      const t = setTimeout(() => reject(new Error('超时：' + pred)), ms)
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m) } })
    }),
  }
}

/** 极简 WAV 解析：只取 fmt 与 data（桥写的都是 16bit mono）。 */
function parseWav(buf) {
  let off = 12
  let fmt = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      return { fmt, dataBytes: size }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('No data chunk')
}

function makePcm(samples = 4800) {
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(9000 * Math.sin((i / 24000) * 2 * Math.PI * 520)), i * 2)
  }
  return buf
}

// ---------------- 起桥 ----------------
const { ctx, tools } = makeHost()
const dispose = apply(ctx, {
  host: '127.0.0.1',
  port: PORT,
  wsToken: TOKEN,
  discover: false,
  brain: 'llm',
  provider: 'loop',
  model: 'loop-1',
  tts: false,
  asr: 'off',
  filler: false,
  heartbeatMs: 60000,
  audioCodec: 'adpcm', // 显式：验证 adpcm 协商就绪（不依赖本机 ffmpeg）
})
await sleep(300)
const base = `http://127.0.0.1:${PORT}`

try {
  console.log('0) wsToken：不带 token 必须 401（手机 loopback 的安全底线）')
  {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/device`)
    const failed = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 1500)
      ws.addEventListener('open', () => { clearTimeout(t); resolve(false) })
      ws.addEventListener('error', () => { clearTimeout(t); resolve(true) })
    })
    assert.equal(failed, true, '没有 token 的 /device 不该握手成功')
    pass('无 token → 拒绝')
  }

  console.log('1) 握手：token + BLE 语义 hello')
  const dev = openDevice(`ws://127.0.0.1:${PORT}/device?token=${TOKEN}`)
  await dev.open()
  dev.send({
    t: 'hello', fw: 'hub_v2', board: 'watcher', ver: '0.3', cam: 1, w: 240, h: 240,
    codecs: ['pcm', 'opus', 'adpcm'], opusRate: 24000,
    transport: 'ble', uplink: 'adpcm', mtu: 247, name: 'Jingjing-1A2B',
  })
  const welcome = await dev.waitFor((m) => m.t === 'welcome')
  assert.equal(welcome.ver, 2)
  await dev.waitFor((m) => m.t === 'face' && m.mood === 'idle')
  const h1 = await (await fetch(base + '/health')).json()
  assert.equal(h1.device.transport, 'ble', '/health 必须显示链路=ble')
  assert.equal(h1.device.uplink, 'adpcm')
  assert.equal(h1.device.name, 'Jingjing-1A2B')
  assert.equal(h1.device.mtu, 247)
  assert.deepEqual(h1.device.codecs, ['pcm', 'opus', 'adpcm'])
  assert.equal(h1.audio.effective, 'adpcm', 'audioCodec=adpcm + 设备支持 → 应选 adpcm')
  assert.equal(h1.audio.device.transport, 'ble')
  assert.equal(h1.audio.device.uplink, 'adpcm')
  pass('welcome / face idle / health: transport=ble uplink=adpcm mtu=247，audio=adpcm')

  console.log('2) pong 新诊断字段原样落进 lastDiag')
  dev.send({ t: 'pong', bufMs: 180, underruns: 0, codec: 'adpcm', transport: 'ble', mtu: 247, txDrop: 1, rxDrop: 2 })
  await sleep(50)
  const h2 = await (await fetch(base + '/health')).json()
  assert.equal(h2.device.lastDiag.transport, 'ble')
  assert.equal(h2.device.lastDiag.mtu, 247)
  assert.equal(h2.device.lastDiag.txDrop, 1)
  assert.equal(h2.device.lastDiag.rxDrop, 2)
  assert.equal(h2.audio.pong.transport, 'ble')
  pass(`lastDiag: ${JSON.stringify(h2.device.lastDiag)}`)

  console.log('3) ADPCM 语音上行 → 解码 → WAV（采样率/采样数与原始一致）')
  const { encodePcm } = await import('../lib/adpcm.js')
  const pcm = makePcm(4800) // 0.2 s
  const enc = encodePcm(pcm)
  const chunks = []
  for (let off = 0; off < enc.encoded.length; off += 1200) chunks.push(enc.encoded.subarray(off, off + 1200))
  dev.send({ t: 'voice', bytes: enc.encoded.length, samples: enc.samples, rate: 24000, bits: 16, ch: 1, codec: 'adpcm', seq: 7 })
  await sleep(30)
  for (const c of chunks) dev.binary(new Uint8Array(c))
  const hint = await dev.waitFor((m) => m.t === 'say' && /没听清/.test(m.text), 8000)
  assert.ok(hint, 'ADPCM 解码成功后会走 ASR，asr=off 应显式提示没听清')
  const voiceDir = path.join(TMP, 'plugins-data', 'embodied-bridge', 'voice')
  const files = fs.readdirSync(voiceDir).filter((x) => x.endsWith('.wav'))
  assert.ok(files.length >= 1, 'WAV 应该落盘')
  const wav = parseWav(fs.readFileSync(path.join(voiceDir, files[files.length - 1])))
  assert.equal(wav.fmt.rate, 24000, 'WAV 采样率')
  assert.equal(wav.fmt.bits, 16)
  assert.equal(wav.fmt.channels, 1)
  assert.equal(wav.dataBytes, pcm.length, '解码后 PCM 字节数必须与原始一致（samples 裁剪生效）')
  pass(`ADPCM ${enc.encoded.length} B → WAV ${wav.dataBytes} B @${wav.fmt.rate}Hz（${enc.blocks} 块）`)

  console.log('4) 能力清单仍然只有 4 上行 / 7 下行（BLE 不新增消息类型）')
  const h3 = await (await fetch(base + '/health')).json()
  assert.deepEqual(h3.capabilities.uplink, ['hello', 'pong', 'image', 'voice'])
  assert.equal(h3.capabilities.downlink.length, 7)
  assert.ok(h3.capabilities.uplinkCodecs.includes('adpcm'))
  assert.ok(h3.capabilities.downlinkCodecs.includes('adpcm'))
  pass(`uplink=${h3.capabilities.uplink.length} downlink=${h3.capabilities.downlink.length} codecs=${h3.capabilities.downlinkCodecs.join('/')}`)

  console.log('5) 工具仍按能力注册（没有空转工具）')
  assert.ok(tools.has('device_say') && tools.has('device_shot') && tools.has('device_capabilities'))
  assert.ok(!tools.has('device_listen') && !tools.has('device_mic'))
  pass(`工具：${[...tools.keys()].join(' / ')}`)

  dev.ws.close()
} catch (e) {
  console.error('\n失败：', e)
  dispose()
  process.exit(1)
}

dispose()
console.log('\n全部通过 ✅')
