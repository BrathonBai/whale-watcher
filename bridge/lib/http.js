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

const HERE = path.dirname(fileURLToPath(import.meta.url))

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
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

export function createHttp({ cfg, log, device, brain, speaker, shootOnce, asr, startedAt, lastImage, storage }) {
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
        lastEvent: device.lastEvent,
        counters: device.counters,
        version: device.version,
        collecting: device.collecting,
        lastSpoken: device.lastSpoken,
      },
      capabilities: summarize(),
      storage: storage?.() ?? null,
      brain: { mode: brain.mode, effective: brain.effective, sessionId: brain.sessionId, busy: brain.busy },
      asr: { serverReady: asr?.serverReady ?? false, lastReason: asr?.lastReason ?? '' },
      tts: {
        engine: cfg.get().ttsEngine,
        on: Boolean(cfg.get().tts),
        configured: ttsConfigured(cfg.get()),
      },
      config: redactConfig(cfg.get()),
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
        if (!Object.keys(body).length) return json(res, 400, { ok: false, error: '空 patch' }), true
        const next = cfg.save(body)
        log.info(`配置已更新：${Object.keys(body).join(', ')}`)
        return json(res, 200, { ok: true, applied: Object.keys(body), config: redactConfig(next) }), true
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
  const engine = String(c?.ttsEngine || '')
  if (c?.tts === false) return true
  if (engine === 'breeze') return Boolean(String(c?.breezeApiKey || '').trim()) && Boolean(String(c?.breezeVoiceId || '').trim())
  if (engine === 'edge') return true
  if (engine === 'sapi') return true
  return false
}

/** 面板/接口回显配置时把密钥打码。 */
export function redactConfig(c) {
  const MASK = ['breezeApiKey', 'panelToken', 'asrCommand', 'asrServerCommand', 'ttsPython']
  const out = { ...c }
  for (const k of MASK) if (out[k]) out[k] = String(out[k]).length > 8 ? '***' : ''
  return out
}

export function newToken() {
  return 'eb_' + randomBytes(18).toString('base64url')
}
