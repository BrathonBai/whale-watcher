// 严格审计：这台桥里"写上去但没真的能用"的东西。
//
// 跑：node test/audit.mjs
//
// 四类检查：
//   A 静态：代码里读的每个配置项是否在 DEFAULTS 里声明（漏声明的会静默 undefined）
//   B 动态：六个工具 + 全部 HTTP 路由 + 全部服务方法，逐个真跑一遍
//   C 契约：工具/路由/服务方法必须与 contract.js 完全一致（多一个少一个都算错）
//   D 面板：按钮打的接口必须存在
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'lib')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'embodied-audit-'))
process.env.DSH_HOME = TMP

const { apply } = await import('../lib/index.js')
const { DEFAULTS } = await import('../lib/config.js')
const { COMMANDS, MOODS } = await import('../lib/protocol.js')
const { ROUTES, TOOLS, TOOL_NEEDS, UNSUPPORTED } = await import('../lib/contract.js')

const PORT = 7805
const problems = []
const notes = []
const fail = (m) => problems.push(m)
const note = (m) => notes.push(m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ A 静态
function staticConfigAudit() {
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'))
  const known = new Set(Object.keys(DEFAULTS))
  const readKeys = new Map()
  for (const f of files) {
    const lines = fs.readFileSync(path.join(LIB, f), 'utf8').split('\n')
    const aliases = new Set()
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:cfg\.get\(\)|cfg\.value\(\))/g)) aliases.add(m[1])
      for (const m of line.matchAll(/cfg\.get\(\)\.([A-Za-z_$][\w$]*)/g)) record(m[1], f, i + 1)
      for (const a of aliases) {
        for (const m of line.matchAll(new RegExp(`\\b${a}\\.([A-Za-z_$][\\w$]*)`, 'g'))) record(m[1], f, i + 1)
      }
    })
    function record(k, file, ln) {
      if (!readKeys.has(k)) readKeys.set(k, [])
      readKeys.get(k).push(`${file}:${ln}`)
    }
  }
  for (const [k, where] of readKeys) {
    if (!known.has(k)) fail(`配置项 "${k}" 被读取（${where[0]}）但没在 DEFAULTS 里声明 → 永远 undefined`)
  }
  // device_say 必须"上屏 + 出声"两条路都在
  const toolsSrc = fs.readFileSync(path.join(LIB, 'tools.js'), 'utf8')
  if (!/speaker\??\.speak/.test(toolsSrc)) fail('device_say 只上屏不出声：tools.js 里没有调 speaker.speak')
  // 死配置只提示，不判红
  for (const k of known) if (!readKeys.has(k)) note(`配置项 "${k}" 在 DEFAULTS 里声明了，但代码里没人读（死配置）`)
  console.log(`  A 静态：读了 ${readKeys.size} 个配置项，声明了 ${known.size} 个`)
}

// ------------------------------------------------------------------ 宿主
function makeHost() {
  const tools = new Map()
  const listeners = new Map()
  const ctx = {
    tools: { register(t) { tools.set(t.name, t); return () => tools.delete(t.name) } },
    llm: {
      listProviders: () => [],
      listModels: () => [],
      async *stream() {
        yield { type: 'text-delta', text: '审计回答。' }
        yield { type: 'finish', kind: 'completed' }
      },
    },
    provided: {},
    provide(n, s) { this.provided[n] = s },
    get: () => undefined,
    on(ev, fn) { listeners.set(ev, fn); return () => listeners.delete(ev) },
    effect(fn) { return fn() },
  }
  return { ctx, tools, listeners }
}

function openDevice() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/device`)
  const inbox = []
  const waiters = []
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return
    let m
    try { m = JSON.parse(e.data) } catch { return }
    inbox.push(m)
    for (let i = waiters.length - 1; i >= 0; --i) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1) }
    }
  })
  return {
    ws,
    open: () => new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    binary: (b) => ws.send(b),
    waitFor: (pred, ms = 2500) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred)
      if (hit) return resolve(hit)
      const t = setTimeout(() => reject(new Error('超时：' + pred)), ms)
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m) } })
    }),
    clear: () => { inbox.length = 0 },
  }
}

// ------------------------------------------------------------------ B/C/D 动态
async function dynamicAudit(ctx, tools) {
  // ---- 工具：必须与契约完全一致 ----
  const got = [...tools.keys()].sort()
  const want = [...TOOLS].sort()
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`工具清单不符：注册了 ${got.join(',')}；契约是 ${want.join(',')}`)
  for (const n of TOOLS) {
    const t = tools.get(n)
    if (!t) { fail(`工具 ${n} 没注册`); continue }
    assert.equal(typeof t.execute, 'function', `${n}.execute`)
    const s = JSON.stringify(t.parameters ?? {})
    if (/"type"\s*:\s*\[/.test(s)) fail(`工具 ${n} 的 schema 用了 type 数组（DSH 会拒绝）`)
    if (!t.output?.schema) fail(`工具 ${n} 没有 output.schema`)
    if (typeof t.output?.render !== 'function') fail(`工具 ${n} 没有 render`)
  }
  // 能空转的两个必须不在
  for (const dead of ['device_listen', 'device_mic']) {
    if (tools.has(dead)) fail(`工具 ${dead} 还在注册（v2 没有 ${TOOL_NEEDS[dead] || '对应下行'}，调用只会空转）`)
  }
  console.log(`  B1 工具注册：${tools.size} 个（契约 ${TOOLS.length} 个）`)

  // ---- 设备上线 ----
  const dev = openDevice()
  await dev.open()
  dev.send({ t: 'hello', fw: 'hub_v2', board: 'watcher', ver: '0.2', cam: 1, w: 240, h: 240 })
  await dev.waitFor((m) => m.t === 'welcome')

  const st = await tools.get('device_status').execute({})
  assert.equal(st.online, true, 'device_status 应报在线')
  assert.equal(st.ver, '0.2', 'hello.ver 应该是字符串 0.2，不是 0')
  console.log(`  B2 device_status → online=${st.online} fw=${st.fw} ver=${st.ver}`)

  dev.clear()
  const said = await tools.get('device_say').execute({ text: '审计一下' })
  assert.equal(said.sent, true)
  await dev.waitFor((m) => m.t === 'say' && m.text === '审计一下')
  console.log('  B3 device_say → 设备收到 say')

  dev.clear()
  const f = await tools.get('device_face').execute({ mood: 'happy' })
  assert.equal(f.sent, true)
  await dev.waitFor((m) => m.t === 'face' && m.mood === 'happy')
  console.log('  B4 device_face → 设备收到 face')

  const ev = await tools.get('device_events').execute({ limit: 5 })
  assert.ok(Array.isArray(ev.events))
  console.log(`  B5 device_events → ${ev.events.length} 条，seq=${ev.seq}`)

  // device_shot：发 shot → 设备回 image → 落盘
  const shotP = tools.get('device_shot').execute({ timeoutMs: 4000 })
  await dev.waitFor((m) => m.t === 'shot')
  const jpg = Buffer.alloc(900, 0x22)
  jpg[0] = 0xff
  jpg[1] = 0xd8
  dev.send({ t: 'image', bytes: jpg.length, w: 240, h: 240, seq: 1 })
  await sleep(30)
  dev.binary(new Uint8Array(jpg))
  const shot = await shotP
  assert.equal(shot.ok, true, JSON.stringify(shot))
  console.log(`  B6 device_shot → ${shot.bytes} B（${shot.w}x${shot.h}）`)

  const caps = await tools.get('device_capabilities').execute({})
  assert.deepEqual(caps.uplink.sort(), ['hello', 'image', 'pong', 'voice'])
  for (const k of Object.keys(UNSUPPORTED)) if (!caps.unsupported[k]) fail(`capabilities 缺 ${k}`)
  console.log(`  B7 device_capabilities → 上行 ${caps.uplink.length} / 下行 ${caps.downlink.length}`)

  // ---- HTTP 只读路由 ----
  const base = `http://127.0.0.1:${PORT}`
  const get = async (p) => {
    const r = await fetch(base + p)
    return { code: r.status, body: await r.text() }
  }
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) })
    const body = await r.text()
    let j = null
    try {
      j = JSON.parse(body)
    } catch {}
    return { code: r.status, body, json: j }
  }
  for (const p of ROUTES.read) {
    if (p === '/shot.jpg') continue // 还没拍照时 404 是正常
    const r = await get(p)
    if (r.code !== 200) fail(`GET ${p} → ${r.code}`)
  }
  console.log(`  B8 只读路由 ${ROUTES.read.length} 条（/shot.jpg 允许 404）`)

  // ---- HTTP 动作路由 ----
  const acts = [
    ['/api/face', { mood: 'sad' }],
    ['/say', { text: '从接口来的' }],
    ['/api/speak', { text: '再说一句' }],
    ['/api/config', { maxReplyChars: 100 }],
  ]
  for (const [p, b] of acts) {
    const r = await post(p, b)
    if (r.code !== 200) fail(`POST ${p} → ${r.code} ${r.body.slice(0, 80)}`)
  }
  // /shot 也走一遍
  const shotHttp = post('/shot', { timeoutMs: 4000 })
  await dev.waitFor((m) => m.t === 'shot', 3000)
  const jpg2 = Buffer.alloc(800, 0x33)
  jpg2[0] = 0xff
  jpg2[1] = 0xd8
  dev.send({ t: 'image', bytes: jpg2.length, w: 240, h: 240, seq: 2 })
  await sleep(30)
  dev.binary(new Uint8Array(jpg2))
  const sr = await shotHttp
  if (sr.code !== 200) fail(`POST /shot → ${sr.code}`)
  console.log(`  B9 动作路由 ${acts.length + 1} 条全部 200`)

  // ---- gone 路由必须 501 + 原因 ----
  for (const p of Object.keys(ROUTES.gone)) {
    const r = await post(p, {})
    if (r.code !== 501) fail(`${p} 应该 501，实际 ${r.code}`)
    if (r.json?.error?.code !== 'UNSUPPORTED') fail(`${p} 的 error.code 应该是 UNSUPPORTED`)
  }
  console.log(`  B10 历史接口 ${Object.keys(ROUTES.gone).length} 条 → 501 并说明原因`)

  // ---- 配置热更新 ----
  const after = await (await fetch(base + '/health')).json()
  if (after.config?.maxReplyChars !== 100) fail(`/api/config 写了 maxReplyChars=100，但状态里是 ${after.config?.maxReplyChars}`)
  else console.log('  B11 配置热更新生效（maxReplyChars=100 立刻可见）')

  // ---- 服务对象 ----
  const svc = ctx.provided.embodied
  if (!svc) fail('ctx.provide("embodied") 没登记')
  else {
    for (const m of ['status', 'capabilities', 'say', 'face', 'speak', 'shot', 'submit', 'events']) {
      if (typeof svc[m] !== 'function') fail(`服务对象缺方法 ${m}`)
    }
    if (svc.status().online !== true) fail('服务对象 status().online 不是 true')
    console.log('  B12 服务对象方法齐全')
  }

  // ---- 面板引用的接口都存在 ----
  const panel = fs.readFileSync(path.join(LIB, 'panel.html'), 'utf8')
  const known = new Set([...ROUTES.read, ...ROUTES.act, ...Object.keys(ROUTES.gone)])
  for (const m of panel.matchAll(/api\(\s*['"]([^'"?]+)/g)) {
    if (!known.has(m[1])) fail(`面板调用了不存在的接口 ${m[1]}`)
  }
  if (!/\/events\?after=/.test(panel)) fail('面板没有订阅事件流')
  if (/\/listen|\/mic/.test(panel)) fail('面板还在调用 v2 不支持的接口（/listen、/mic）')
  console.log('  B13 面板引用的接口都存在，且不再调用 /listen、/mic')

  // ---- 命令目录与工具对齐 ----
  const tails = Object.keys(COMMANDS).map((k) => k.split('.')[1]).sort()
  const toolTails = TOOLS.map((t) => t.replace(/^device_/, '')).sort()
  if (JSON.stringify(tails) !== JSON.stringify(toolTails)) fail(`命令目录 ${tails.join(',')} 与工具 ${toolTails.join(',')} 不一致`)
  if (MOODS.length !== 8) fail(`MOODS 应该是 8 个（固件 proto.h 同序），实际 ${MOODS.length}`)
  console.log(`  B14 命令目录 ${tails.length} 项 / 表情 ${MOODS.length} 个，与工具对齐`)

  return dev
}

// ------------------------------------------------------------------ main
console.log('== 审计开始 ==')
staticConfigAudit()
const { ctx, tools } = makeHost()
const dispose = apply(ctx, {
  port: PORT,
  discoverPort: PORT + 1,
  host: '127.0.0.1',
  brain: 'llm',
  provider: 'audit',
  model: 'audit-1',
  tts: false,
  asr: 'off',
  filler: false,
  heartbeatMs: 60000,
})
await sleep(400)
await dynamicAudit(ctx, tools)
dispose()
await sleep(150)

console.log('\n== 结果 ==')
if (notes.length) {
  console.log(`提示 ${notes.length} 条：`)
  for (const n of notes) console.log('  ·', n)
}
if (problems.length) {
  console.log(`\n❌ 问题 ${problems.length} 条：`)
  for (const p of problems) console.log('  ✗', p)
  process.exit(1)
}
console.log('✅ 没有发现"写了但没实现"的项')
process.exit(0)
