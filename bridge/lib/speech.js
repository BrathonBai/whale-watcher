// 出声：把一句话合成 PCM 再推给设备。
//
// 分工照小智：合成在桥侧，设备只写 I2S。三级引擎：
//   breeze → 指令式表演（最好听，要网络）
//   edge   → 微软神经 TTS（好听，起 python+ffmpeg 两个进程）
//   sapi   → Windows 自带（离线、快、机器味）
// 失败只记日志，绝不拦文本——没声音也得把字显示出来。
import { chunkPcm, synthesize } from './tts.js'
import { synthesizeEdge } from './tts_edge.js'
import { streamBreeze, synthesizeBreeze } from './tts_breeze.js'

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

export function createSpeaker({ cfg, log, device }) {
  let seq = 0
  let token = 0 // 每次开口 +1；按键打断也 +1，让正在跑的合成/推送立刻放弃
  const queue = []
  let working = false

  async function synthOne(text) {
    const c = cfg.get()
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
  async function speakOne(text) {
    const c = cfg.get()
    if (!c.tts || !device.online || !text) return
    const t0 = Date.now()
    const myToken = ++token

    // --- 流式：/stream?output_format=pcm 边生成边推，首包快得多 ---
    if (c.ttsEngine === 'breeze' && c.breezeStream !== false) {
      const s0 = ++seq
      try {
        // 24000 Hz × 16 bit × 单声道 = 48 B/ms；对齐到偶数字节（整采样）。
        const preBytes = (Math.max(0, Math.round((Number(c.ttsPreBufferMs) || 0) * 48))) & ~1
        const gate = makePrebufferGate({
          bytes: preBytes,
          onStart: () => {
            if (myToken !== token || !device.online) return false
            device.audioHead({ rate: 24000, bits: 16, ch: 1, bytes: 0, seq: s0 })
            return true
          },
          send: (buf) => {
            if (myToken !== token || !device.online) return
            device.sendBinary(buf)
          },
        })
        // 关键：curl 的流式分块长度是任意的（实测 121 块里 72 块是奇数），
        // 必须经 makeEvenSink 对齐成偶数字节再发，否则设备端 int16 解析会整体错位 → 噪声。
        const sink = makeEvenSink((buf) => gate.push(buf))
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
        if (myToken === token && gate.started && !gate.aborted) device.audioEnd(s0)
        const preMs = Math.round(gate.primed / 48)
        log.info(
          `TTS 流式 ${n} B（${Date.now() - t0} ms）` +
            (preMs ? `，预缓冲 ${preMs} ms` : '') +
            (left ? `，尾部丢 ${left} B（凑不满一个采样）` : ''),
        )
        return
      } catch (e) {
        log.warn('Breeze 流式失败，退回分句合成：', e?.message ?? e)
      }
    }

    const s1 = ++seq
    const parts = splitForTts(text)
    if (!parts.length) return
    let sent = 0
    let pending = synthOne(parts[0])
    for (let i = 0; i < parts.length; ++i) {
      const cur = await pending
      if (myToken !== token || !device.online) return
      // 下一句与本句的推送并行
      if (i + 1 < parts.length) pending = synthOne(parts[i + 1])
      device.audioHead({ rate: cur.rate, bits: cur.bits, ch: cur.channels, bytes: cur.pcm.length, seq: s1 })
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
        const s = queue.shift()
        await speakOne(s)
      }
    } catch (e) {
      log.warn('TTS 失败（只影响声音）：', e?.message ?? e)
    } finally {
      working = false
    }
  }

  const speaker = {
    /** 入队一句（内部按句切，出句即合成）。 */
    speak(text) {
      const s = String(text || '').trim()
      if (!s) return
      for (const p of splitForTts(s)) queue.push(p)
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
      device.audioHead({ rate, bits: 16, ch: 1, bytes: 0, seq: s })
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
        engine: c.ttsEngine,
      }
    },
  }
  Object.defineProperty(speaker, 'engine', { get: () => lastEngine })
  Object.defineProperty(speaker, 'engineError', { get: () => lastEngineErr })
  return speaker
}
