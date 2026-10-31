// dsh-embodied-bridge —— 把具身节点（SensePort Watcher / 鲸鲸 v2）接进 DSH 大脑。
//
// 两个方向：
//   设备 → 大脑：voice（按键录完上传）/ image（8 s 周期 + 按需）→ 设备自己的 DSH 会话
//   大脑 → 设备：device_* 六个工具 / HTTP / 面板 → say / face / shot / audio / ping
//
// 这一版（v0.3）是对着 v2 固件重写的，不是给 v0.2 打补丁：
//   · 契约收敛到 contract.js：上行 4 种、下行 7 种；其余显式拒绝；
//   · 删掉 record/mic/listen 那条链——v2 没有对端，留着只会让模型空转；
//   · 新增 shot（拍一张）与 device_capabilities（如实告诉模型能做什么）；
//   · 启动时就把"TTS 没配好 / ASR 不可用"喊出来，不再表现为"设备没反应"。
//
// 架构参考 aurabot 的三条做法（仍然沿用）：
//   1. 能力都登记在 ctx 上（工具、事件、服务），停插件时一起撤掉；
//   2. ctx.provide('embodied', …) 暴露服务，别的插件/会话用 ctx.get('embodied') 直接调；
//   3. 一套自服务的 HTTP 面板：状态、动作、事件、配置改完即生效。
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createConfig, dataDir } from './config.js'
import { summarize } from './contract.js'
import { dirStats, pruneDir } from './retention.js'
import { guessMood, parseDeviceMessage, PROTOCOL_VERSION } from './protocol.js'
import { createDevice } from './device.js'
import { createSpeaker } from './speech.js'
import { createAsr } from './asr.js'
import { createBrain } from './brain.js'
import { createTools } from './tools.js'
import { createHttp, newToken, ttsConfigured } from './http.js'

export const name = 'embodied-bridge'
export const inject = ['tools', 'llm']

const FALLBACKS = [
  '嗯…我这会儿有点卡，你再说一遍？',
  '我在，刚刚没接上话，再说一次？',
  '脑子慢了半拍，你刚说什么？',
  '听得见你，就是回得慢了点，再来一次。',
]

function makeLogger(file) {
  const safeJson = (v) => {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ` + args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ') + '\n'
    try {
      fs.appendFileSync(file, line)
    } catch {}
  }
  return {
    info: (...a) => {
      console.log('[embodied]', ...a)
      write('I', a)
    },
    warn: (...a) => {
      console.warn('[embodied]', ...a)
      write('W', a)
    },
  }
}

const clampReply = (text, max) => {
  const s = String(text ?? '').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const m = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('.'), cut.lastIndexOf('！'), cut.lastIndexOf('!'))
  return m > max * 0.5 ? cut.slice(0, m + 1) : cut + '…'
}

function wavBytes(pcm, rate = 24000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

export function apply(ctx, pluginConfig) {
  const cfg = createConfig(pluginConfig)
  const startedAt = Date.now()
  const dir = dataDir()
  const logFile =
    String(cfg.get().logFile || '').trim() ||
    path.join(process.env.LOCALAPPDATA || process.env.HOME || os.tmpdir(), 'hubdev', 'bridge.log')
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const st = fs.statSync(logFile)
    if (st.size > 8 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1')
  } catch {}
  const log = makeLogger(logFile)

  log.info(`—— 启动 v0.3（v2 契约）· ${new Date().toISOString()} · 配置 ${path.join(dir, 'config.json')}`)
  log.info(`   上行 ${summarize().uplink.join('/')} · 下行 ${summarize().downlink.join('/')}`)

  // 启动即按保留策略清一次：上次运行可能留下很多图/语音（设备以前是 8 秒一张）
  const imgMatch = (n) => n.endsWith('.jpg')
  const wavMatch = (n) => n.endsWith('.wav')
  const prStart = {
    images: pruneDir(imageDir(), cfg.get().imageKeep, imgMatch),
    voice: pruneDir(voiceDir(), cfg.get().voiceKeep, wavMatch),
  }
  const stStart = { images: dirStats(imageDir(), imgMatch), voice: dirStats(voiceDir(), wavMatch) }
  log.info(
    `   存储：图片 ${stStart.images.files} 张 / ${(stStart.images.bytes / 1e6).toFixed(1)} MB` +
      `，语音 ${stStart.voice.files} 段 / ${(stStart.voice.bytes / 1e6).toFixed(1)} MB` +
      `（保留最近 ${cfg.get().imageKeep} 张 / ${cfg.get().voiceKeep} 段）`,
  )
  if (prStart.images.removed || prStart.voice.removed) {
    log.info(`   启动清理：图片删 ${prStart.images.removed}，语音删 ${prStart.voice.removed}`)
  }

  // ---------------- 生命周期折叠 ----------------
  const offs = []
  const on = (disposer) => {
    if (typeof disposer === 'function') offs.push(disposer)
    return disposer
  }
  const effect = (fn, label) => {
    try {
      if (typeof ctx.effect === 'function') return on(ctx.effect(fn, label))
      return on(fn())
    } catch (e) {
      log.warn(`登记 ${label ?? ''} 失败：`, e?.message ?? e)
      return undefined
    }
  }

  // ---------------- 图片：落盘 + 等待者 ----------------
  let lastImagePath = ''
  const recentImages = []
  const imageWaiters = []

  function imageDir() {
    const base = String(cfg.get().workspaceDir || '').trim() || path.join(dataDir(), 'workspace')
    const d = path.join(base, 'images')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  function saveImage(acc) {
    // 设备侧 base64 解码会带出尾部 0（JPEG 以 FF D9 结束），落盘前裁掉
    let buf = acc.buf
    let end = buf.length
    while (end > 2 && buf[end - 1] === 0 && buf[end - 2] === 0) end -= 1
    const trimmed = acc.buf.length - end
    if (trimmed) buf = buf.subarray(0, end)
    const file = path.join(imageDir(), `sw-${Date.now()}-${acc.w}x${acc.h}.jpg`)
    fs.writeFileSync(file, buf)
    log.info(`图片已保存 ${file}${trimmed ? `（裁掉尾部 ${trimmed} B 零填充）` : ''}`)
    lastImagePath = file
    recentImages.push(file)
    while (recentImages.length > 3) recentImages.shift()
    // 保留策略：只留最近 imageKeep 张。设备改成"按需拍照"之后数量不可预测，
    // 而模型/面板真正用到的只有最新一张（2026-10-31 用户要求，避免占盘又没人清）。
    const pr = pruneDir(imageDir(), cfg.get().imageKeep, (n) => n.endsWith('.jpg'))
    if (pr.removed) log.info(`图片清理：删 ${pr.removed} 张（保留 ${pr.kept}，释放 ${(pr.bytesFreed / 1024).toFixed(0)} KB）`)
    const info = { ok: true, path: file, bytes: buf.length, w: acc.w, h: acc.h, ms: acc.ms }
    for (const w of imageWaiters.splice(0)) w(info)
    return info
  }

  /** 等下一张图；超时返回 {ok:false,error}，绝不挂死。 */
  function waitForImage({ timeoutMs = 8000 } = {}) {
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        const i = imageWaiters.indexOf(finish)
        if (i >= 0) imageWaiters.splice(i, 1)
        resolve(v)
      }
      const timer = setTimeout(() => finish({ ok: false, error: '等图超时（设备没在 timeoutMs 内传完）' }), Math.max(1000, timeoutMs))
      timer.unref?.()
      imageWaiters.push(finish)
    })
  }

  // ---------------- 组装 ----------------
  const device = createDevice({
    cfg,
    log,
    onMessage: (raw) => onDeviceMessage(raw),
    onVoice: (acc) => void finishVoice(acc),
    onImage: (acc) => {
      try {
        saveImage(acc)
      } catch (e) {
        log.warn('图片保存失败', e?.message ?? e)
      }
    },
    onOpen: () => {},
    onClose: () => {
      for (const w of imageWaiters.splice(0)) w({ ok: false, error: '设备断开' })
    },
  })

  const speaker = createSpeaker({ cfg, log, device })
  const asr = createAsr({ cfg, log, dsh: ctx })

  const brain = createBrain({
    cfg,
    log,
    dsh: ctx,
    onReply: (text, meta) => {
      const max = Number(cfg.get().maxReplyChars) || 240
      const reply = clampReply(text, max)
      if (!reply) return
      const mood = guessMood(reply)
      device.say(reply, mood)
      if (cfg.get().tts !== false) speaker.speak(reply)
      log.info(`[${meta?.mode ?? '?'}] 答：${reply.slice(0, 60)}`)
    },
    onTurnStart: () => {
      speaker.stop()
      device.face('think')
    },
    onThinking: () => {
      if (!device.online) return
      device.say('嗯…', 'think')
    },
    onError: (e) => {
      const sorry = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)]
      log.warn('大脑这条链路失败了：', e?.code ?? '', e?.message ?? '')
      device.say(sorry, 'sad')
      if (cfg.get().tts !== false) speaker.speak(sorry)
    },
  })

  // ---------------- 语音片段 ----------------
  function voiceDir() {
    const d = path.join(dir, 'voice')
    try {
      fs.mkdirSync(d, { recursive: true })
    } catch {}
    return d
  }

  async function finishVoice(acc) {
    if (!acc || acc.got === 0) return
    const secs = acc.got / 2 / acc.rate
    const p = path.join(voiceDir(), `voice-${new Date().toISOString().replace(/[:.]/g, '-')}-${acc.seq}.wav`)
    try {
      fs.writeFileSync(p, wavBytes(acc.buf, acc.rate))
    } catch (e) {
      log.warn('写 WAV 失败：', e?.message ?? e)
      return
    }
    log.info(`语音片段 ${acc.got} B（${secs.toFixed(1)}s）→ ${p}`)
    // 语音同样只留最近 N 段：识别完的 WAV 只是排查用的证据，不必长期堆着。
    const pv = pruneDir(voiceDir(), cfg.get().voiceKeep, (n) => n.endsWith('.wav'))
    if (pv.removed) log.info(`语音清理：删 ${pv.removed} 段（保留 ${pv.kept}，释放 ${(pv.bytesFreed / 1024).toFixed(0)} KB）`)

    const { text, route, ms } = await asr.transcribe(p)
    if (!text) {
      // 显式失败：把"哪一路都没成"的原因写全，而不是只说一句"没听清"
      log.warn(`ASR 空（route=${route}，${secs.toFixed(1)}s/${acc.got}B）：${asr.lastReason || '没有可用识别引擎'}`)
      const hint = '没听清，再说一次？'
      device.say(hint, 'listen')
      if (cfg.get().tts !== false) speaker.speak(hint)
      return
    }
    log.info(`ASR(${route}, ${ms}ms) → ${text}`)
    const withImg = lastImagePath ? `${text}\n（刚刚的环境照片：${lastImagePath}）` : text
    if (lastImagePath) log.info('本轮附照片 ' + lastImagePath)
    await handleUserText(withImg, 'voice')
  }

  async function handleUserText(text, via) {
    const r = await brain.submit(text, { via })
    if (!r.ok) log.warn(`这条没答上来（${r.error?.code}）：${String(text).slice(0, 40)}`)
    return r
  }

  // ---------------- 上行分发 ----------------
  function onDeviceMessage(raw) {
    const parsed = parseDeviceMessage(raw)
    if (!parsed.ok) {
      log.warn('上行被拒：', parsed.error.code, parsed.error.message)
      return
    }
    const m = parsed.msg
    device.ingest(m)

    switch (m.t) {
      case 'hello': {
        log.info(`设备上线 fw=${m.fw} board=${m.board} ver=${m.ver} cam=${m.cam} ${m.w}x${m.h}`)
        device.welcome()
        device.face('idle')
        brain.prewarm?.()
        break
      }
      case 'pong':
        break
      case 'image':
      case 'voice':
        // 头已经由 device.ingest 建好采集器，二进制随后到；这里不用再做别的
        break
      default:
        break
    }
  }

  // ---------------- 按需拍照 ----------------
  async function shootOnce({ timeoutMs = 8000 } = {}) {
    if (!device.online) return { ok: false, error: '设备不在线' }
    const t0 = Date.now()
    const waiting = waitForImage({ timeoutMs: Math.max(1500, Number(timeoutMs) || 8000) })
    const sent = device.shot()
    if (!sent) {
      const r = await Promise.race([waiting, Promise.resolve({ ok: false, error: 'shot 下发失败' })])
      return r.ok ? r : { ok: false, error: 'shot 下发失败（设备可能刚断开）' }
    }
    const got = await waiting
    if (!got.ok) return got
    log.info(`按需拍照完成 ${got.bytes} B（${Date.now() - t0} ms）→ ${got.path}`)
    return got
  }

  // ---------------- 工具 ----------------
  const tools = createTools({ cfg, log, device, brain, speaker, shootOnce })
  const registered = []
  for (const t of tools) {
    try {
      const off = ctx.tools.register(t)
      if (typeof off === 'function') offs.push(off)
      registered.push(t.name)
    } catch (e) {
      log.warn(`工具 ${t.name} 注册失败：`, e?.message ?? e)
    }
  }
  log.info(`工具就绪：${registered.join(' / ') || '(无)'}`)

  // ---------------- 会话事件 ----------------
  effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        brain.handleSessionEvent(session, event)
      } catch (e) {
        log.warn('会话事件处理出错：', e?.message ?? e)
      }
    })
    return typeof off === 'function' ? off : () => {}
  }, 'embodied: session/event')

  // ---------------- 服务（给别的插件用） ----------------
  const streamSay = (text, mood) => {
    const r = device.say(clampReply(text, Number(cfg.get().maxReplyChars) || 240), mood)
    if (r.sent && cfg.get().tts !== false) speaker.speak(r.text)
    return r
  }
  const service = {
    version: '0.3.0',
    get online() {
      return device.online
    },
    get sessionId() {
      return brain.sessionId
    },
    status: () => ({
      online: device.online,
      connectedMs: device.connectedMs,
      version: device.version,
      brain: brain.mode,
      sessionId: brain.sessionId,
      lastImage: lastImagePath,
      recentImages,
      collecting: device.collecting,
      seq: device.counters.seq,
    }),
    capabilities: () => device.capabilities,
    say: (text, mood) => streamSay(text, mood),
    face: (mood) => device.face(mood),
    speak: (text) => {
      const r = device.say(clampReply(text, Number(cfg.get().maxReplyChars) || 240), guessMood(text))
      if (r.sent && cfg.get().tts !== false) speaker.speak(r.text)
      return r.sent
    },
    shot: (opts) => shootOnce(opts),
    /** 把一句话交给设备的大脑（等价于设备自己说了这句话）。 */
    submit: (text, via = 'api') => handleUserText(String(text ?? ''), via),
    events: (after, limit) => device.since(after, limit),
  }
  try {
    if (typeof ctx.provide === 'function') ctx.provide('embodied', service)
  } catch (e) {
    log.warn('登记 embodied 服务失败：', e?.message ?? e)
  }

  // ---------------- HTTP + WS ----------------
  const handleHttp = createHttp({
    cfg,
    log,
    device,
    brain,
    speaker,
    shootOnce,
    asr,
    startedAt,
    lastImage: () => lastImagePath,
    storage: () => ({
      images: { ...dirStats(imageDir(), imgMatch), keep: Number(cfg.get().imageKeep) || 0 },
      voice: { ...dirStats(voiceDir(), wavMatch), keep: Number(cfg.get().voiceKeep) || 0 },
    }),
  })

  const server = http.createServer(async (req, res) => {
    try {
      if (await handleHttp(req, res)) return
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
    } catch (e) {
      log.warn('HTTP 处理出错：', e?.message ?? e)
      try {
        res.writeHead(500).end('error')
      } catch {}
    }
  })
  server.on('upgrade', (req, socket, head) => {
    try {
      device.handleUpgrade(req, socket, head)
    } catch (e) {
      log.warn('升级 WS 失败：', e?.message ?? e)
      try {
        socket.destroy()
      } catch {}
    }
  })
  server.on('error', (e) => log.warn('HTTP 服务错误：', e?.message ?? e))
  server.listen(Number(cfg.get().port) || 7788, String(cfg.get().host || '0.0.0.0'), () => {
    const a = server.address()
    log.info(`监听 ws://${a.address}:${a.port}${cfg.get().path}  面板 http://127.0.0.1:${a.port}/panel`)
  })

  // ---------------- 局域网发现 ----------------
  let disco = null
  try {
    disco = dgram.createSocket('udp4')
    disco.on('message', (msg, rinfo) => {
      const reply = JSON.stringify({ t: 'here', svc: 'embodied-bridge', port: Number(cfg.get().port), ver: PROTOCOL_VERSION })
      disco.send(reply, rinfo.port, rinfo.address, () => {})
      log.info(`发现请求来自 ${rinfo.address}:${rinfo.port} → 已回应`)
    })
    disco.on('error', (e) => log.warn('发现端口错误：', e?.message ?? e))
    disco.bind(Number(cfg.get().discoverPort) || 7789, '0.0.0.0', () => {
      log.info(`发现端口 udp://0.0.0.0:${Number(cfg.get().discoverPort) || 7789}`)
    })
  } catch (e) {
    log.warn('发现端口起不来：', e?.message ?? e)
  }

  // ---------------- 心跳 ----------------
  const heartbeat = setInterval(() => {
    if (device.online) device.ping()
  }, Math.max(5000, Number(cfg.get().heartbeatMs) || 25000))
  heartbeat.unref?.()

  // ---------------- 显式告警：别让"没声音/没识别"表现成"设备坏了" ----------------
  const c0 = cfg.get()
  if (c0.tts !== false && !ttsConfigured(c0)) {
    log.warn(`TTS 没配好：engine=${c0.ttsEngine} 但缺少 ${c0.ttsEngine === 'breeze' ? 'breezeApiKey/breezeVoiceId' : '必要参数'} → 设备只会亮屏不会出声`)
  }
  if (String(c0.asr || '') !== 'off' && !String(c0.asrServerCommand || '').trim() && !String(c0.asrCommand || '').trim()) {
    log.warn('ASR 没有配 asrServerCommand / asrCommand：只能指望 DSH 自带的 speechToText，识别不出来时会返回 route=none')
  }
  asr.warm?.()

  if (!String(cfg.get().panelToken || '').trim()) {
    log.info('面板令牌为空：动作类接口只认本机（要给别的机器用，配 panelToken 例如 ' + newToken() + '）')
  }

  // ---------------- 收尾 ----------------
  const dispose = () => {
    log.info('—— 停止')
    clearInterval(heartbeat)
    try {
      disco?.close()
    } catch {}
    try {
      server.close()
    } catch {}
    device.dispose?.()
    speaker.stop()
    asr.dispose?.()
    brain.dispose?.()
    for (const off of offs.splice(0)) {
      try {
        off()
      } catch {}
    }
  }
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', dispose)
    } catch (e) {
      log.warn('注册 dispose 失败（靠返回的 dispose 兜底）：', e?.message ?? e)
    }
  }
  return dispose
}
