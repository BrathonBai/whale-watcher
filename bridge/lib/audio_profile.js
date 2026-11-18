// audio_profile.js —— 音频编码协商 + 自适应码率的**纯逻辑**（不碰网络/不碰 ffmpeg）。
//
// 为什么单独一层：
//   1. 档位决策要能被单测覆盖（不需要真的设备/真的 ffmpeg）；
//   2. /api/diag 要能解释"为什么现在是这个码率"，所以每次决策都带 reason/evidence；
//   3. 说话有"每段回复只选一次档位"的要求——决策入口只有一个 selectProfile()，
//      speech.js 在 speak()（一段回复）时调一次，段内绝不重选。
//
// 健康度来源：设备 pong 里的诊断字段（bufMs / underruns / reconnects / rssi / codec）。
// 老设备 pong 只有 {"t":"pong"}，所有字段缺省——**缺字段不是错误**，按 unknown 处理。
//
// 档位映射（可解释常量，改阈值就改这里）：
//   健康（缓冲够、没有欠载）→ 24 kbps
//   中等（缓冲偏低 / 少量欠载）→ 16 kbps
//   差（缓冲见底 / 明显欠载）→ 8 kbps
//   连续 2 段都差、或 60 s 以上没有 pong → 回退 PCM 24 kHz（显式，不静默）
import {
  OPUS_DECODE_RATE,
  OPUS_DEFAULT_BITRATE,
  OPUS_FRAME_MS,
  clampOpusBitrate,
  clampOpusFrameMs,
  ffmpegLabel,
  ffmpegLooksUsable,
} from './opus_encode.js'
import { ADPCM } from './adpcm.js'

/** 自适应阈值/档位：全部写成可解释常量（面板/diag/迭代文档引用同一组值）。 */
export const ADAPTIVE = Object.freeze({
  /** 健康档码率（bps）。 */
  HEALTHY_BPS: 24000,
  /** 中等档码率（bps）。 */
  MEDIUM_BPS: 16000,
  /** 差档码率（bps）。 */
  LOW_BPS: 8000,
  /** 参与健康度评估的最近 pong 条数（滚动窗口）。 */
  WINDOW: 6,
  /** 健康：设备音频环形缓冲平均 ≥ 120 ms 且没有新增欠载。 */
  HEALTHY_MIN_BUF_MS: 120,
  /** 中等：平均 ≥ 60 ms 且新增欠载 ≤ 2 次。 */
  MEDIUM_MIN_BUF_MS: 60,
  HEALTHY_MAX_UNDERRUNS: 0,
  MEDIUM_MAX_UNDERRUNS: 2,
  /** 连续多少段回复都判"差"才回退 PCM（避免一次抖动就换编码）。 */
  POOR_STREAK_TO_FALLBACK: 2,
  /** 连接后超过 60 s 没有任何 pong（心跳 25 s/次）→ 判失联，回退 PCM。 */
  NO_PONG_MS: 60000,
  /** 编码连续失败后暂停 opus 的冷却时间；冷却结束自动重试（配置改动立即重算）。 */
  ENCODE_RETRY_MS: 60000,
  /** 连续编码失败多少次进入冷却。 */
  ENCODE_FAILS_TO_BLOCK: 2,
  /** PCM 回退格式（与固件 ES8311 / 旧契约一致）。 */
  PCM_RATE: OPUS_DECODE_RATE,
  PCM_BITS: 16,
  PCM_CHANNELS: 1,
})

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)
const nonNeg = (v) => (isFiniteNum(v) && v >= 0 ? v : null)

/**
 * 从 pong 历史里提取"缓冲/欠载"两个关键指标。
 *
 * underruns 是设备侧**累计计数**。设备重启会让计数归零（变小），
 * 所以增量只累加"尾部非递减"的那一段，避免把重启当成负欠载或巨量欠载。
 */
export function summarizePongWindow(history = []) {
  const list = Array.isArray(history) ? history.filter((x) => x && typeof x === 'object') : []
  const bufSamples = list.map((x) => nonNeg(x.bufMs)).filter((x) => x !== null)
  const avgBufMs = bufSamples.length ? bufSamples.reduce((a, b) => a + b, 0) / bufSamples.length : null
  const minBufMs = bufSamples.length ? Math.min(...bufSamples) : null

  const underrunsSamples = list.map((x) => nonNeg(x.underruns)).filter((x) => x !== null)
  let underruns = underrunsSamples.length ? underrunsSamples[underrunsSamples.length - 1] : null
  let underrunsDelta = null
  if (underrunsSamples.length >= 2) {
    let delta = 0
    for (let i = underrunsSamples.length - 1; i > 0; --i) {
      const d = underrunsSamples[i] - underrunsSamples[i - 1]
      if (d < 0) break // 设备重启/计数清零：只统计最后一段连续计数
      delta += d
    }
    underrunsDelta = delta
  } else if (underrunsSamples.length === 1) {
    underrunsDelta = 0 // 只有一条样本，无从比较；按"没新增"处理，但不据此判健康
  }

  const reconnectsSamples = list.map((x) => nonNeg(x.reconnects)).filter((x) => x !== null)
  const rssiSamples = list.map((x) => (isFiniteNum(x.rssi) && x.rssi !== 0 ? x.rssi : null)).filter((x) => x !== null)

  return {
    n: list.length,
    numeric: bufSamples.length + underrunsSamples.length,
    avgBufMs: avgBufMs === null ? null : Math.round(avgBufMs * 10) / 10,
    minBufMs,
    bufSamples: bufSamples.length,
    underruns,
    underrunsDelta,
    underrunsSamples: underrunsSamples.length,
    reconnects: reconnectsSamples.length ? reconnectsSamples[reconnectsSamples.length - 1] : null,
    rssi: rssiSamples.length ? rssiSamples[rssiSamples.length - 1] : null,
  }
}

/**
 * 判定健康档位。
 * @param {Array<object>} history 最近 pong 的 diag（device.pongHistory）
 * @param {{pongAgeMs?:number|null, connectedMs?:number}} clock 时间上下文
 * @returns {{tier:'healthy'|'medium'|'poor'|'unknown', reason:string, window:object}}
 */
export function classifyHealth(history = [], clock = {}) {
  const window = summarizePongWindow(history)
  const pongAgeMs = nonNeg(clock?.pongAgeMs)
  const connectedMs = nonNeg(clock?.connectedMs) ?? 0

  // 一条 pong 都没有：区分"刚连上还没轮到心跳"和"真的没 pong"。
  if (window.numeric === 0) {
    if (pongAgeMs !== null && pongAgeMs > ADAPTIVE.NO_PONG_MS) {
      return { tier: 'poor', reason: `${ADAPTIVE.NO_PONG_MS} ms 没有 pong（age=${pongAgeMs} ms）`, window }
    }
    if (pongAgeMs === null && connectedMs > ADAPTIVE.NO_PONG_MS) {
      return { tier: 'poor', reason: `连接 ${connectedMs} ms 从未收到 pong`, window }
    }
    return { tier: 'unknown', reason: '还没有 pong 健康数据（先按基准码率）', window }
  }

  const avg = window.avgBufMs
  const delta = window.underrunsDelta
  if (avg !== null) {
    // 待机噪声（2026-11-03 实测）：没在放音时 pong 的 bufMs 必然是 0，
    // 但"0 缓冲且没有新增欠载"不等于链路差 —— 之前把它判 poor，连续两段就把 Opus
    // 永久退回 PCM 了。这种样本先当 unknown（保持当前档位），真有欠载再降档。
    if (avg === 0 && (delta === null || delta <= 0)) {
      return {
        tier: 'unknown',
        reason: `缓冲为 0 且无新增欠载（多半是待机 pong）→ 暂不降档`,
        window,
      }
    }
    if (avg >= ADAPTIVE.HEALTHY_MIN_BUF_MS && (delta === null || delta <= ADAPTIVE.HEALTHY_MAX_UNDERRUNS)) {
      return {
        tier: 'healthy',
        reason: `缓冲平均 ${avg} ms、新增欠载 ${delta ?? '?'} → 健康`,
        window,
      }
    }
    if (avg >= ADAPTIVE.MEDIUM_MIN_BUF_MS && (delta === null || delta <= ADAPTIVE.MEDIUM_MAX_UNDERRUNS)) {
      return {
        tier: 'medium',
        reason: `缓冲平均 ${avg} ms、新增欠载 ${delta ?? '?'} → 中等`,
        window,
      }
    }
    return {
      tier: 'poor',
      reason: `缓冲平均 ${avg} ms、新增欠载 ${delta ?? '?'} → 差`,
      window,
    }
  }

  // 只有欠载计数、没有 bufMs（老固件/部分实现）：只按新增欠载判。
  if (delta !== null) {
    if (delta <= ADAPTIVE.HEALTHY_MAX_UNDERRUNS) {
      return { tier: 'healthy', reason: `新增欠载 ${delta}（没有 bufMs 字段）→ 健康`, window }
    }
    if (delta <= ADAPTIVE.MEDIUM_MAX_UNDERRUNS) {
      return { tier: 'medium', reason: `新增欠载 ${delta}（没有 bufMs 字段）→ 中等`, window }
    }
    return { tier: 'poor', reason: `新增欠载 ${delta}（没有 bufMs 字段）→ 差`, window }
  }

  return { tier: 'unknown', reason: 'pong 里没有可用的健康字段（老固件）', window }
}

/** 档位 → 码率。unknown 用配置里的基准码率；fixed 模式直接用配置值。 */
export function bitrateForTier(tier, fallbackBps = OPUS_DEFAULT_BITRATE) {
  if (tier === 'healthy') return ADAPTIVE.HEALTHY_BPS
  if (tier === 'medium') return ADAPTIVE.MEDIUM_BPS
  if (tier === 'poor') return ADAPTIVE.LOW_BPS
  return clampOpusBitrate(fallbackBps)
}

/** 规范化配置里的 audioCodec（非法值按 auto，不静默当 opus/adpcm）。 */
export function normalizeCodecPreference(v) {
  const s = String(v ?? 'auto').trim().toLowerCase()
  return s === 'opus' || s === 'pcm' || s === 'adpcm' ? s : 'auto'
}

const safeGet = (fn, dflt = undefined) => {
  try {
    const v = fn()
    return v === undefined ? dflt : v
  } catch {
    return dflt
  }
}

/**
 * 有状态的音频决策器：speech.js 每段回复调一次 selectProfile()；
 * http.js 的 /api/state|/api/diag 调 state() 取当前档位、依据、最近一次切换、编码统计。
 */
export function createAudioController({ cfg, log, device, now = () => Date.now() } = {}) {
  const say = (level, ...args) => {
    const fn = log?.[level]
    if (typeof fn === 'function') fn(...args)
  }

  let lastEncodeMs = 0
  let lastEncodeError = ''
  let encodeFails = 0
  let opusBlockedUntil = 0
  let poorStreak = 0
  // 健康度回退后的"保持位"：已经因连续差回退 PCM，就等健康度恢复（非 poor）再回 opus，
  // 避免"差→PCM→差→opus→差"来回抖（每段都重建编码/解码路径，听感更差）。
  let healthHold = false
  let lastDecision = null
  let lastSwitch = null
  let lastFallback = null
  let codecsKey = ''
  const warned = new Set()

  const deviceCodecs = () => {
    const cs = safeGet(() => device?.codecs, [])
    return Array.isArray(cs) ? cs.map((x) => String(x)) : []
  }
  const pongHistory = () => {
    const h = safeGet(() => device?.pongHistory, [])
    return Array.isArray(h) ? h : []
  }
  const clock = () => ({
    pongAgeMs: safeGet(() => device?.pongAgeMs, null),
    connectedMs: safeGet(() => device?.connectedMs, 0),
  })

  function warnOnce(key, msg) {
    if (warned.has(key)) return
    warned.add(key)
    say('warn', msg)
  }

  /** 设备/配置变化时清掉"只报一次"的内存，让新状态能重新告警。 */
  function syncDevice() {
    const key = deviceCodecs().join('|')
    if (key !== codecsKey) {
      codecsKey = key
      warned.clear()
      lastDecision = null
      poorStreak = 0
      healthHold = false
    }
  }

  /** 每段回复只调用一次：返回该段使用的编码档位（含可解释 reason）。
   *
   * 2026-11-13（BLE）新增 adpcm 分支，优先级：
   *   pcm 显式 → PCM；adpcm 显式 → 设备支持就 adpcm，否则 PCM；
   *   opus 显式 → 保持旧语义（ffmpeg 不可用 → PCM，不偷偷换 adpcm）；
   *   auto → 设备支持 adpcm 且 ffmpeg 不可用 → adpcm；否则沿用原来的 opus 自适应逻辑。
   */
  function selectProfile() {
    syncDevice()
    const c = cfg?.get?.() ?? {}
    const t = now()
    const want = normalizeCodecPreference(c.audioCodec)
    const adaptive = c.audioAdaptive !== false
    const frameMs = clampOpusFrameMs(c.opusFrameMs)
    const baseBps = clampOpusBitrate(c.opusBitrate)
    const codecs = deviceCodecs()
    const supportsOpus = codecs.includes('opus')
    const supportsAdpcm = codecs.includes('adpcm')
    const ffmpegOk = ffmpegLooksUsable(c.ttsFfmpeg)
    const health = classifyHealth(pongHistory(), clock())

    let codec = 'pcm'
    let bitrate = 0
    let reason = ''
    let tier = health.tier

    /** opus 的自适应决策（含健康度回退 PCM）。原逻辑原样搬进来，保证 PC/无 BLE 路径零回归。 */
    const decideOpus = () => {
      if (!adaptive) return { codec: 'opus', bitrate: baseBps, tier: 'fixed', reason: `自适应关闭，固定 ${baseBps} bps` }
      if (healthHold && health.tier === 'poor') {
        // 已经从"连续差"回退过 PCM：健康度没恢复前不来回抖。
        return { codec: 'pcm', bitrate: 0, tier: 'fixed', reason: `健康度仍差（${health.reason}），维持 PCM 直到恢复` }
      }
      if (healthHold) healthHold = false // 健康度已不是 poor → 解除保持位
      if (health.tier === 'poor') poorStreak += 1
      else poorStreak = 0
      if (poorStreak >= ADAPTIVE.POOR_STREAK_TO_FALLBACK) {
        const n = poorStreak
        poorStreak = 0
        healthHold = true // 等健康度恢复再回 opus
        const why = `连续 ${n} 段健康度差（${health.reason}）→ 回退 PCM ${ADAPTIVE.PCM_RATE}`
        warnOnce('poor-fallback', `音频：${why}（不静默换编码；恢复健康后自动回 opus）`)
        return { codec: 'pcm', bitrate: 0, tier: 'fixed', reason: why }
      }
      const bps = bitrateForTier(health.tier, baseBps)
      return { codec: 'opus', bitrate: bps, tier: health.tier, reason: `${health.reason} → ${bps} bps` }
    }

    if (want === 'pcm') {
      reason = '配置 audioCodec=pcm（强制 PCM 24k）'
      tier = 'fixed'
    } else if (want === 'adpcm') {
      tier = 'fixed'
      if (supportsAdpcm) {
        codec = 'adpcm'
        reason = `配置 audioCodec=adpcm（${ADPCM.bytesPerSecond} B/s，块 ${ADPCM.blockAlign} B）`
      } else {
        reason = `配置 audioCodec=adpcm 但设备 hello.codecs=[${codecs.join(',')}] 不含 adpcm → PCM`
        if (!lastEncodeError) lastEncodeError = reason
        warnOnce('no-adpcm', `音频：${reason}`)
      }
    } else if (want === 'opus') {
      // 显式 opus：保持旧语义（缺 ffmpeg → 本段 PCM），不静默改成 adpcm。
      if (!supportsOpus) {
        reason = codecs.length
          ? `设备 hello.codecs=[${codecs.join(',')}] 不含 opus → PCM`
          : '设备 hello 未声明 codecs（老固件）→ PCM'
        tier = 'fixed'
        warnOnce('no-opus', `音频：${reason}；要用 Opus 需固件在 hello 里声明 codecs`)
      } else if (!ffmpegOk) {
        reason = `opus encode unavailable：找不到 ffmpeg（ttsFfmpeg=${ffmpegLabel(c.ttsFfmpeg)}）→ 本段 PCM`
        tier = 'fixed'
        if (!lastEncodeError) lastEncodeError = reason
        warnOnce('no-ffmpeg', `音频：${reason}`)
      } else if (opusBlockedUntil > t) {
        reason = `opus 连续编码失败，冷却 ${Math.ceil((opusBlockedUntil - t) / 1000)} s 后重试 → 本段 PCM`
        tier = 'fixed'
      } else {
        ;({ codec, bitrate, tier, reason } = decideOpus())
      }
    } else {
      // auto
      if (supportsAdpcm && !ffmpegOk) {
        // 手机桥没有 ffmpeg：adpcm 是唯一能在 BLE 上跑起来的编码。
        codec = 'adpcm'
        tier = 'fixed'
        reason = `设备支持 adpcm 且 ffmpeg 不可用 → adpcm（${ADPCM.bytesPerSecond} B/s）`
      } else if (!supportsOpus) {
        tier = 'fixed'
        if (supportsAdpcm) {
          codec = 'adpcm'
          reason = `设备 hello.codecs=[${codecs.join(',')}] 不含 opus、含 adpcm → adpcm`
        } else {
          reason = codecs.length
            ? `设备 hello.codecs=[${codecs.join(',')}] 不含 opus/adpcm → PCM`
            : '设备 hello 未声明 codecs（老固件）→ PCM'
          warnOnce('no-codecs', `音频：${reason}`)
        }
      } else if (!ffmpegOk) {
        reason = `opus encode unavailable：找不到 ffmpeg（ttsFfmpeg=${ffmpegLabel(c.ttsFfmpeg)}）→ 本段 PCM`
        tier = 'fixed'
        if (!lastEncodeError) lastEncodeError = reason
        warnOnce('no-ffmpeg', `音频：${reason}`)
      } else if (opusBlockedUntil > t) {
        reason = `opus 连续编码失败，冷却 ${Math.ceil((opusBlockedUntil - t) / 1000)} s 后重试 → 本段 PCM`
        tier = 'fixed'
      } else {
        ;({ codec, bitrate, tier, reason } = decideOpus())
      }
    }

    const profile = {
      codec,
      bitrate,
      tier,
      adaptive,
      frameMs,
      // audio 头 rate 固定 24000（opus/adpcm 都是设备解码输出率；pcm 就是播放率）
      rate: OPUS_DECODE_RATE,
      bits: 16,
      ch: 1,
      samples: codec === 'adpcm' ? ADPCM.samplesPerBlock : undefined,
      reason,
      health: { tier: health.tier, reason: health.reason },
      at: t,
    }
    if (lastDecision && (lastDecision.codec !== codec || lastDecision.bitrate !== bitrate)) {
      lastSwitch = {
        at: t,
        from: { codec: lastDecision.codec, bitrate: lastDecision.bitrate },
        to: { codec, bitrate },
        reason,
      }
    }
    lastDecision = profile
    return profile
  }

  /** 编码结果回填（speech.js 在成功/失败后调用；失败必须带 error 文案）。 */
  function noteEncode({ ok, ms = 0, error = '', packetCount = 0 } = {}) {
    const t = now()
    if (ok) {
      lastEncodeMs = Math.max(0, Math.round(Number(ms) || 0))
      lastEncodeError = ''
      encodeFails = 0
      opusBlockedUntil = 0 // 成功即解除冷却（不用等时间到，状态也别再显示"暂停中"）
      return { ok: true, lastEncodeMs, lastEncodeError, encodeFails }
    }
    encodeFails += 1
    lastEncodeError = String(error || 'opus 编码失败（原因未提供）').slice(0, 400)
    if (encodeFails >= ADAPTIVE.ENCODE_FAILS_TO_BLOCK) {
      opusBlockedUntil = t + ADAPTIVE.ENCODE_RETRY_MS
      say(
        'warn',
        `音频：opus 连续编码失败 ${encodeFails} 次（最近：${lastEncodeError}）→ 暂停 opus ${ADAPTIVE.ENCODE_RETRY_MS / 1000} s，本段起回退 PCM`,
      )
    }
    return { ok: false, lastEncodeMs, lastEncodeError, encodeFails, packetCount }
  }

  /**
   * 本段编码失败/被引擎强制后真实回退 PCM 的留痕（speech.js 调用）：
   * 决策快照还是 opus/adpcm，但实际这一段是 PCM —— /api/diag.audio.effective 必须如实显示 pcm。
   * 2026-11-13：DeepSeek TTS 只出 PCM 24k，不经过 opus/adpcm 编码 → 也走这里留痕（不谎报 opus）。
   */
  function noteFallback({ reason = 'opus 不可用 → 本段显式回退 PCM', at = now() } = {}) {
    lastFallback = { at, reason }
    if (lastDecision?.codec && lastDecision.codec !== 'pcm') {
      lastSwitch = {
        at,
        from: { codec: lastDecision.codec, bitrate: lastDecision.bitrate },
        to: { codec: 'pcm', bitrate: 0 },
        reason,
      }
      lastDecision = { ...lastDecision, codec: 'pcm', bitrate: 0, tier: 'fallback', reason, at }
    }
    return lastFallback
  }

  /** /api/state.audio 与 /api/diag.audio 的数据源（只读、可解释）。 */
  function state() {
    syncDevice()
    const c = cfg?.get?.() ?? {}
    const want = normalizeCodecPreference(c.audioCodec)
    const adaptive = c.audioAdaptive !== false
    const frameMs = clampOpusFrameMs(c.opusFrameMs)
    const baseBps = clampOpusBitrate(c.opusBitrate)
    const codecs = deviceCodecs()
    const supportsOpus = codecs.includes('opus')
    const supportsAdpcm = codecs.includes('adpcm')
    const ffmpegOk = ffmpegLooksUsable(c.ttsFfmpeg)
    const health = classifyHealth(pongHistory(), clock())
    const win = health.window
    const lastDiag = safeGet(() => device?.lastDiag, null)
    const decided = lastDecision
    const t = now()
    // 预测「下一段会用哪个编码」：与 selectProfile 的分支一一对应，别忘了 adpcm。
    const predictedCodec = (() => {
      if (want === 'pcm') return 'pcm'
      if (want === 'adpcm') return supportsAdpcm ? 'adpcm' : 'pcm'
      if (want === 'opus') {
        return supportsOpus && ffmpegOk && opusBlockedUntil <= t && !(healthHold && health.tier === 'poor') ? 'opus' : 'pcm'
      }
      // auto
      if (supportsAdpcm && !ffmpegOk) return 'adpcm'
      if (!supportsOpus) return supportsAdpcm ? 'adpcm' : 'pcm'
      if (!ffmpegOk) return 'pcm'
      if (opusBlockedUntil > t || (healthHold && health.tier === 'poor')) return 'pcm'
      return 'opus'
    })()
    const predictedBitrate =
      predictedCodec === 'opus' ? (adaptive ? (healthHold ? baseBps : bitrateForTier(health.tier, baseBps)) : baseBps) : 0

    return {
      // 契约要求的字段（顺序稳定，面板/diag 直接读）
      codec: want, // 配置偏好：auto|opus|pcm|adpcm
      effective: decided?.codec ?? predictedCodec, // 实际生效（最近一段）
      bitrate: decided?.bitrate ?? predictedBitrate,
      adaptive,
      lastEncodeMs,
      lastEncodeError,
      pong: { ...(lastDiag && typeof lastDiag === 'object' ? lastDiag : {}), ageMs: clock().pongAgeMs },
      // 解释性字段
      tier: decided?.tier ?? health.tier,
      reason: decided?.reason ?? health.reason,
      health: { tier: health.tier, reason: health.reason },
      frameMs,
      lastDecidedAt: decided?.at ?? null,
      lastSwitch,
      lastFallback,
      encodeFails,
      opusBlockedUntil: opusBlockedUntil > t ? opusBlockedUntil : 0,
      window: win,
      device: {
        codecs,
        opusRate: safeGet(() => device?.opusRate, 0) || 0,
        supportsOpus,
        supportsAdpcm,
        // 2026-11-13（BLE）：链路与上行编码，面板上要能直接看出"现在是蓝牙还是 WiFi"。
        transport: safeGet(() => device?.transport, 'wifi') || 'wifi',
        uplink: safeGet(() => device?.uplink, 'pcm') || 'pcm',
        name: safeGet(() => device?.name, '') || '',
        mtu: safeGet(() => device?.mtu, 0) || 0,
        lastPongAt: safeGet(() => device?.lastPongAt, null),
      },
      ffmpeg: { configured: ffmpegLabel(c.ttsFfmpeg), usable: ffmpegLooksUsable(c.ttsFfmpeg) },
      // adpcm 是固定码率（没有自适应档位）：把线上参数摊开，别让人以为它也有 24k/16k/8k。
      adpcm: {
        rate: ADPCM.rate,
        blockAlign: ADPCM.blockAlign,
        samplesPerBlock: ADPCM.samplesPerBlock,
        bytesPerSecond: ADPCM.bytesPerSecond,
      },
      rates: {
        healthy: ADAPTIVE.HEALTHY_BPS,
        medium: ADAPTIVE.MEDIUM_BPS,
        poor: ADAPTIVE.LOW_BPS,
        base: baseBps,
      },
      pcmFallback: { rate: ADAPTIVE.PCM_RATE, bits: ADAPTIVE.PCM_BITS, ch: ADAPTIVE.PCM_CHANNELS },
    }
  }

  return {
    selectProfile,
    noteEncode,
    noteFallback,
    state,
    /** 测试/诊断用：当前段计数器（不影响生产逻辑）。 */
    get lastDecision() {
      return lastDecision
    },
    get lastSwitch() {
      return lastSwitch
    },
  }
}
