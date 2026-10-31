// 会话模式端到端：假 DSH 宿主（workspaceRegistry / sessionController / agents / session 事件）。
//
// 跑：node test/session.mjs
//
// 这是默认接法，但真机上要 DSH 桌面版才有 sessionController —— 所以在主机上把它假掉，
// 保证「设备说话 → agent.followup → assistant/message → turn/end → 上屏」这条链路每次改都能验。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 一定要在 import 插件前把数据目录指到临时目录，别污染真配置
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'embodied-test-'))
process.env.DSH_HOME = TMP

const { apply } = await import('../lib/index.js')

const PORT = 7801
const WS = `ws://127.0.0.1:${PORT}/device`
const SID = 'session-abc123'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pass = (m) => console.log('  ✓', m)

function makeHost() {
  const state = { events: [], followups: [], agent: null, created: 0 }
  const listeners = new Map()

  const agent = {
    id: SID,
    running: false,
    async followup(msg) {
      state.followups.push(msg)
    },
    async steer(msg) {
      state.followups.push({ steered: true, ...msg })
    },
    ctx: {
      systemPrompt: {
        context() {
          return () => {}
        },
      },
      tools: {
        register() {
          return () => {}
        },
        restrict() {
          return () => {}
        },
      },
    },
  }
  state.agent = agent

  const ctx = {
    tools: { register: () => () => {} },
    llm: {
      listProviders: () => [],
      listModels: () => [],
      async *stream() {
        yield { type: 'finish', kind: 'completed' }
      },
    },
    provided: {},
    provide(n, s) {
      this.provided[n] = s
    },
    get(k) {
      if (k === 'workspaceRegistry') return ctx.workspaceRegistry
      if (k === 'sessionController') return ctx.sessionController
      if (k === 'agents') return ctx.agents
      return undefined
    },
    workspaceRegistry: {
      list: () => [],
      create: async (dir, title) => ({ id: 'ws-1', path: dir, title }),
    },
    sessionController: {
      create: async () => {
        ++state.created
        return { sessionId: SID }
      },
      rename: async () => {},
      resolveAgent: async () => ({ agent }),
    },
    agents: { get: (id) => (id === SID || id === 'session-' + SID ? agent : undefined) },
    on(ev, fn) {
      listeners.set(ev, fn)
      return () => listeners.delete(ev)
    },
    effect(fn) {
      return fn()
    },
    emit(ev, ...args) {
      listeners.get(ev)?.(...args)
    },
  }
  state.ctx = ctx
  return state
}

function openDevice() {
  const ws = new WebSocket(WS)
  const inbox = []
  const waiters = []
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return
    let m
    try {
      m = JSON.parse(e.data)
    } catch {
      return
    }
    inbox.push(m)
    for (let i = waiters.length - 1; i >= 0; --i) {
      if (waiters[i].pred(m)) {
        waiters[i].resolve(m)
        waiters.splice(i, 1)
      }
    }
  })
  return {
    ws,
    inbox,
    open: () => new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const hit = inbox.find(pred)
        if (hit) return resolve(hit)
        const t = setTimeout(() => reject(new Error('超时：' + pred)), ms)
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m) } })
      }),
    clear: () => { inbox.length = 0 },
  }
}

async function main() {
  const host = makeHost()
  const dispose = apply(host.ctx, {
    port: PORT,
    discoverPort: PORT + 1,
    host: '127.0.0.1',
    brain: 'session',
    tts: false,
    asr: 'off',
    filler: false,
  })
  await sleep(300)

  const dev = openDevice()
  await dev.open()
  // v2 的 hello：ver 是字符串；cam=1 表示带摄像头
  dev.send({ t: 'hello', fw: 'hub_v2', board: 'watcher', ver: '0.2', cam: 1, w: 240, h: 240 })
  await dev.waitFor((m) => m.t === 'welcome')
  pass('握手完成')

  // 预热会话：hello 之后应该已经 create 过一次
  await sleep(120)
  assert.equal(host.created, 1, '应该建过一个设备会话')
  pass(`会话建好了：${SID}`)

  console.log('1) 设备说话 → agent.followup')
  // v2 没有 text 上行：走 voice（ASR 关）之外的正规入口是服务对象 submit，
  // 它和"识别出文字之后"走的是同一条 handleUserText → brain.submit。
  dev.clear()
  const svc0 = host.ctx.provided.embodied
  assert.ok(svc0, '服务对象应该在握手前就登记好')
  await svc0.submit('现在几点了', 'test')
  await sleep(120)
  assert.equal(host.followups.length, 1)
  const f = host.followups[0]
  assert.equal(f.role, 'user')
  assert.equal(f.content[0].text, '现在几点了')
  assert.ok(f.id && f.source?.kind, '持久消息必须有 id 与 source')
  pass(`followup 带着 id/source 进去了（${f.source.kind}）`)

  console.log('2) 别的会话的事件不该被当成设备回答')
  host.ctx.emit('session/event', { id: 'session-other' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '这是别处的回答' }] } },
  })
  host.ctx.emit('session/event', { id: 'session-other' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(120)
  assert.equal(dev.inbox.filter((m) => m.t === 'say').length, 0, '不该说话')
  pass('过滤掉了')

  console.log('3) 设备会话的回答 → 上屏')
  host.ctx.emit('session/event', { id: SID }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '现在是下午三点零七分。' }] } },
  })
  host.ctx.emit('session/event', { id: SID }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const said = await dev.waitFor((m) => m.t === 'say')
  assert.equal(said.text, '现在是下午三点零七分。')
  assert.equal(said.mood, 'speak')
  pass(`say「${said.text}」`)

  console.log('4) 中断的轮次不出声')
  dev.clear()
  await host.ctx.provided.embodied.submit('再说一句', 'test')
  await sleep(100)
  host.ctx.emit('session/event', { id: SID }, {
    type: 'assistant/message',
    data: { interrupted: true, message: { content: [{ type: 'text', text: '半句话' }] } },
  })
  host.ctx.emit('session/event', { id: SID }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await sleep(150)
  assert.equal(dev.inbox.filter((m) => m.t === 'say').length, 0)
  pass('aborted 的轮次没说话')

  console.log('5) 服务对象能反过来驱动设备')
  const svc = host.ctx.provided.embodied
  assert.ok(svc)
  assert.equal(svc.status().brain, 'session')
  const before = host.followups.length
  const submitted = await svc.submit('从插件里塞进去的一句', 'plugin')
  assert.equal(submitted.ok, true)
  assert.equal(host.followups.length, before + 1)
  pass('svc.submit 走了同一条会话')

  dispose()
  console.log('\n全部通过 ✅')
  process.exit(0)
}

main().catch((e) => {
  console.error('\n失败：', e)
  process.exit(1)
})
