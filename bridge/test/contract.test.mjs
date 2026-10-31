// contract 哨兵：让"桥能做但设备不支持"和"文档与代码漂移"这两类问题当场变红。
//
// 跑：node test/contract.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOWNLINK,
  ROUTES,
  TOOLS,
  TOOL_NEEDS,
  UPLINK,
  UNSUPPORTED,
} from '../lib/contract.js'
import { createDevice } from '../lib/device.js'
import { createTools } from '../lib/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOC = path.join(HERE, '..', '..', 'docs', '协议-v2-契约.md')

const silentLog = { info: () => {}, warn: () => {} }
const fakeCfg = { get: () => ({ eventRing: 20, path: '/device', maxReplyChars: 120, tts: false }) }

test('上行/下行清单互不重叠，且都不是空的', () => {
  assert.ok(UPLINK.length >= 4)
  assert.ok(DOWNLINK.length >= 7)
  for (const t of UPLINK) assert.ok(!DOWNLINK.includes(t), `${t} 同时出现在两个方向`)
})

test('"不具备"的清单不能和真正支持的重叠', () => {
  for (const t of Object.keys(UNSUPPORTED)) {
    assert.ok(!UPLINK.includes(t), `${t} 既说不支持又在上行里`)
    assert.ok(!DOWNLINK.includes(t), `${t} 既说不支持又在下行里`)
  }
  // v2 的 8 条历史消息必须都在
  for (const t of ['press', 'record', 'mic', 'state', 'level', 'sound', 'diag', 'text']) {
    assert.ok(UNSUPPORTED[t], `UNSUPPORTED 缺 ${t}（这条要写清为什么没有）`)
  }
})

test('设备的 send() 会拒绝契约外的下行（不静默发出）', () => {
  const dev = createDevice({ cfg: fakeCfg, log: silentLog })

  // 契约外的：必须拒绝，并计入 rejected
  assert.equal(dev.push({ t: 'record', seconds: 3 }), false)
  assert.equal(dev.push({ t: 'mic', auto: 1 }), false)
  assert.equal(dev.push({ t: 'nonsense' }), false)
  assert.equal(dev.counters.rejected, 3)

  // 契约内的：离线时也是 false，但不算 rejected
  dev.push({ t: 'say', text: 'hi' })
  dev.push({ t: 'shot' })
  assert.equal(dev.counters.rejected, 3, '契约内消息不该计被拒')
  dev.dispose()
})

test('工具清单与注册结果一致，且不含会空转的两个', () => {
  const dev = { capabilities: { downlink: [...DOWNLINK] }, say: () => ({ sent: true }), face: () => true }
  const speaker = { speak: () => {} }
  const brain = {}
  const tools = createTools({
    cfg: fakeCfg,
    log: silentLog,
    device: dev,
    brain,
    speaker,
    shootOnce: async () => ({ ok: true }),
  })
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort())
  assert.ok(!tools.some((t) => t.name === 'device_listen'))
  assert.ok(!tools.some((t) => t.name === 'device_mic'))
})

test('能力门控真的会摘掉工具（模拟一台没有 shot 的设备）', () => {
  const dev = { capabilities: { downlink: DOWNLINK.filter((t) => t !== 'shot') } }
  const tools = createTools({
    cfg: fakeCfg,
    log: silentLog,
    device: dev,
    brain: {},
    speaker: { speak: () => {} },
    shootOnce: async () => ({ ok: true }),
  })
  assert.ok(!tools.some((t) => t.name === 'device_shot'), '没有 shot 下行时不该注册 device_shot')
  assert.ok(tools.some((t) => t.name === 'device_say'))
})

test('TOOL_NEEDS 只引用真实存在的工具与下行', () => {
  for (const [tool, need] of Object.entries(TOOL_NEEDS)) {
    assert.ok(TOOLS.includes(tool), `TOOL_NEEDS 里有未知工具 ${tool}`)
    if (need) assert.ok(DOWNLINK.includes(need), `${tool} 依赖的下行 ${need} 不在契约里`)
  }
  for (const t of TOOLS) assert.ok(t in TOOL_NEEDS, `工具 ${t} 没声明依赖`)
})

test('路由：动作路由要有处理分支，gone 路由不与正常路由重叠', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'http.js'), 'utf8')
  for (const p of ROUTES.act) assert.ok(src.includes(`p === '${p}'`), `http.js 缺少 ${p} 的处理分支`)
  for (const p of Object.keys(ROUTES.gone)) {
    assert.ok(!ROUTES.read.includes(p) && !ROUTES.act.includes(p), `${p} 既在 gone 又在正常路由里`)
  }
})

test('文档与契约逐字一致（文档是生成的，手改会红）', () => {
  if (!fs.existsSync(DOC)) {
    console.log('  · 跳过：docs/协议-v2-契约.md 不在（插件单独分发时正常）')
    return
  }
  const txt = fs.readFileSync(DOC, 'utf8')
  assert.match(txt, /请勿手改/, '文档缺少"请勿手改"横幅')
  assert.match(txt, /gen-contract-doc\.mjs/, '文档没写明由哪个脚本生成')
  const m = txt.match(/```json\s*\n([\s\S]*?)\n```/)
  assert.ok(m, '文档里没有机器可读的 json 块')
  const spec = JSON.parse(m[1])
  assert.deepEqual(spec.uplink, [...UPLINK], '文档 uplink 与 contract.js 不一致')
  assert.deepEqual(spec.downlink, [...DOWNLINK], '文档 downlink 与 contract.js 不一致')
  assert.deepEqual(spec.tools, [...TOOLS], '文档 tools 与 contract.js 不一致')
  assert.deepEqual(Object.keys(spec.unsupported).sort(), Object.keys(UNSUPPORTED).sort())
})
