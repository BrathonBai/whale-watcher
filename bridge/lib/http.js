// HTTP：自测口 + 面板 + 给"别的程序"用的开放接口。
//
// 分两档权限：
//   只读（/health /api/state /events /commands /moods /panel）——局域网随便看
//   动作（/say /api/speak /api/face /shot /api/config）——本机免令牌；配了 panelToken 就要 Bearer
//
// v2 变化：
//   · 路由清单从 contract.ROUTES 派生，不再各处手写（contract.test 会比对）；
//   · 新增 /shot（让设备拍一张）；
//   · /listen 与 /mic 保留路径但返回 501 + 原因——历史脚本调用时要能看懂"为什么不行"，
//     而不是收到一个 404 去翻代码。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { ROUTES, summarize } from './contract.js'
import { COMMANDS, MOODS, PROTOCOL_VERSION, describeCommands } from './protocol.js'
import { DEFAULTS, asrModeOf, deepseekApiKeyOf, ttsEngineOf } from './config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 只读 JSON 不再带 ACAO:*（审计 E-07/BR-36）：面板与 curl 都是同源/非浏览器，不需要它；
// 带着它等于"任意网页可跨域读 /api/state"。
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const text = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type })
  res.end(body)
}

/** 只允许本机（动作类只认本机或令牌）。 */
function isLoopback(req) {
  const a = String(req.socket?.remoteAddress ?? '')
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/**
 * 防 CSRF（审计 E-06/BR-24）：浏览器跨站请求会带 Origin。
 * 只放行"没有 Origin"（curl / 本机脚本）或"Origin 是本机回环"的请求。
 * 这挡住 <img src="http://127.0.0.1:7788/say?text=..."> 与跨站 fetch。
 */
function originAllowed(req) {
  const o = req.headers?.origin
  if (!o) return true
  try {
    const u = new URL(String(o))
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1'
  } catch {
    return false
  }
}

/** 只在启动时读取的键：热改会"成功但无效"，必须告诉调用方要重启。 */
const STARTUP_KEYS = new Set(['host', 'port', 'path', 'discoverPort', 'logFile', 'eventRing', 'workspaceDir'])

export function createHttp({ cfg, log, device, brain, speaker, shootOnce, asr, startedAt, lastImage, storage, paths = {} }) {
  let panelCache = null

  function authorized(req) {
    const token = String(cfg.get().panelToken || '').trim()
    if (isLoopback(req)) return true
    if (!token) return false
    const h = req.headers || {}
    const raw = String(h.authorization || h.Authorization || '')
    const given = raw.startsWith('Bearer ') ? raw.slice(7).trim() : String(h['x-embodied-token'] || '')
    if (!given) return false
    const a = Buffer.from(given)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  function state() {
    return {
      ok: true,
      ver: PROTOCOL_VERSION,
      uptimeMs: Date.now() - startedAt,
      device: {
        online: device.online,
        connectedMs: device.connectedMs,
        pongAgeMs: device.pongAgeMs ?? null,
        lastPongAt: device.lastPongAt ?? null,
        lastEvent: device.lastEvent,
        counters: device.counters,
        version: device.version,
        collecting: device.collecting,
        lastSpoken: device.lastSpoken,
        // 2026-11-03 能力协商：设备声明的音频编码与最近一次 pong 诊断。
        // 老固件没有这两个字段 → [] / 0 / null（如实呈现，不假装有）。
        codecs: device.codecs ?? [],
        opusRate: device.opusRate ?? 0,
        // 2026-11-13（BLE）：链路类型 / 上行编码 / 显示名 / MTU，面板一眼看出走的哪条链路。
        transport: device.transport ?? 'wifi',
        uplink: device.uplink ?? 'pcm',
        name: device.name ?? '',
        mtu: device.mtu ?? 0,
        lastDiag: device.lastDiag ?? null,
      },
      capabilities: summarize(),
      storage: storage?.() ?? null,
      brain: { mode: brain.mode, effective: brain.effective, sessionId: brain.sessionId, busy: brain.busy },
      asr: { serverReady: asr?.serverReady ?? false, lastReason: asr?.lastReason ?? '', mode: asrModeOf(cfg.get()) },
      tts: {
        // engine = 实际生效（auto 已解析：有 deepseekApiKey → deepseek，否则 edge）；
        // preference = 配置里写的原值（auto/deepseek/edge/...），排障时两个都要能看见。
        engine: ttsEngineOf(cfg.get()),
        preference: cfg.get().ttsEngine,
        on: Boolean(cfg.get().tts),
        configured: ttsConfigured(cfg.get()),
        deepseek: ttsEngineOf(cfg.get()) === 'deepseek',
        stream: cfg.get().breezeStream !== false,
        lastEngine: speaker?.engine || '',
        lastError: speaker?.engineError || '',
      },
      // Opus 协商 / 自适应码率 / 最近一次编码结果：失败绝不静默，这里能看见。
      audio: speaker?.audioState?.() ?? null,
      config: redactConfig(cfg.get()),
    }
  }

  /**
   * 一次定位问题用的聚合诊断（审计 E-10 / TODO P4-4）。
   * 只读、不含密钥；路径、计数、最近错误、最近事件都在这里。
   */
  function diag() {
    const layers = cfg.layerInfo ? cfg.layerInfo() : { sources: {}, shadowed: [] }
    const sources = {}
    for (const [k, v] of Object.entries(layers.sources)) {
      sources[k] = { from: v.from, value: redactConfig({ [k]: v.value })[k] }
    }
    return {
      ok: true,
      at: new Date().toISOString(),
      uptimeMs: Date.now() - startedAt,
      paths,
      device: state().device,
      brain: state().brain,
      tts: state().tts,
      asr: state().asr,
      // 音频编码决策的完整解释：当前档位、依据、最近一次切换原因、最近一次编码耗时/错误。
      audio: state().audio,
      storage: storage?.() ?? null,
      configSources: sources,
      configShadowed: layers.shadowed.map((s) => ({
        key: s.key,
        file: redactConfig({ [s.key]: s.file })[s.key],
        patch: redactConfig({ [s.key]: s.patch })[s.key],
        effective: redactConfig({ [s.key]: s.effective })[s.key],
      })),
      recentEvents: typeof device.since === 'function' ? device.since(0, 10) : [],
    }
  }

  function panel() {
    if (panelCache) return panelCache
    try {
      panelCache = fs.readFileSync(path.join(HERE, 'panel.html'), 'utf8')
    } catch {
      panelCache = '<!doctype html><meta charset="utf-8"><h1>panel.html 丢了</h1>'
    }
    return panelCache
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      let b = ''
      let n = 0
      req.on('data', (d) => {
        n += d.length
        if (n > 64 * 1024) {
          req.destroy()
          resolve('')
          return
        }
        b += d.toString('utf8')
      })
      req.on('end', () => resolve(b))
      req.on('error', () => resolve(''))
      setTimeout(() => resolve(b), 3000)
    })
  }

  const parseJson = (s) => {
    try {
      return JSON.parse(s || '{}')
    } catch {
      return {}
    }
  }

  const readSet = new Set(ROUTES.read)
  const actSet = new Set(ROUTES.act)

  /** 返回 true = 已处理。 */
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname
    const q = url.searchParams
    const body = req.method === 'POST' || req.method === 'PUT' ? parseJson(await readBody(req)) : {}
    const pick = (k, d) => q.get(k) ?? body[k] ?? d

    // ---------------- 只读 ----------------
    if (readSet.has(p)) {
      if (p === '/health' || p === '/api/state') return json(res, 200, state()), true
      if (p === '/api/diag') return json(res, 200, diag()), true
      if (p === '/events') return json(res, 200, { ok: true, seq: device.counters.seq, events: device.since(Number(q.get('after') ?? 0), Number(q.get('limit') ?? 30)) }), true
      if (p === '/commands') return json(res, 200, COMMANDS), true
      if (p === '/moods') return json(res, 200, { moods: MOODS }), true
      if (p === '/panel') {
        if (cfg.get().panel === false) return text(res, 404, 'panel disabled（config.panel=false）'), true
        return text(res, 200, panel(), 'text/html; charset=utf-8'), true
      }
      if (p === '/shot.jpg') {
        // 面板预览最近一张照片；没有就 404（不是错误，是还没拍）
        const file = String(lastImage?.() || '')
        try {
          if (!file) return text(res, 404, '还没有照片'), true
          const buf = fs.readFileSync(file)
          res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
          res.end(buf)
          return true
        } catch {
          return text(res, 404, '读不到照片文件'), true
        }
      }
      if (p === '/') {
        const addr = req.socket?.localAddress ?? '127.0.0.1'
        const port = req.socket?.localPort ?? cfg.get().port
        return (
          text(
            res,
            200,
            [
              'dsh-embodied-bridge（鲸鲸 v2 契约）',
              '',
              `设备接入：ws://${addr}:${port}${cfg.get().path}`,
              `面板：    http://${addr}:${port}/panel`,
              `状态：    http://${addr}:${port}/health`,
              '',
              `上行：${summarize().uplink.join(' / ')}`,
              `下行：${summarize().downlink.join(' / ')}`,
              `不具备：${Object.keys(summarize().unsupported).join(' / ')}`,
              '',
              '命令目录：',
              describeCommands(),
              '',
            ].join('\n'),
          ),
          true
        )
      }
    }

    // ---------------- v2 做不到、但保留路径说清楚 ----------------
    if (ROUTES.gone[p]) {
      if (!authorized(req)) return json(res, 401, { ok: false, error: '需要 Bearer 令牌（或在本机调用）' }), true
      return json(res, 501, { ok: false, error: { code: 'UNSUPPORTED', message: ROUTES.gone[p] } }), true
    }

    // ---------------- 动作（要令牌，除非本机） ----------------
    if (actSet.has(p)) {
      if (!authorized(req)) return json(res, 401, { ok: false, error: '需要 Bearer 令牌（或在本机调用）' }), true
      // 防 CSRF（E-06/BR-24）：任何带外站 Origin 的请求一律拒绝（含 <img>/跨站 fetch）。
      if (!originAllowed(req)) return json(res, 403, { ok: false, error: '跨站请求被拒绝（Origin 非本机）' }), true

      // /api/config 的 GET = 只读回显（配置 + 来源层 + 被覆盖项），便于排障；不改任何东西。
      if (p === '/api/config' && req.method === 'GET') {
        const layers = cfg.layerInfo ? cfg.layerInfo() : { sources: {}, shadowed: [] }
        const sources = {}
        for (const [k, v] of Object.entries(layers.sources)) {
          sources[k] = { from: v.from, value: redactConfig({ [k]: v.value })[k] }
        }
        return json(res, 200, {
          ok: true,
          config: redactConfig(cfg.get()),
          sources,
          shadowed: layers.shadowed.map((s) => ({
            key: s.key,
            file: redactConfig({ [s.key]: s.file })[s.key],
            patch: redactConfig({ [s.key]: s.patch })[s.key],
            effective: redactConfig({ [s.key]: s.effective })[s.key],
          })),
        }), true
      }

      // 动作一律 POST：GET 会被浏览器页面/图片标签在用户不知情时触发（CSRF）。
      if (req.method !== 'POST') {
        return json(res, 405, { ok: false, error: '动作接口只接受 POST（GET 会被 <img>/链接误触发）' }), true
      }

      if (p === '/api/face') {
        const mood = String(pick('mood', 'idle'))
        return json(res, 200, { ok: device.face(mood), mood }), true
      }
      if (p === '/say' || p === '/api/speak') {
        const t = String(pick('text', '')).trim()
        if (!t) return json(res, 400, { ok: false, error: 'text required' }), true
        const r = device.say(t.slice(0, 2000), pick('mood', undefined))
        if (r.sent && cfg.get().tts !== false) speaker.speak(r.text)
        return json(res, 200, { ok: r.sent, sent: r.sent, mood: r.mood, tts: Boolean(cfg.get().tts), online: device.online }), true
      }
      if (p === '/shot') {
        const out = await shootOnce({ timeoutMs: Number(pick('timeoutMs', 8000)) })
        return json(res, out.ok ? 200 : 504, out), true
      }
      if (p === '/api/config') {
        const keys = Object.keys(body)
        if (!keys.length) return json(res, 400, { ok: false, error: '空 patch' }), true
        // 白名单：只接受 DEFAULTS 里声明过的键（防 CSRF 后仍要防"写任意键/任意类型"）
        const unknown = keys.filter((k) => !Object.prototype.hasOwnProperty.call(DEFAULTS, k))
        if (unknown.length) {
          return json(res, 400, { ok: false, error: '未知配置项', unknown }), true
        }
        const badType = keys.filter((k) => body[k] !== null && typeof body[k] === 'object')
        if (badType.length) {
          return json(res, 400, { ok: false, error: '配置值必须是标量（字符串/数字/布尔）', badType }), true
        }
        const next = cfg.save(body)
        const layers = cfg.layerInfo ? cfg.layerInfo() : { sources: {} }
        // 被 patch 层盖住的键：写成功但实际值没变，必须显式告诉调用方（E-04/BR-26）
        const overridden = keys.filter(
          (k) => layers.sources[k]?.from === 'patch' && JSON.stringify(next[k]) !== JSON.stringify(body[k]),
        )
        const requiresRestart = keys.filter((k) => STARTUP_KEYS.has(k))
        if (overridden.length) log.warn(`配置写入 ${overridden.join(',')} 被 patch 层覆盖，实际未变（改 profile/cordis.patch.yml）`)
        log.info(`配置已更新：${keys.join(', ')}${requiresRestart.length ? `（${requiresRestart.join(',')} 需重启生效）` : ''}`)
        return json(res, 200, {
          ok: true,
          applied: keys,
          effective: redactConfig(Object.fromEntries(keys.map((k) => [k, next[k]]))),
          overridden,
          requiresRestart,
          config: redactConfig(next),
        }), true
      }
      if (p === '/api/linktest') {
        // 灌静音测链路带宽：不碰 TTS，设备侧时长就是真实吞吐（见 docs/故障手册 §12）
        if (!device.online) return json(res, 503, { ok: false, error: '设备不在线' }), true
        const out = await speaker.linkTest(Number(pick('seconds', 3)))
        log.info(`链路自检：${out.bytes} B（${out.seconds} s 静音）写入 ${out.writeMs} ms`)
        return json(res, 200, out), true
      }
    }

    return false
  }
}

/** 出声配置是否齐（用于 /health 与启动日志的显式告警，不猜）。 */
export function ttsConfigured(c) {
  if (c?.tts === false) return true
  // auto（默认）在缺少 key 时会回退 edge，所以 ttsConfigured 判断的是"实际生效的引擎"。
  const engine = ttsEngineOf(c)
  if (engine === 'deepseek') return Boolean(deepseekApiKeyOf(c?.deepseekApiKey))
  if (engine === 'breeze') return Boolean(String(c?.breezeApiKey || '').trim()) && Boolean(String(c?.breezeVoiceId || '').trim())
  if (engine === 'edge') return true
  if (engine === 'sapi') return true
  return false
}

/** 面板/接口回显配置时把密钥打码。 */
export function redactConfig(c) {
  const MASK = ['breezeApiKey', 'deepseekApiKey', 'panelToken', 'wsToken', 'asrCommand', 'asrServerCommand', 'ttsPython']
  const out = { ...c }
  for (const k of MASK) if (out[k]) out[k] = String(out[k]).length > 8 ? '***' : ''
  return out
}

export function newToken() {
  return 'eb_' + randomBytes(18).toString('base64url')
}
