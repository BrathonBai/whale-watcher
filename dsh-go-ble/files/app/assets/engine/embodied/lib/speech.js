// 出声：把一句话合成 PCM 再推给设备。
//
// 分工照小智：合成在桥侧，设备只写 I2S。三级引擎：
//   breeze → 指令式表演（最好听，要网络）
//   edge   → 微软神经 TTS（好听，起 python+ffmpeg 两个进程）
//   sapi   → Windows 自带（离线、快、机器味）
// 失败只记日志，绝不拦文本——没声音也得把字显示出来。
//
// 2026-11-03：新增 Opus 下发。编码选择来自 audio_profile.js 的协商结果（每段回复只选一次）；
// opus 路径 = 整段 PCM 合成 → ffmpeg/libopus 编码 → 裸 Opus 包按 20 ms 节奏推；
// 编码不可用/失败时**显式**回退 PCM（日志 + /api/state.audio.lastEncodeError），
// 绝不在句子中间偷偷换编码（听感会突变，设备侧也要重建解码器）。
import { chunkPcm, synthesize } from './tts.js'
import * as voiceCache from './voicecache.js'
import { synthesizeEdge } from './tts_edge.js'
import { streamBreeze, synthesizeBreeze } from './tts_breeze.js'
import { createAudioController } from './audio_profile.js'
import { encodePcmToOggOpus } from './opus_encode.js'
import { ADPCM, encodePcm as encodeAdpcmPcm } from './adpcm.js'
import { synthesizeDeepseek, normalizeVoice as normalizeDeepseekVoice } from './deepseek.js'
import { deepseekApiKeyOf, deepseekBaseUrlOf, ttsEngineOf } from './config.js'

/** 影响"声音"的身份参数：任何一个变了都不能复用旧音频包。 */
export function voiceIdentity(c = {}) {
  const engine = ttsEngineOf(c)
  const voice =
    engine === 'deepseek'
      ? normalizeDeepseekVoice(c.ttsVoice)
      : engine === 'breeze'
        ? c.breezeVoiceId || ''
        : engine === 'sapi'
          ? c.ttsVoiceSapi || ''
          : c.ttsVoice || ''
  return {
    engine,
    voice,
    model: engine === 'breeze' ? c.breezeModel || '' : '',
    speed: engine === 'breeze' ? c.breezeSpeed ?? '' : engine === 'deepseek' ? '' : c.ttsRate || '',
    guidance: engine === 'breeze' ? c.breezeGuidance ?? '' : '',
  }
}

/**
 * 台词包键：文本 + 编码 + 码率 + 声音身份。
 * 单独导出是为了测试能按"生产同一套字段"预置缓存（别在测试里手拼 key，否则一改就漏）。
 */
export function cacheKeyOf(text, c = {}, profile = { codec: 'pcm' }) {
  const codec = profile.codec === 'opus' ? 'opus' : 'pcm'
  return voiceCache.keyOf(text, {
    ...voiceIdentity(c),
    codec,
    bitrate: codec === 'opus' ? Math.round(Number(profile.bitrate) || 0) : 0,
    rate: codec === 'opus' ? Number(profile.rate) || 24000 : 24000,
    frameMs: codec === 'opus' ? Number(profile.frameMs) || 20 : 0,
  })
}

/** 切句再合成：整段一次合成要等 1.4~2.8 s，切开后第一句做完就能开口。 */
export function splitForTts(text, maxLen = 48) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return []
  const parts = s.split(/(?<=[。！？!?；;\n])/).map((x) => x.trim()).filter(Boolean)
  const out = []
  for (const p of parts) {
    if (p.length <= maxLen) {
      out.push(p)
      continue
    }
    for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen))
  }
  return out.length ? out : [s]
}

/**
 * PCM 汇聚器：保证每次发给设备的二进制帧都是 **偶数字节**、且不超过 16 KB。
 *
 * 为什么必须有它（2026-10-31 实测）：Breeze 流式 PCM 是按 curl 收到的原始分块往下发的，
 * 121 个分块里有 **72 个是奇数字节**（还夹着一堆 27 B 的碎片）。设备侧把每帧当 `int16_t*`
 * 取 `n/2` 个采样，奇数帧会丢掉最后 1 字节 → 之后所有样本错位一个字节 → 听感是满耳噪声。
 * 这里做两件事：① carry 把奇字节留到下一帧；② 超过 16 KB（固件 kMaxBinaryPayload）切开。
 */
export function makeEvenSink(send, maxBytes = 16384) {
  let carry = Buffer.alloc(0)
  const max = Math.max(2, maxBytes & ~1)
  return {
    push(chunk) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      let off = 0
      while (buf.length - off >= 2) {
        const n = Math.min(max, (buf.length - off) & ~1)
        if (n <= 0) break
        send(buf.subarray(off, off + n))
        off += n
      }
      carry = buf.subarray(off)
    },
    /** 收尾：剩 1 个字节凑不满一个采样，直接丢弃（不补 0，避免尾部爆音）。 */
    end() {
      const left = carry.length
      carry = Buffer.alloc(0)
      return left
    },
    get pending() {
      return carry.length
    },
  }
}

/**
 * 预缓冲闸门：攒够 `bytes` 字节再开始发，避免"边到边播"被首包延迟打成卡顿。
 *
 * 为什么（2026-10-31 实测）：Breeze 流式首包要 1117 ms 才到，而且前段是一阵一阵的
 * （260 块里最大块间隔 393 ms）。设备一收到 `audio` 头就开播，先播完 120 ms 头静音，
 * 接着就是空转等字节 —— 听感是"卡顿"。攒够 1000 ms 再发头+首批后，实测起播时领先
 * 896 ms，之后再没掉到 0 以下。
 *
 * onStart 在第一批字节之前调用，返回 false 表示放弃（比如设备下线/被按键打断）。
 */
export function makePrebufferGate({ bytes, onStart, send }) {
  const need = Math.max(0, bytes | 0)
  // 注意：即使 need === 0 也要等第一帧才触发 onStart，保证 audio 头永远在第一个二进制帧之前。
  let started = false
  let aborted = false
  let primed = 0
  let pending = []
  let pendingBytes = 0
  const flush = () => {
    if (started) return
    started = true
    primed = pendingBytes
    const ok = onStart ? onStart() !== false : true
    const batch = pending
    pending = []
    pendingBytes = 0
    if (!ok) {
      aborted = true
      return
    }
    for (const b of batch) send(b)
  }
  return {
    push(buf) {
      if (aborted) return
      if (started) {
        send(buf)
        return
      }
      pending.push(buf)
      pendingBytes += buf.length
      if (pendingBytes >= need) flush()
    },
    /** 收尾：不足预缓冲的短句也要发出去。 */
    start() {
      if (!started) flush()
    },
    get started() {
      return started
    },
    get aborted() {
      return aborted
    },
    /** 起播时攒下的字节数（用来记日志/测试）。 */
    get primed() {
      return primed
    },
  }
}

/**
 * PCM 下行单帧字节数：沿用 wsFrameBytes；固件 kMaxBinaryPayload 封顶 16384；必须偶数。
 * BLE 链路（hello.transport=ble 且声明 mtu）时再按「MTU-3 有效载荷」收窄——
 * 手机网关是透明转发，单帧按 MTU 对齐最稳（WiFi/老固件 mtu=0 → 完全按配置，行为不变）。
 */
export function pcmFrameBytes(c = {}, device = {}) {
  const want = Number(c.wsFrameBytes) || 4096
  let frame = Math.max(2, Math.min(16384, Math.floor(want / 2) * 2))
  const mtu = Number(device?.mtu) || 0
  if (String(device?.transport || '') === 'ble' && mtu >= 23) {
    frame = Math.min(frame, Math.max(2, Math.floor((mtu - 3) / 2) * 2))
  }
  return frame
}

export function createSpeaker({ cfg, log, device, encodePcm = encodePcmToOggOpus, synthesizeImpl = null, fetchImpl = null }) {
  let seq = 0
  let token = 0 // 每次开口 +1；按键打断也 +1，让正在跑的合成/推送立刻放弃
  // 一段回复只选一次档位：speak() 时算好，整段所有句子共用同一个 snapshot（句间不切码率）。
  const audio = createAudioController({ cfg, log, device })
  const queue = [] // { text, profile }
  let working = false
  // 测试注入点：生产走真实 synthOne（breeze/edge/sapi）；单测可传入纯函数避免出网/起子进程。
  const synthOnce = (text) => (typeof synthesizeImpl === 'function' ? synthesizeImpl(text) : synthOne(text))

  async function synthOne(text) {
    const c = cfg.get()
    // DeepSeek 官方 TTS（2026-11-13）：显式 deepseek，或 ttsEngine=auto 且配了 key。
    // 失败**不静默换引擎**（换声音是事故）——记录 lastEngineErr 后抛给 drain 记日志。
    if (ttsEngineOf(c) === 'deepseek') {
      try {
        const r = await synthesizeDeepseek(text, {
          apiKey: deepseekApiKeyOf(c.deepseekApiKey),
          baseUrl: deepseekBaseUrlOf(c.deepseekBaseUrl),
          voice: c.ttsVoice,
          timeoutMs: c.deepseekTimeoutMs,
          maxRetries: c.deepseekMaxRetries,
          backoffMs: c.deepseekRetryBackoffMs,
          fetchImpl,
          log,
        })
        lastEngine = 'deepseek'
        lastEngineErr = ''
        return r
      } catch (e) {
        lastEngineErr = 'deepseek: ' + (e?.message ?? e)
        log.warn('DeepSeek TTS 失败：', e?.message ?? e)
        throw e
      }
    }
    if (c.ttsEngine === 'breeze') {
      try {
        const r = await synthesizeBreeze(text, {
          apiKey: c.breezeApiKey,
          voiceId: c.breezeVoiceId,
          modelId: c.breezeModel,
          instructions: c.breezeInstructions,
          guidanceScale: c.breezeGuidance,
          speed: c.breezeSpeed,
          // 必须把代理传下去：不传就会先试 8 s 直连（Cloudflare 必超时）
          proxy: c.breezeProxy || undefined,
          ffmpeg: c.ttsFfmpeg || undefined,
        })
        lastEngine = 'breeze'; lastEngineErr = ''
        return r
      } catch (e) {
        lastEngineErr = 'breeze: ' + (e?.message ?? e)
        log.warn('Breeze TTS 失败，回退：', e?.message ?? e)
      }
    }
    if (c.ttsEngine === 'edge') {   // 审计修复：breeze 失败不再静默降级到 Edge
      try {
        lastEngine = 'edge'
        return await synthesizeEdge(text, {
          voice: c.ttsVoice || undefined,
          python: c.ttsPython || undefined,
          ffmpeg: c.ttsFfmpeg || undefined,
          rate: c.ttsRate || undefined,
        })
      } catch (e) {
        log.warn('edge TTS 失败，回退 SAPI：', e?.message ?? e)
      }
    }
    // AUDIT FIX 2026-10-31: never silently switch engine on failure.
    // Old code fell through to Windows SAPI here, so a Breeze failure
    // produced the wrong voice on the device.
    if (c.ttsEngine === 'sapi') {
      lastEngine = 'sapi'
      return synthesize(text, { voice: c.ttsVoiceSapi || '' })
    }
    throw new Error('TTS ' + c.ttsEngine + ' failed; fallback disabled to keep voice consistent')
  }

  let lastEngine = ''
  let lastEngineErr = ''

  /** 一段回复的 Opus 缓存键（键里含 codec/码率/声音身份，改任何一项都不会播旧包）。 */
  const opusCacheKeyFor = (text, profile) => cacheKeyOf(text, cfg.get(), profile)

  /**
   * 按 20 ms 节奏推裸 Opus 包（一个 WS 二进制帧 = 一个包）。
   *
   * 预缓冲沿用 PCM 的思路：先一次性把 ttsPreBufferMs 对应的包灌给设备（起播垫底），
   * 之后每 frameMs 供一包，让设备侧始终领先约 prebufferMs；丢包不补（直接放弃本段）。
   * 返回 true=整段发完；false=中途被打断/连接断了。
   */
  async function pushOpusPackets(packets, s, myToken, profile) {
    const c = cfg.get()
    const frameMs = Math.max(1, Number(profile?.frameMs) || 20)
    const preMs = Math.max(0, Number(c.ttsPreBufferMs) || 0)
    const prime = Math.min(packets.length, Math.max(1, Math.round(preMs / frameMs)))
    const head = device.audioHead({ codec: 'opus', rate: 24000, bits: 16, ch: 1, bytes: 0, seq: s })
    if (!head) return false
    for (let i = 0; i < packets.length; i++) {
      if (myToken !== token || !device.online) {
        // 已经发过 audio 头：补一个 audio_end（BR-10 同理），别让设备停在"头部没对账"的中间态。
        try {
          device.audioEnd(s)
        } catch {}
        return false
      }
      if (!device.sendBinary(packets[i])) {
        log.warn(`opus 帧下发失败（第 ${i + 1}/${packets.length} 包）——本段放弃，不补发`)
        try {
          device.audioEnd(s)
        } catch {}
        return false
      }
      // 前 prime 包一次性灌入（预缓冲），之后按 20 ms 节奏供包。
      if (i + 1 < packets.length && i + 1 >= prime) await new Promise((r) => setTimeout(r, frameMs))
    }
    device.audioEnd(s)
    return true
  }

  /**
   * Opus 路径：缓存命中直接重放；否则整段合成 → ffmpeg 编码 → 推包；整段成功才写缓存。
   * 返回 false = "这一段没法走 opus"（调用方**必须显式回退 PCM**；日志与 diag 已记录原因）。
   */
  async function speakOpus(text, myToken, profile, t0) {
    const c = cfg.get()
    const key = opusCacheKeyFor(text, profile)
    const hit = voiceCache.get(key)
    if (hit && hit.codec === 'opus' && hit.packets?.length) {
      const s = ++seq
      const ok = await pushOpusPackets(hit.packets, s, myToken, { ...profile, frameMs: hit.frameMs || profile.frameMs })
      log.info(`TTS opus 本地包 ${hit.packets.length} 包（${hit.bytes} B，不出网${ok ? '' : '，未播完'}）`)
      return true
    }

    let cur
    try {
      cur = await synthOnce(text)
    } catch (e) {
      log.warn('TTS 合成失败（opus 路径，未开始下发）：', e?.message ?? e)
      return false
    }
    if (myToken !== token || !device.online) return true
    if (cur.bits !== 16 || cur.channels !== 1) {
      const why = `PCM ${cur.rate}Hz/${cur.bits}bit/${cur.channels}ch 不是 16bit mono`
      audio.noteEncode({ ok: false, error: why })
      log.warn(`opus 编码跳过（${why}）→ 本段显式回退 PCM`)
      return false
    }

    const enc = await encodePcm({
      pcm: cur.pcm,
      inputRate: cur.rate,
      bitrate: profile.bitrate,
      frameMs: profile.frameMs,
      ffmpegPath: c.ttsFfmpeg,
    })
    if (!enc.ok) {
      audio.noteEncode({ ok: false, ms: enc.encodeMs ?? 0, error: `${enc.code}: ${enc.message}` })
      log.warn(`opus 编码失败（${enc.code}）→ 本段显式回退 PCM 24k：${enc.message}`)
      return false
    }
    audio.noteEncode({ ok: true, ms: enc.encodeMs, packetCount: enc.packetCount })

    const s = ++seq
    const ok = await pushOpusPackets(enc.packets, s, myToken, profile)
    if (ok && myToken === token) {
      // 整段成功才写缓存（半截音频比没有更糟）；写失败不影响这一段已经放出来的声音。
      try {
        const w = voiceCache.beginWrite(key, {
          codec: 'opus',
          rate: 24000,
          bits: 16,
          ch: 1,
          frameMs: profile.frameMs,
          bitrate: profile.bitrate,
          ...voiceIdentity(c),
        })
        for (const pkt of enc.packets) w.pushPacket(pkt)
        w.commit()
      } catch {}
    }
    log.info(
      `TTS opus ${enc.packetCount} 包 / ${enc.bytes} B（音频 ${Math.round(enc.durationMs)} ms，` +
        `合成+编码+下发 ${Date.now() - t0} ms，编码 ${enc.encodeMs} ms，${profile.tier}/${profile.bitrate}bps` +
        `${ok ? '' : '，未播完（不缓存）'}）`,
    )
    return true
  }

  /**
   * 放本地缓存的 PCM。节奏与"分句合成"分支完全一致（先给 1.2 s 余量，之后每 200 ms 补
   * 0.28 s）——不是为了好听，是为了别把设备的音频队列灌爆（固件 watchdog 一复位就表现为
   * "聊两句掉线"）。命中缓存时整段是现成的，但下发必须照旧限速。
   */
  async function playLocal(hit, s, myToken) {
    const { pcm, rate, bits, ch } = hit
    const bytesPerSec = rate * (bits / 8) * ch
    const step = Math.max(2, Math.floor(bytesPerSec * 0.28))
    let budget = Math.floor(bytesPerSec * 1.2)
    let off = 0
    device.audioHead({ codec: 'pcm', rate, bits, ch, bytes: pcm.length, seq: s })
    while (off < pcm.length) {
      if (myToken !== token || !device.online) return
      const take = Math.min(budget, pcm.length - off)
      for (const part of chunkPcm(pcm.subarray(off, off + take))) {
        if (myToken !== token || !device.online) return
        device.sendBinary(part)
      }
      off += take
      budget = step
      if (off < pcm.length) await new Promise((r) => setTimeout(r, 200))
    }
    device.audioEnd(s)
    log.info(`TTS 本地包 ${pcm.length} B（不出网）`)
  }

  // ============================ ADPCM 下发（BLE 链路，2026-11-13） ============================
  /**
   * 整段合成 → IMA ADPCM → 按 12 KB/s 的节奏下发（块边界 1024 B，末块短）。
   * 返回 false = 这一段没发出去（调用方**必须显式回退 PCM**并留痕）。
   * adpcm 块流格式见 lib/adpcm.js（与 ffmpeg adpcm_ima_wav 同构）。
   */
  async function speakAdpcm(text, myToken, profile, t0) {
    const c = cfg.get()
    let cur
    try {
      cur = await synthOnce(text)
    } catch (e) {
      log.warn('TTS 合成失败（adpcm 路径，未开始下发）：', e?.message ?? e)
      return false
    }
    if (myToken !== token || !device.online) return true
    // adpcm 的播放率写死 24000（设备解码后直接进 24k 环）；别的采样率走 PCM 回退。
    if (cur.bits !== 16 || cur.channels !== 1 || cur.rate !== ADPCM.rate) {
      const why = `PCM ${cur.rate}Hz/${cur.bits}bit/${cur.channels}ch 不是 24k/16bit/mono`
      audio.noteEncode({ ok: false, error: why })
      log.warn(`adpcm 跳过：${why}`)
      return false
    }
    const enc = encodeAdpcmPcm(cur.pcm)
    const s = ++seq
    const head = device.audioHead({
      codec: 'adpcm',
      rate: ADPCM.rate,
      bits: 16,
      ch: 1,
      bytes: enc.encoded.length,
      seq: s,
      samples: enc.samples,
    })
    if (!head) return false
    // 节拍：设备播放环约 2.5 s。先灌 ~1.2 s 的量垫底，之后每 200 ms 补 0.28 s，
    // 平均 ~2.4x 实时；BLE 数据率 12 KB/s、可用吞吐 20–60 KB/s，吃得住。
    const bps = ADPCM.bytesPerSecond
    const budget = Math.max(1024, Math.round((Math.max(0, Number(c.ttsPreBufferMs) || 0) / 1000) * bps))
    const step = Math.max(1024, Math.round(bps * 0.28))
    const frame = Math.max(1024, Math.min(16384, Number(c.wsFrameBytes) || 4096))
    let off = 0
    let win = budget
    while (off < enc.encoded.length) {
      if (myToken !== token || !device.online) {
        try {
          device.audioEnd(s)
        } catch {}
        return false
      }
      const take = Math.min(win, enc.encoded.length - off)
      for (let p = off; p < off + take; p += frame) {
        const part = enc.encoded.subarray(p, Math.min(p + frame, off + take))
        if (!part.length) continue
        if (!device.sendBinary(part)) {
          log.warn(`adpcm 块下发失败（${p}/${enc.encoded.length} B）→ 本段放弃，不补发`)
          try {
            device.audioEnd(s)
          } catch {}
          return false
        }
      }
      off += take
      win = step
      if (off < enc.encoded.length) await new Promise((r) => setTimeout(r, 200))
    }
    device.audioEnd(s)
    audio.noteEncode({ ok: true, ms: Date.now() - t0, packetCount: enc.blocks })
    log.info(
      `TTS adpcm ${enc.blocks} 块 / ${enc.encoded.length} B（PCM ${cur.pcm.length} B，` +
        `${Math.round((cur.pcm.length / 2 / ADPCM.rate) * 1000)} ms；合成+编码+下发 ${Date.now() - t0} ms）`,
    )
    return true
  }

  // ============================ DeepSeek TTS 下发（2026-11-13） ============================
  /**
   * DeepSeek TTS 路径：整段 HTTP 合成 24 kHz/16 bit/mono PCM → 一个 audio 头（带总字节数）
   * → 按 wsFrameBytes/MTU 分块限速下发 → audio_end。
   *
   * 为什么固定 pcm：DeepSeek 直接回裸 PCM（format=pcm），设备 pcm 下行直通，
   * 不需要 ffmpeg/libopus；协商快照若选了 opus/adpcm，本段也**显式**按 pcm 发（diag 留痕，不谎报）。
   * 返回 true=本段已处理（成功/中途被打断）；false=合成失败或对账失败（不再静默换引擎）。
   */
  async function speakDeepseekPcm(text, myToken, profile, t0) {
    const c = cfg.get()
    // 本地台词包命中 → 直接放，不重复计费（键里含 engine=deepseek + 实际音色）。
    const cacheKey = cacheKeyOf(text, c, { codec: 'pcm' })
    const cached = voiceCache.get(cacheKey)
    if (cached && cached.codec === 'pcm') {
      try {
        lastEngine = 'deepseek'
        await playLocal(cached, ++seq, myToken)
        return true
      } catch (e) {
        log.warn('DeepSeek 本地台词包播放失败，重新合成：', e?.message ?? e)
      }
    }

    let cur
    try {
      cur = await synthOnce(text)
    } catch {
      // 合成失败/截断：一个字节都不发（原因已由 synthOne 记进 engineError）。
      log.warn('DeepSeek TTS 未开始下发（本段没有声音，文本照常上屏）')
      return false
    }
    if (myToken !== token || !device.online) return true
    const pcm = cur?.pcm
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 !== 0) {
      const why = `DeepSeek PCM 非法（${Buffer.isBuffer(pcm) ? pcm.length : typeof pcm} B，需非空偶数字节）`
      lastEngineErr = 'deepseek: ' + why
      audio.noteEncode({ ok: false, error: why })
      log.warn('DeepSeek TTS 跳过：', why)
      return false
    }
    if (cur.rate !== 24000 || cur.bits !== 16 || cur.channels !== 1) {
      const why = `DeepSeek PCM ${cur.rate}Hz/${cur.bits}bit/${cur.channels}ch 不是 24k/16bit/mono`
      lastEngineErr = 'deepseek: ' + why
      audio.noteEncode({ ok: false, error: why })
      log.warn('DeepSeek TTS 跳过：', why)
      return false
    }

    const s = ++seq
    const head = device.audioHead({ codec: 'pcm', rate: 24000, bits: 16, ch: 1, bytes: pcm.length, seq: s })
    if (!head) return false
    const frame = pcmFrameBytes(c, device)
    // 限速沿用本地台词包的口径：先给 1.2 s 余量，之后每 200 ms 补 0.28 s（别把设备音频队列灌爆）。
    const bytesPerSec = 24000 * 2
    const step = Math.max(2, Math.floor(bytesPerSec * 0.28))
    let budget = Math.floor(bytesPerSec * 1.2)
    let off = 0
    let sent = 0
    while (off < pcm.length) {
      if (myToken !== token || !device.online) {
        try {
          device.audioEnd(s)
        } catch {}
        return false
      }
      const take = Math.min(budget, pcm.length - off)
      for (let p = off; p < off + take; p += frame) {
        if (myToken !== token || !device.online) break
        const part = pcm.subarray(p, Math.min(p + frame, off + take))
        if (!part.length) continue
        if (!device.sendBinary(part)) {
          lastEngineErr = `deepseek: 下行发送失败（${sent}/${pcm.length} B）`
          log.warn(`DeepSeek TTS 下行失败（已发 ${sent}/${pcm.length} B）→ 本段放弃，不补发`)
          try {
            device.audioEnd(s)
          } catch {}
          return false
        }
        sent += part.length
      }
      off += take
      budget = step
      if (off < pcm.length) await new Promise((r) => setTimeout(r, 200))
    }
    // 对账：实发字节必须等于 audio 头声明的总长度（半截音频宁可报失败也不当成功）。
    if (sent !== pcm.length) {
      lastEngineErr = `deepseek: 对账失败（头 ${pcm.length} B，实发 ${sent} B）`
      log.warn(`DeepSeek TTS 对账失败：audio 头 ${pcm.length} B，实发 ${sent} B`)
      try {
        device.audioEnd(s)
      } catch {}
      return false
    }
    device.audioEnd(s)
    log.info(
      `TTS deepseek ${pcm.length} B（${cur.ms} ms 音频；合成+下发 ${Date.now() - t0} ms，` +
        `request_id=${cur.requestId || '—'}，帧 ${frame} B` +
        `${profile?.codec && profile.codec !== 'pcm' ? `，协商 ${profile.codec} → 强制 pcm` : ''}）`,
    )
    // 整段成功才写本地台词包（半截音频比没有更糟）。
    try {
      const w = voiceCache.beginWrite(cacheKey, { codec: 'pcm', rate: 24000, bits: 16, ch: 1, ...voiceIdentity(c) })
      w.push(pcm)
      w.commit()
    } catch {}
    return true
  }

  // myToken 由 drain() 传入：**不要**在这里 ++token。
  // 2026-11-02 审计（BR-?）：原来是 `const myToken = ++token`，而 drain() 在循环顶部
  // 用进入时的 token 做 `myToken !== token` 判断 → 第一句播完 token 已经变了，
  // drain 认为"被打断"，清空 queue 退出 ⇒ 多句回复只有第一句会出声。
  /**
   * 档位快照：一段回复只选一次。
   * DeepSeek TTS 固定输出 PCM 24000 → 协商结果即使是 opus/adpcm 也强制 pcm，
   * 并用 noteFallback 在 /api/diag 留痕（effective 如实显示 pcm，不谎报 opus）。
   */
  function selectProfileFor(c) {
    const p = audio.selectProfile()
    if (ttsEngineOf(c) !== 'deepseek' || p.codec === 'pcm') return p
    const why = `DeepSeek TTS 直接输出 PCM 24000 → 本段按 pcm 下发（不编码 ${p.codec}）`
    audio.noteFallback({ reason: why })
    return { ...p, codec: 'pcm', bitrate: 0, tier: 'forced', reason: why }
  }

  async function speakOne(text, myToken, profile) {
    const c = cfg.get()
    if (!c.tts || !device.online || !text) return
    const t0 = Date.now()
    // 档位快照由 speak() 传入（一段回复只选一次）；直接调 speakOne 时兜底再选一次。
    const p = profile ?? selectProfileFor(c)

    // --- DeepSeek 路径：固定 PCM 24k 直通，不经过 opus/adpcm 编码 ---
    if (ttsEngineOf(c) === 'deepseek') {
      await speakDeepseekPcm(text, myToken, p, t0)
      return
    }

    // --- Opus 路径：只有协商结果是 opus 才走；失败由 speakOpus 显式记录并返回 false ---
    if (p.codec === 'opus') {
      const handled = await speakOpus(text, myToken, p, t0)
      if (handled) return
      // 落到这里 = 编码不可用/失败：本段**显式**回退 PCM（不静默换编码）。
      // 决策快照仍是 opus，但 diag 的 effective 要如实显示 pcm（noteFallback 留痕）。
      audio.noteFallback({ reason: 'opus 编码不可用/失败 → 本段显式回退 PCM 24k' })
    }

    // --- ADPCM 路径（2026-11-13 BLE）：协商结果是 adpcm 才走，失败显式回退 PCM ---
    if (p.codec === 'adpcm') {
      const handled = await speakAdpcm(text, myToken, p, t0)
      if (handled) return
      audio.noteFallback({ reason: 'adpcm 合成/编码失败 → 本段显式回退 PCM 24k' })
    }

    // --- 本地台词包（PCM）：命中就直接放，绕开云端 TTS ---
    // 会场的 2.4G 拥挤时，云端 TTS 是最大不确定源；固定句跑过一次就该永远在本地。
    const cacheKey = cacheKeyOf(text, c, { codec: 'pcm' })
    const cached = voiceCache.get(cacheKey)
    if (cached && cached.codec === 'pcm') {
      try {
        await playLocal(cached, ++seq, myToken)
        return
      } catch (e) {
        log.warn('本地包播放失败，退回在线合成：', e?.message ?? e)
      }
    }

    // --- 流式：/stream?output_format=pcm 边生成边推，首包快得多 ---
    if (c.ttsEngine === 'breeze' && c.breezeStream !== false) {
      const s0 = ++seq
      let writer = null
      let gate = null
      try {
        // 24000 Hz × 16 bit × 单声道 = 48 B/ms；对齐到偶数字节（整采样）。
        const preBytes = (Math.max(0, Math.round((Number(c.ttsPreBufferMs) || 0) * 48))) & ~1
        gate = makePrebufferGate({
          bytes: preBytes,
          onStart: () => {
            if (myToken !== token || !device.online) return false
            device.audioHead({ codec: 'pcm', rate: 24000, bits: 16, ch: 1, bytes: 0, seq: s0 })
            return true
          },
          send: (buf) => {
            if (myToken !== token || !device.online) return
            device.sendBinary(buf)
          },
        })
        // 关键：curl 的流式分块长度是任意的（实测 121 块里 72 块是奇数），
        // 必须经 makeEvenSink 对齐成偶数字节再发，否则设备端 int16 解析会整体错位 → 噪声。
        // 帧大小从 16 KB 降到 4 KB：丢一段只损失 ~85 ms 的音频，而不是 341 ms（TCP 队头阻塞）。
        // 边流边写本地包：整段成功才 commit，半截音频比没有音频更糟。
        writer = voiceCache.beginWrite(cacheKey, { codec: 'pcm', rate: 24000, bits: 16, ch: 1, ...voiceIdentity(c) })
        const sink = makeEvenSink((buf) => {
          writer.push(buf)
          gate.push(buf)
        }, Number(c.wsFrameBytes) || 4096)
        const n = await streamBreeze(
          text,
          {
            apiKey: c.breezeApiKey,
            voiceId: c.breezeVoiceId,
            modelId: c.breezeModel,
            instructions: c.breezeInstructions,
            guidanceScale: c.breezeGuidance,
            speed: c.breezeSpeed,
            proxy: c.breezeProxy || undefined,
          },
          (chunk) => sink.push(chunk),
        )
        const left = sink.end()
        gate.start() // 整段比预缓冲还短：攒完了再一次性发
        const complete = myToken === token && gate.started && !gate.aborted
        // BR-09：原来只有 beginWrite、全库没有 commit → 本地台词包永远是空的。
        // 只有整段成功且没被打断/放弃时才提交（半截音频比没有更糟）。
        if (complete) writer.commit()
        else writer.abort()
        if (complete) device.audioEnd(s0)
        const preMs = Math.round(gate.primed / 48)
        log.info(
          `TTS 流式 ${n} B（${Date.now() - t0} ms）` +
            (preMs ? `，预缓冲 ${preMs} ms` : '') +
            (left ? `，尾部丢 ${left} B（凑不满一个采样）` : '') +
            (complete ? '' : '，未完成（不缓存）'),
        )
        return
      } catch (e) {
        log.warn('Breeze 流式失败，整段重试（不是换引擎）：', e?.message ?? e)
        // BR-10：失败时写了一半的本地包要丢弃；若已经发过 audio 头，必须补一个
        // audio_end，否则设备停在"音频头未收尾"的中间态（下一段的对账会错）。
        try {
          writer?.abort()
        } catch {}
        try {
          if (gate?.started && !gate.aborted && myToken === token && device.online) device.audioEnd(s0)
        } catch {}
      }
    }

    const s1 = ++seq
    const parts = splitForTts(text)
    if (!parts.length) return
    let sent = 0
    let pending = synthOnce(parts[0])
    for (let i = 0; i < parts.length; ++i) {
      const cur = await pending
      if (myToken !== token || !device.online) return
      // 下一句与本句的推送并行
      if (i + 1 < parts.length) pending = synthOnce(parts[i + 1])
      device.audioHead({ codec: 'pcm', rate: cur.rate, bits: cur.bits, ch: cur.channels, bytes: cur.pcm.length, seq: s1 })
      // 节奏：一上来给 1.2 s 的余量（设备侧有解码/缓冲），之后每 200ms 补 0.28 s。
      // 给快了会把设备的音频队列灌爆，固件 watchdog 一复位就表现为"聊两句掉线"。
      const bytesPerSec = cur.rate * (cur.bits / 8) * cur.channels
      const step = Math.max(2, Math.floor(bytesPerSec * 0.28))
      let budget = Math.floor(bytesPerSec * 1.2)
      let off = 0
      while (off < cur.pcm.length) {
        if (myToken !== token || !device.online) return
        const take = Math.min(budget, cur.pcm.length - off)
        for (const part of chunkPcm(cur.pcm.subarray(off, off + take))) {
          if (myToken !== token || !device.online) return
          device.sendBinary(part)
        }
        off += take
        budget = step
        if (off < cur.pcm.length) await new Promise((r) => setTimeout(r, 200))
      }
      sent += cur.pcm.length
      // 分句路径也写本地台词包（流式关闭/失败时的兜底，BR-09）
      try {
        const ck = cacheKeyOf(parts[i], c, { codec: 'pcm' })
        if (!voiceCache.get(ck)) {
          const w = voiceCache.beginWrite(ck, { codec: 'pcm', rate: cur.rate, bits: cur.bits, ch: cur.channels, ...voiceIdentity(c) })
          w.push(cur.pcm)
          w.commit()
        }
      } catch {}
    }
    device.audioEnd(s1)
    log.info(`TTS ${sent} B / ${parts.length} 句（合成+下发 ${Date.now() - t0} ms）`)
  }

  async function drain() {
    working = true
    const myToken = token
    try {
      while (queue.length) {
        if (myToken !== token || !device.online) {
          queue.length = 0
          break
        }
        const item = queue.shift()
        // profile 是 speak() 时的档位快照：同一段回复的所有句子共用，句间不切码率。
        await speakOne(item.text, myToken, item.profile)
      }
    } catch (e) {
      log.warn('TTS 失败（只影响声音）：', e?.message ?? e)
    } finally {
      working = false
    }
  }

  const speaker = {
    /** 入队一段回复（内部按句切，出句即合成）。 */
    speak(text) {
      const s = String(text || '').trim()
      if (!s) return
      // 每段回复只选一次档位：在整段入口定下来，句与句之间不重选（听感/设备解码都稳定）。
      // DeepSeek TTS 只出 PCM → 这里强制 pcm 并留痕（不谎报 opus/adpcm）。
      const profile = selectProfileFor(cfg.get())
      for (const p of splitForTts(s)) queue.push({ text: p, profile })
      if (!working) void drain()
    },
    /** 打断：正在合成/推送的那一句立刻放弃，队列清空。 */
    stop() {
      ++token
      queue.length = 0
    },
    get busy() {
      return working
    },
    get pending() {
      return queue.length
    },
    /**
     * 链路自检：往设备灌 N 秒**静音 PCM**，完全不经过 TTS。
     * 用途（2026-10-31）：分清"播放卡顿"是供给慢还是链路窄 —— 静音没有生成延迟，
     * 设备侧 `audio` 头到 `audio_end` 的耗时就是这条链路真实能吃的带宽。
     * 返回我们写了多少字节、写进 socket 用了多久（不是到达耗时，到达要看设备串口）。
     */
    async linkTest(seconds = 3) {
      const c = cfg.get()
      const rate = 24000
      const total = Math.max(1, Math.min(30, Number(seconds) || 3)) * rate * 2
      const s = ++seq
      const t0 = Date.now()
      device.audioHead({ codec: 'pcm', rate, bits: 16, ch: 1, bytes: 0, seq: s })
      const frame = Buffer.alloc(4096) // 静音
      let sent = 0
      while (sent < total) {
        const n = Math.min(frame.length, total - sent)
        if (!device.sendBinary(frame.subarray(0, n))) break
        sent += n
        if (sent % (256 * 1024) === 0) await new Promise((r) => setImmediate(r))
      }
      device.audioEnd(s)
      return {
        ok: sent === total,
        rate,
        seconds: Math.round((sent / (rate * 2)) * 100) / 100,
        bytes: sent,
        writeMs: Date.now() - t0,
        note: '到达耗时看设备串口：音频头 → 音频收尾 的时间差，除以 seconds 就是链路倍速',
        engine: ttsEngineOf(c),
      }
    },
  }
  Object.defineProperty(speaker, 'engine', { get: () => lastEngine })
  Object.defineProperty(speaker, 'engineError', { get: () => lastEngineErr })
  /** 音频决策器（编码协商 + 自适应 + 编码统计）：供 /api/state.audio | /api/diag 与测试读取。 */
  Object.defineProperty(speaker, 'audio', { get: () => audio })
  speaker.audioState = () => audio.state()
  return speaker
}
