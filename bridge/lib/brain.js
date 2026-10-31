// 大脑：把设备说的一句话变成一句回答。
//
// 两种接法（cfg.brain）：
//
//   session（默认）——设备有自己的 DSH 会话，看得见、能插话、能用工具和记忆。
//     text → agent.followup({id, role:'user', content:[{type:'text'}], source})
//     回答 → ctx.on('session/event') 的 assistant/message → turn/end 收口
//
//   llm —— 插件自己调 ctx.llm.stream。不建会话，但也没有工具。
//     这里踩过一个坑（2026-10-30 定位）：DSH 的 GenerateOptions 只接受「持久 Message」
//     或「仅供请求的 user 消息」。v0.1 把历史里的 assistant 消息原样塞回去，
//     那些没有 id/source，适配器直接拒绝，流的终止分片是 {kind:'error'}，
//     老代码只当"回空"，于是四连重试、四连回空。现在：
//       · 只用一条 user 消息（把最近几轮拼成"对话记录"塞进正文），永远合法；
//       · 终止分片是 error 时把 failure.code 报出来，不再伪装成"空回复"。
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { dataDir } from './config.js'

const SOURCE_KIND = 'embodied-device'
const normId = (id) => String(id ?? '').replace(/^session-/, '')

/** 把最近几轮拼成一段"对话记录"，塞进一条 user 消息里（合法的 request-only 输入）。 */
export function composePrompt(history, text) {
  const recent = history.slice(-8)
  if (!recent.length) return text
  const lines = recent.map((h) => `${h.role === 'user' ? '用户' : '你'}：${h.text}`)
  return `【刚才的对话】\n${lines.join('\n')}\n【现在】用户说：${text}`
}

/** 从 DSH 消息里抽纯文本。 */
export function textOfMessage(message) {
  const out = []
  for (const b of message?.content ?? []) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out.join('').trim()
}

export function createBrain({ cfg, log, dsh, onReply, onTurnStart, onThinking, onError }) {
  const history = [] // 只在 llm 模式用；session 模式的历史在 DSH 会话里
  const cap = () => Math.max(1, Number(cfg.get().historyTurns) || 8) * 2

  let agent = null
  let sid = ''
  let busy = false
  let pendingTurn = null
  let collected = ''
  let fillerTimer = null

  const remember = (role, text) => {
    history.push({ role, text })
    while (history.length > cap()) history.shift()
  }

  // ---------------- session 模式 ----------------
  // 只走 ctx.get：**不要**写 `dsh.agents` 这种属性访问。
  // cordis 对没 inject 的服务，属性访问会直接抛
  // `cannot get property "agents" without inject`，`??` 都轮不到；
  // 而 ctx.get 是给"可选服务"用的，没 inject 也能拿到（aurabot 取 tools 就这么拿）。
  const svc = (name) => {
    try {
      return dsh.get?.(name)
    } catch {
      return undefined
    }
  }
  const registry = () => svc('workspaceRegistry') ?? null
  const controller = () => svc('sessionController') ?? null
  const agents = () => svc('agents') ?? null

  async function ensureWorkspace() {
    const reg = registry()
    if (!reg) throw new Error('宿主没有 workspaceRegistry')
    const dir = String(cfg.get().workspaceDir || '').trim() || path.join(dataDir(), 'workspace')
    fs.mkdirSync(dir, { recursive: true })
    const same = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
    const list = typeof reg.list === 'function' ? reg.list() : []
    const hit = (list || []).find((w) => same(w.path) === same(dir))
    if (hit) return hit
    if (typeof reg.create !== 'function') throw new Error('workspaceRegistry 不能创建')
    const ws = await reg.create(dir, String(cfg.get().workspaceTitle || 'Watcher'))
    log.info(`建好了工作区「${cfg.get().workspaceTitle}」：${dir}`)
    return ws
  }

  async function ensureAgent() {
    if (agent) return agent
    const ag = agents()
    const sidCfg = String(cfg.get().sessionId || '').trim()
    if (sidCfg && ag?.get) {
      const live = ag.get(sidCfg) || ag.get('session-' + sidCfg) || ag.get('session-' + normId(sidCfg))
      if (live) {
        agent = live
        sid = sidCfg
        log.info(`接上已有设备会话 ${normId(sid).slice(-8)}`)
        attachDeviceContext(agent)
        return agent
      }
    }
    const ctl = controller()
    if (!ctl || typeof ctl.create !== 'function') throw new Error('宿主没有 sessionController.create')
    const ws = await ensureWorkspace()
    const r = await ctl.create({
      workspaceId: ws.id,
      ...(String(cfg.get().preset || '').trim() ? { agentPreset: cfg.get().preset } : {}),
    })
    sid = String(r?.sessionId ?? '')
    if (!sid) throw new Error('建会话失败：没有 sessionId')
    try {
      await ctl.rename?.({ sessionId: sid, title: 'Watcher · 设备' })
    } catch {}
    try {
      cfg.save({ sessionId: sid }) // 下次重启复用，不新开一堆会话
    } catch {}
    log.info(`为设备新开 DSH 会话 ${normId(sid).slice(-8)}`)
    const live = ag?.get?.(sid) || ag?.get?.('session-' + sid) || (await ctl.resolveAgent?.(sid))?.agent
    if (!live) throw new Error('会话建好了但拿不到 agent')
    agent = live
    attachDeviceContext(agent)
    return agent
  }

  /**
   * 给设备的会话挂一段"你在哪、该怎么说话"的常驻上下文。
   * 不挂在系统提示词最前面，而是每轮追加（aurabot 的做法）：不破坏前缀缓存，
   * 而且 maxReplyChars 这类设置改了下一轮就生效。
   */
  const contextAttached = new WeakSet()
  const contextOffs = []
  function attachDeviceContext(a) {
    try {
      if (!a || contextAttached.has(a)) return
      contextAttached.add(a)
      const sp = a.ctx?.systemPrompt
      if (typeof sp?.context !== 'function') return
      const off = sp.context({
        name: 'embodied-device',
        order: 900,
        text: () => {
          const c = cfg.get()
          const max = Math.max(40, Number(c.maxReplyChars) || 240)
          return [
            '【具身设备·当前场景】',
            `你不是在电脑上打字，而是在跟一台戴在身上的小型设备（SenseCAP Watcher：412×412 圆屏 + 扬声器 + 麦克风）对话。`,
            `回答要短：一到两句，最多 ${max} 字，会被念出来。不要用 Markdown、列表、代码块、表格。`,
            '用户可能是说的（语音转写），所以别在回答里抠字眼或要求他重发格式。',
            '需要对方做动作时直接说一句人话（例如"按一下上面的键"），不要给链接或让人去网页操作。',
          ].join('\n')
        },
      })
      if (typeof off === 'function') contextOffs.push(off)
      log.info('已给设备会话挂上「具身设备」上下文')
    } catch (e) {
      log.warn('挂设备上下文失败：', e?.message ?? e)
    }
  }

  function clearFiller() {
    if (fillerTimer) {
      clearTimeout(fillerTimer)
      fillerTimer = null
    }
  }
  function armFiller() {
    clearFiller()
    if (cfg.get().filler === false) return
    fillerTimer = setTimeout(() => {
      fillerTimer = null
      if (busy) onThinking?.()
    }, 1200)
    fillerTimer.unref?.()
  }

  // ---------------- llm 模式 ----------------
  function catalog() {
    const llm = dsh.llm ?? dsh.get?.('llm')
    const ids = (() => {
      try {
        return (llm?.listProviders?.() ?? []).map((p) => (typeof p === 'string' ? p : p?.id ?? p?.name ?? String(p)))
      } catch {
        return []
      }
    })()
    const models = {}
    for (const id of ids) {
      try {
        const list = llm.listModels({ provider: id }) ?? llm.listModels(id) ?? []
        models[id] = (Array.isArray(list) ? list : []).map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? String(m)))
      } catch {
        models[id] = []
      }
    }
    return { llm, ids, models }
  }

  async function askLlm(text) {
    const { llm, ids, models } = catalog()
    if (!llm || typeof llm.stream !== 'function') throw Object.assign(new Error('没有可用的 llm 服务'), { code: 'NO_LLM' })
    const want = { provider: String(cfg.get().provider || ''), model: String(cfg.get().model || '') }
    const candidates = []
    if (want.provider && want.model) candidates.push(want)
    for (const id of ids) {
      const m = (models[id] ?? [])[0]
      if (m && !(id === want.provider && m === want.model)) candidates.push({ provider: id, model: m })
    }
    if (!candidates.length) throw Object.assign(new Error('没有可用 provider/model'), { code: 'NO_MODEL' })

    const prompt = composePrompt(history, text)
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    const sys = String(cfg.get().systemPrompt || '')
    const full = sys ? [{ role: 'system', content: [{ type: 'text', text: sys }] }, ...messages] : messages

    let lastErr = null
    for (const pick of candidates.slice(0, 3)) {
      let out = ''
      let failure = null
      try {
        for await (const chunk of llm.stream({
          provider: pick.provider,
          model: pick.model,
          messages: full,
          ...(String(cfg.get().reasoningEffort || '').trim() ? { reasoningEffort: cfg.get().reasoningEffort } : {}),
        })) {
          const type = chunk?.type
          if (type === 'text-delta') out += chunk.text ?? chunk.delta ?? ''
          else if (type === 'text') out += chunk.text ?? ''
          else if (type === 'finish') {
            // 终止分片：kind='error' 时 failure 里才有真相，别再当"空回复"
            if (chunk.kind && chunk.kind !== 'completed' && chunk.kind !== 'stop') {
              failure = chunk.failure ?? { code: chunk.kind, message: chunk.message }
            } else if (chunk.message) {
              for (const b of chunk.message.content ?? []) if (b?.type === 'text') out += b.text ?? ''
            }
            break
          }
        }
      } catch (e) {
        lastErr = e
        log.warn(`llm ${pick.provider}/${pick.model} 抛错：`, e?.message ?? e)
        continue
      }
      if (failure) {
        const code = failure.code ?? 'ERROR'
        lastErr = Object.assign(new Error(`${code}: ${failure.message ?? ''}`.trim()), { code })
        log.warn(`llm ${pick.provider}/${pick.model} 终止失败：${code} ${failure.message ?? ''}`)
        continue
      }
      if (out.trim()) {
        log.info(`llm ${pick.provider}/${pick.model} 回复 ${out.length} 字`)
        return out.trim()
      }
      lastErr = Object.assign(new Error('模型返回空文本（无可见内容）'), { code: 'EMPTY' })
      log.warn(`llm ${pick.provider}/${pick.model} 返回空文本`)
    }
    throw lastErr ?? Object.assign(new Error('没拿到回复'), { code: 'EMPTY' })
  }

  // ---------------- 对外 ----------------
  // 配置说 session ≠ 实际跑在 session：拿不到 sessionController 时会静默退回 llm。
  // 所以对外同时给 mode（配置意图）和 effective（这一轮实际走的路），别让人看假的。
  let effective = String(cfg.get().brain || 'session')
  const brain = {
    get mode() {
      return String(cfg.get().brain || 'session')
    },
    get effective() {
      return effective
    },
    get sessionId() {
      return sid
    },
    get agentReady() {
      return Boolean(agent)
    },

    /** 设备说了一句 → 交给大脑。返回 {ok, accepted, mode}。 */
    async submit(text, { via = 'device' } = {}) {
      const s = String(text ?? '').trim()
      if (!s) return { ok: false, error: { code: 'EMPTY', message: 'empty text' } }
      busy = true
      onTurnStart?.()
      armFiller()

      if (brain.mode === 'session') {
        try {
          const a = await ensureAgent()
          clearFiller()
          const message = {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: s }],
            source: { kind: SOURCE_KIND },
          }
          busy = true
          // 正在跑的一轮：steer 让它下一步就看到；空闲时 followup 开新轮
          try {
            if (a.running || a.busy) await a.steer?.(message)
            else await a.followup(message)
          } catch (e) {
            if (typeof a.steer === 'function') await a.steer(message)
            else throw e
          }
          effective = 'session'
          log.info(`[${via}] → 会话 ${normId(sid).slice(-8)}：${s.slice(0, 60)}`)
          return { ok: true, accepted: true, mode: 'session', sessionId: sid }
        } catch (e) {
          effective = 'llm'
          log.warn('会话模式失败，这轮退回 llm：', e?.message ?? e)
          // 掉到 llm 模式，别让设备干等
        }
      }

      try {
        const reply = await askLlm(s)
        clearFiller()
        busy = false
        remember('user', s)
        remember('assistant', reply)
        onReply?.(reply, { mode: 'llm' })
        return { ok: true, accepted: true, mode: 'llm', reply }
      } catch (e) {
        clearFiller()
        busy = false
        onError?.(e)
        return { ok: false, error: { code: e?.code ?? 'LLM_FAILED', message: String(e?.message ?? e) } }
      }
    },

    /**
     * 会话事件：负责把「回答」捞出来。
     * 返回 true 表示这个事件属于本桥的设备会话（上层可以顺带记日志）。
     */
    handleSessionEvent(session, event) {
      const id = normId(session?.id ?? session?.sessionId)
      // 没拿到自己的 sid 之前，**一条都不认**。
      // 曾经这里写成"sid 为空时用事件补"——结果是桥认领了 DSH 里第一个路过的会话，
      // 会把人家的回答念到设备上，而且 `device_status` 还会报一个假的 sessionId。
      if (!sid || !id || id !== normId(sid)) return false
      const type = event?.type
      if (type === 'assistant/message') {
        const d = event.data || {}
        if (d.interrupted) return true
        const t = textOfMessage(d.message)
        if (t) collected = t
        return true
      }
      if (type === 'turn/end') {
        const d = event.data || {}
        const reason = d?.reason?.kind ?? ''
        const text = collected
        collected = ''
        busy = false
        clearFiller()
        if (text && reason !== 'aborted') {
          log.info(`会话回答 ${text.length} 字（${reason || 'end'}）`)
          onReply?.(text, { mode: 'session', reason })
        } else if (reason === 'aborted') {
          // 被打断（按键/新一句话顶掉）：不是故障，别念兜底话
          log.info('这一轮被打断，不出声')
        } else if (reason && reason !== 'completed') {
          log.warn(`这一轮没完成：${reason}${d?.reason?.message ? '（' + d.reason.message + '）' : ''}`)
          onError?.(Object.assign(new Error(reason), { code: reason }))
        }
        return true
      }
      return true
    },

    get busy() {
      return busy
    },
    /** 设备一上线就把会话备好：第一句话不该等建会话/建工作区的几秒。 */
    prewarm() {
      if (brain.mode !== 'session') return
      ensureAgent().catch((e) => log.warn('预热会话失败（会在这轮退回 llm）：', e?.message ?? e))
    },
    history() {
      return history.slice()
    },
    dispose() {
      for (const off of contextOffs.splice(0)) {
        try {
          off()
        } catch {}
      }
    },
  }
  return brain
}
