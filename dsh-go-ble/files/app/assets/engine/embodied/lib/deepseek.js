// deepseek.js —— DeepSeek 官方语音 API：TTS（/v1/tools/tts）与 ASR（/v1/tools/asr）。
//
// 为什么 TTS 走「全量 HTTP + format=pcm」而不是 WebSocket 流式（2026-11-13 决策）：
//   · 设备回复 ≤240 字，整句合成后一次就能拿到 24 kHz/16 bit/mono 裸 PCM；
//   · 现有下行本来就是「audio 头（带 bytes）+ 二进制块 + audio_end」，整段长度已知，
//     对账最简单；WS 流式多一套状态机/半截音频语义，收益只是首包早 ~1 s，不值得。
//
// 官方端点（2026-11-13 文档核对）：
//   TTS: POST {base}/v1/tools/tts
//        JSON {text(必填, ≤10000 计费字符), voice_id(stella/tide), format(wav/pcm),
//              filter_markdown(默认 true)}
//        响应体 = 流式音频（audio/wav 或裸 pcm）；**合成中途失败会提前截断**。
//        → 这里用 content-length / 整采样对齐判「截断」，截断一律当失败重试或报错，
//          绝不把半截音频当成功下发（设备侧会听成一句断掉的话 + audio_end 对不上账）。
//   ASR: POST {base}/v1/tools/asr
//        multipart/form-data，字段名 file；16-bit PCM WAV（8/16/22.05/24/32/44.1/48 kHz，
//        单/立体声，只识别左声道）或 Ogg Opus；≤8 MiB、≤120 s、上传限 10 min。
//        返回 {request_id, text, duration_ms}。
//
// 错误码：400 格式 / 408 上传超时 / 413 过大 / 429 并发 / 503 忙 / 504 识别超时。
// 429、503 指数退避重试；ASR 504 只额外重试一次。
//
// 日志纪律：只打 request_id、耗时、字符数/音频时长/字节数；**绝不打 Authorization / API key**。
import fs from 'node:fs'
import path from 'node:path'
import { deepseekApiKeyOf, deepseekBaseUrlOf } from './config.js'

export const DEEPSEEK_TTS_PATH = '/v1/tools/tts'
export const DEEPSEEK_ASR_PATH = '/v1/tools/asr'
/** DeepSeek TTS 音色：stella=默认女声，tide=男声。 */
export const DEEPSEEK_VOICES = Object.freeze(['stella', 'tide'])
export const DEEPSEEK_DEFAULT_VOICE = 'stella'
/** TTS 计费上限（字符）；正常回复 ≤240 字，远达不到。 */
export const DEEPSEEK_TTS_MAX_CHARS = 10000
/** TTS 固定要 pcm：24 kHz / 16 bit / mono（与设备 ES8311 一致，不做重采样）。 */
export const DEEPSEEK_TTS_RATE = 24000
/** ASR 限制（官方）：≤8 MiB、≤120 s。 */
export const DEEPSEEK_ASR_MAX_BYTES = 8 * 1024 * 1024
export const DEEPSEEK_ASR_MAX_SECONDS = 120
/** ASR 接受的 WAV 采样率（官方 8/16/22.05/24/32/44.1/48 kHz）。 */
export const DEEPSEEK_ASR_RATES = Object.freeze([8000, 16000, 22050, 24000, 32000, 44100, 48000])

/** DeepSeek 调用的结构化错误（带 HTTP 状态/request_id/是否可重试，供 ASR/TTS 决定退避）。 */
export class DeepSeekError extends Error {
  constructor(message, { code = 'DEEPSEEK_ERROR', status = 0, requestId = '', retryable = false } = {}) {
    super(String(message))
    this.name = 'DeepSeekError'
    this.code = code
    this.status = Number(status) || 0
    this.requestId = String(requestId || '')
    this.retryable = Boolean(retryable)
  }
}

/** 音色归一：stella/tide 之外（老 edge 音色名等）一律回默认 stella。 */
export function normalizeVoice(voice) {
  const v = String(voice ?? '').trim().toLowerCase()
  return DEEPSEEK_VOICES.includes(v) ? v : DEEPSEEK_DEFAULT_VOICE
}

/** TTS 请求体（纯函数，测试直接断言）。 */
export function buildTtsBody(text, { voice = '', format = 'pcm', filterMarkdown = true } = {}) {
  return {
    text: String(text ?? ''),
    voice_id: normalizeVoice(voice),
    format: format === 'wav' ? 'wav' : 'pcm',
    filter_markdown: filterMarkdown !== false,
  }
}

/** base URL 去尾部斜杠（传 https://api.deepseek.com/ 也不会拼出 //v1）。 */
export function normalizeBaseUrl(baseUrl) {
  const v = String(baseUrl ?? '').trim() || deepseekBaseUrlOf()
  return v.replace(/\/+$/, '')
}

/**
 * PCM（s16le）→ 44 字节标准 WAV 头 + PCM。
 * 设备上行（ADPCM 解码后）与 DeepSeek ASR 上传共用这一条：24 kHz/16 bit/mono。
 */
export function pcmToWav(pcm, { rate = DEEPSEEK_TTS_RATE, bits = 16, ch = 1 } = {}) {
  if (!Buffer.isBuffer(pcm)) throw new TypeError('pcmToWav 需要 Buffer')
  if (bits !== 16) throw new DeepSeekError(`只支持 16 bit PCM，实际 ${bits}`, { code: 'BAD_WAV' })
  if (ch !== 1 && ch !== 2) throw new DeepSeekError(`只支持 mono/stereo，实际 ${ch} ch`, { code: 'BAD_WAV' })
  const r = Number(rate)
  if (!DEEPSEEK_ASR_RATES.includes(r)) throw new DeepSeekError(`采样率 ${rate} 不在 WAV 支持范围`, { code: 'BAD_WAV' })
  const blockAlign = (bits / 8) * ch
  if (!pcm.length || pcm.length % blockAlign !== 0) {
    throw new DeepSeekError(`PCM 长度 ${pcm.length} B 不是整采样（${blockAlign} B/采样）`, { code: 'BAD_WAV' })
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16) // fmt chunk 长度
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(ch, 22)
  h.writeUInt32LE(r, 24)
  h.writeUInt32LE(r * blockAlign, 28)
  h.writeUInt16LE(blockAlign, 32)
  h.writeUInt16LE(bits, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** 解析 16-bit PCM WAV：返回 fmt/data 与 PCM 视图；坏文件抛 DeepSeekError。 */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw new DeepSeekError('不是合法 WAV：数据太短', { code: 'BAD_WAV' })
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new DeepSeekError('不是合法 WAV：缺 RIFF/WAVE', { code: 'BAD_WAV' })
  }
  let off = 12
  let fmt = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      if (size < 16) throw new DeepSeekError('WAV fmt 块太短', { code: 'BAD_WAV' })
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (!fmt) throw new DeepSeekError('WAV 缺 fmt 块', { code: 'BAD_WAV' })
      const avail = buf.length - body
      const dataBytes = Math.min(size, Math.max(0, avail))
      return {
        ...fmt,
        dataOffset: body,
        dataSize: size,
        dataBytes,
        truncated: size > dataBytes,
        pcm: buf.subarray(body, body + dataBytes),
      }
    }
    off = body + size + (size % 2)
  }
  throw new DeepSeekError('WAV 缺 data 块', { code: 'BAD_WAV' })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clampInt = (v, dflt, min, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** 只能重试的状态码：429 并发/限流、503 服务忙（官方文档）。 */
const RETRY_STATUS = new Set([429, 503])
const STATUS_HINT = {
  400: '请求格式错误',
  408: '上传超时',
  413: '音频过大（≤8 MiB / ≤120 s）',
  429: '并发/限流，稍后重试',
  503: '服务忙，稍后重试',
  504: '识别/合成超时',
}

function httpError(kind, status, detail, requestId = '') {
  const hint = STATUS_HINT[status] ? `（${STATUS_HINT[status]}）` : ''
  const tail = detail ? `：${String(detail).slice(0, 300)}` : ''
  return new DeepSeekError(`DeepSeek ${kind} HTTP ${status}${hint}${tail}`, {
    code: `HTTP_${status}`,
    status,
    requestId,
    retryable: RETRY_STATUS.has(status),
  })
}

function networkError(e, timeoutMs) {
  const name = String(e?.name ?? '')
  const msg = String(e?.message ?? e ?? '')
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|aborted/i.test(msg)) {
    return new DeepSeekError(`DeepSeek 请求超时（${timeoutMs} ms）`, { code: 'TIMEOUT', retryable: true })
  }
  return new DeepSeekError(`DeepSeek 网络失败：${msg || '未知错误'}`, { code: 'NETWORK', retryable: true })
}

function requestIdOf(res) {
  try {
    const h = res?.headers
    return String(h?.get?.('x-request-id') ?? h?.get?.('x-ds-request-id') ?? h?.get?.('request-id') ?? '').trim()
  } catch {
    return ''
  }
}

async function readErrorDetail(res) {
  try {
    const text = await res.text()
    return String(text ?? '')
  } catch {
    return ''
  }
}

/** retry-after 头（秒或 HTTP 日期）→ ms；没有就 null。 */
function retryAfterMs(res) {
  try {
    const raw = res?.headers?.get?.('retry-after')
    if (!raw) return null
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(15000, Math.round(secs * 1000))
    const at = Date.parse(raw)
    if (Number.isFinite(at)) return Math.max(0, Math.min(15000, at - Date.now()))
    return null
  } catch {
    return null
  }
}

/** 指数退避（优先服务端 retry-after），返回实际等待 ms。 */
async function waitBeforeRetry(opt, attempt, res, label, log) {
  const base = clampInt(opt.backoffMs, 800, 0, 10000)
  const hinted = retryAfterMs(res)
  const ms = hinted === null ? Math.min(8000, base * 2 ** attempt) : hinted
  if (ms > 0) await (typeof opt.sleepImpl === 'function' ? opt.sleepImpl(ms) : sleep(ms))
  log?.warn?.(`${label} 第 ${attempt + 2} 次尝试前退避 ${ms} ms`)
  return ms
}

function resolveFetch(opt) {
  const f = opt.fetchImpl || globalThis.fetch
  if (typeof f !== 'function') throw new DeepSeekError('当前运行环境没有 fetch（需要 Node 18+）', { code: 'NO_FETCH' })
  return f
}

function looksLikeWav(buf) {
  return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
}

/**
 * 读 TTS 响应体并校验成 24k/16bit/mono PCM。
 * 截断（content-length 对不上 / 奇数采样字节）一律失败：半截音频不能下发。
 */
async function readTtsAudio(res) {
  const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase()
  const rawLength = res.headers?.get?.('content-length')
  const declared = rawLength === null || rawLength === undefined || rawLength === '' ? null : Number(rawLength)
  let buf
  try {
    buf = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    throw new DeepSeekError(`TTS 读响应失败：${e?.message ?? e}`, { code: 'READ_FAILED', retryable: true })
  }
  if (declared !== null && Number.isFinite(declared) && declared >= 0 && buf.length !== declared) {
    throw new DeepSeekError(`TTS 响应截断：声明 ${declared} B，实收 ${buf.length} B（半截音频不当成功）`, {
      code: 'TRUNCATED',
      retryable: true,
    })
  }
  if (!buf.length) throw new DeepSeekError('TTS 响应是空音频', { code: 'EMPTY_AUDIO', retryable: true })
  // 200 也可能夹 JSON 错误（网关/代理异常）。content-type 明确时上面就判了；
  // 这里再按"短且以 { 开头"兜底一次，避免把错误 JSON 当 PCM 放成噪声。
  if (buf.length < 4096 && buf[0] === 0x7b) {
    try {
      const j = JSON.parse(buf.toString('utf8'))
      if (j && typeof j === 'object') {
        const detail = String(j?.error?.message ?? j?.message ?? '')
        throw new DeepSeekError(`TTS 返回的是 JSON 而不是音频${detail ? `：${detail}` : ''}`, { code: 'BAD_CONTENT_TYPE' })
      }
    } catch (e) {
      if (e instanceof DeepSeekError) throw e
      // 不是 JSON：按 PCM 继续（首字节恰好是 0x7b 的采样很罕见，但不能误判）
    }
  }
  if (contentType.includes('json')) {
    let detail = ''
    try {
      const j = JSON.parse(buf.toString('utf8'))
      detail = String(j?.error?.message ?? j?.message ?? '')
    } catch {}
    throw new DeepSeekError(`TTS 返回的是 JSON 而不是音频${detail ? `：${detail}` : ''}`, { code: 'BAD_CONTENT_TYPE' })
  }
  let pcm = buf
  if (contentType.includes('wav') || looksLikeWav(buf)) {
    const wav = parseWav(buf)
    if (wav.format !== 1 || wav.bits !== 16) {
      throw new DeepSeekError(`TTS WAV 不是 16 bit PCM（format=${wav.format} bits=${wav.bits}）`, { code: 'BAD_AUDIO' })
    }
    if (wav.rate !== DEEPSEEK_TTS_RATE || wav.channels !== 1) {
      throw new DeepSeekError(`TTS 返回 ${wav.rate}Hz/${wav.channels}ch，期望 24000Hz/1ch`, { code: 'BAD_AUDIO' })
    }
    if (wav.truncated) throw new DeepSeekError('TTS WAV data 块被截断', { code: 'TRUNCATED', retryable: true })
    pcm = wav.pcm
  }
  if (pcm.length % 2 !== 0) {
    throw new DeepSeekError(`TTS PCM 字节数 ${pcm.length} 是奇数（16 bit 采样被截断）`, { code: 'ODD_PCM', retryable: true })
  }
  return {
    pcm,
    rate: DEEPSEEK_TTS_RATE,
    bits: 16,
    channels: 1,
    bytes: pcm.length,
    ms: Math.round((pcm.length / 2 / DEEPSEEK_TTS_RATE) * 1000),
  }
}

/**
 * 合成一段语音（全量 HTTP，format=pcm）。
 *
 * @param {string} text
 * @param {{apiKey?:string, baseUrl?:string, voice?:string, fetchImpl?:Function, log?:object,
 *          timeoutMs?:number, maxRetries?:number, backoffMs?:number, sleepImpl?:Function}} opt
 * @returns {Promise<{pcm:Buffer, rate:number, bits:number, channels:number, bytes:number,
 *                    ms:number, requestId:string, attempts:number, elapsedMs:number}>}
 */
export async function synthesizeDeepseek(text, opt = {}) {
  const input = String(text ?? '').trim()
  if (!input) throw new DeepSeekError('TTS 文本为空', { code: 'EMPTY_TEXT' })
  if (input.length > DEEPSEEK_TTS_MAX_CHARS) {
    throw new DeepSeekError(`TTS 文本 ${input.length} 字超过上限 ${DEEPSEEK_TTS_MAX_CHARS}`, { code: 'TEXT_TOO_LONG' })
  }
  const apiKey = opt.apiKey === undefined ? deepseekApiKeyOf() : String(opt.apiKey).trim()
  if (!apiKey) {
    throw new DeepSeekError('缺少 deepseekApiKey（配 deepseekApiKey 或环境变量 DEEPSEEK_API_KEY）', { code: 'NO_API_KEY' })
  }
  const fetchImpl = resolveFetch(opt)
  const url = normalizeBaseUrl(opt.baseUrl) + DEEPSEEK_TTS_PATH
  const body = buildTtsBody(input, { voice: opt.voice, format: opt.format, filterMarkdown: opt.filterMarkdown })
  const timeoutMs = clampInt(opt.timeoutMs, 30000, 1000, 120000)
  const maxRetries = clampInt(opt.maxRetries, 2, 0, 5)
  const log = opt.log
  const t0 = Date.now()
  let lastError = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'audio/*, application/octet-stream',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      lastError = networkError(e, timeoutMs)
      if (attempt < maxRetries) {
        await waitBeforeRetry(opt, attempt, null, 'DeepSeek TTS', log)
        continue
      }
      throw lastError
    }
    const requestId = requestIdOf(res)
    if (!res.ok) {
      const detail = await readErrorDetail(res)
      lastError = httpError('TTS', res.status, detail, requestId)
      if (lastError.retryable && attempt < maxRetries) {
        log?.warn?.(`DeepSeek TTS HTTP ${res.status}（request_id=${requestId || '—'}），准备重试`)
        await waitBeforeRetry(opt, attempt, res, 'DeepSeek TTS', log)
        continue
      }
      throw lastError
    }
    try {
      const audio = await readTtsAudio(res)
      const elapsedMs = Date.now() - t0
      log?.info?.(
        `DeepSeek TTS 完成：${input.length} 字 → ${audio.pcm.length} B PCM（${audio.ms} ms 音频），` +
          `request_id=${requestId || '—'}，耗时 ${elapsedMs} ms（第 ${attempt + 1} 次）`,
      )
      return { ...audio, text: input, voice: body.voice_id, requestId, attempts: attempt + 1, elapsedMs }
    } catch (e) {
      lastError = e instanceof DeepSeekError ? e : new DeepSeekError(String(e?.message ?? e), { code: 'TTS_FAILED' })
      if (lastError.retryable && attempt < maxRetries) {
        log?.warn?.(`DeepSeek TTS 响应不合格（${lastError.code}：${lastError.message}），准备重试`)
        await waitBeforeRetry(opt, attempt, null, 'DeepSeek TTS', log)
        continue
      }
      throw lastError
    }
  }
  throw lastError ?? new DeepSeekError('DeepSeek TTS 失败（未知原因）', { code: 'TTS_FAILED' })
}

/** 把各种输入（WAV 文件 / WAV Buffer / {pcm,rate}）统一成待上传的 WAV 与时长信息。 */
function resolveWavInput(input, opt = {}) {
  let bytes
  let filename = String(opt.filename ?? 'voice.wav')
  if (Buffer.isBuffer(input)) {
    bytes = input
  } else if (input && typeof input === 'object' && Buffer.isBuffer(input.pcm)) {
    // 设备上行解出来的裸 PCM：这里补 44 字节 WAV 头再传（官方要求 WAV 或 Ogg Opus）。
    // 上行若因丢包/抖动多出半个采样（奇数字节），按整采样截掉 1 B——不能因为 1 B 让整句识别失败。
    const pcm = input.pcm.length % 2 ? input.pcm.subarray(0, input.pcm.length - 1) : input.pcm
    if (!pcm.length) throw new DeepSeekError('ASR 输入的 PCM 为空', { code: 'BAD_INPUT' })
    bytes = pcmToWav(pcm, { rate: Number(input.rate) || DEEPSEEK_TTS_RATE })
  } else {
    const p = typeof input === 'string' ? input : String(input?.path ?? input?.wavPath ?? '')
    if (!p) throw new DeepSeekError('ASR 输入缺 WAV 路径或 pcm', { code: 'BAD_INPUT' })
    bytes = fs.readFileSync(p)
    filename = String(opt.filename ?? path.basename(p) ?? 'voice.wav')
  }
  const wav = parseWav(bytes)
  if (wav.truncated) throw new DeepSeekError(`WAV data 声明 ${wav.dataSize} B，实际只有 ${wav.dataBytes} B（文件被截断）`, { code: 'BAD_WAV' })
  if (wav.format !== 1 || wav.bits !== 16) {
    throw new DeepSeekError(`ASR 只收 16 bit PCM WAV（format=${wav.format} bits=${wav.bits}）`, { code: 'BAD_WAV' })
  }
  if (!DEEPSEEK_ASR_RATES.includes(wav.rate)) {
    throw new DeepSeekError(`ASR WAV 采样率 ${wav.rate} Hz 不在支持范围 ${DEEPSEEK_ASR_RATES.join('/')}`, { code: 'BAD_WAV' })
  }
  if (wav.channels !== 1 && wav.channels !== 2) {
    throw new DeepSeekError(`ASR WAV 声道数 ${wav.channels} 不支持（仅 mono/stereo）`, { code: 'BAD_WAV' })
  }
  const durationSec = wav.dataBytes / (wav.rate * wav.blockAlign)
  return { bytes, filename, rate: wav.rate, bits: wav.bits, channels: wav.channels, durationSec }
}

/**
 * 识别一段 WAV（multipart/form-data，字段 file）。
 *
 * @param {string|Buffer|{path?:string, pcm?:Buffer, rate?:number}} input WAV 路径 / WAV Buffer / 裸 PCM
 * @param {{apiKey?:string, baseUrl?:string, fetchImpl?:Function, log?:object, timeoutMs?:number,
 *          maxRetries?:number, backoffMs?:number, sleepImpl?:Function, filename?:string}} opt
 * @returns {Promise<{text:string, requestId:string, durationMs:number, attempts:number, ms:number}>}
 */
export async function transcribeDeepseek(input, opt = {}) {
  const apiKey = opt.apiKey === undefined ? deepseekApiKeyOf() : String(opt.apiKey).trim()
  if (!apiKey) {
    throw new DeepSeekError('缺少 deepseekApiKey（配 deepseekApiKey 或环境变量 DEEPSEEK_API_KEY）', { code: 'NO_API_KEY' })
  }
  const fetchImpl = resolveFetch(opt)
  const wav = resolveWavInput(input, opt)
  if (wav.bytes.length > DEEPSEEK_ASR_MAX_BYTES) {
    throw new DeepSeekError(
      `ASR WAV ${(wav.bytes.length / 1024 / 1024).toFixed(2)} MiB 超过 8 MiB 上限`,
      { code: 'TOO_LARGE' },
    )
  }
  if (wav.durationSec > DEEPSEEK_ASR_MAX_SECONDS) {
    throw new DeepSeekError(
      `ASR 音频 ${wav.durationSec.toFixed(1)} s 超过 ${DEEPSEEK_ASR_MAX_SECONDS} s 上限`,
      { code: 'TOO_LONG' },
    )
  }
  const url = normalizeBaseUrl(opt.baseUrl) + DEEPSEEK_ASR_PATH
  const timeoutMs = clampInt(opt.timeoutMs, 30000, 1000, 120000)
  const maxRetries = clampInt(opt.maxRetries, 2, 0, 5)
  const log = opt.log
  const t0 = Date.now()
  let lastError = null
  let retried504 = false

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // FormData 不能跨请求复用（boundary/流状态），每次重试重建。
    const form = new FormData()
    form.append('file', new Blob([wav.bytes], { type: 'audio/wav' }), wav.filename)
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      lastError = networkError(e, timeoutMs)
      if (attempt < maxRetries) {
        await waitBeforeRetry(opt, attempt, null, 'DeepSeek ASR', log)
        continue
      }
      throw lastError
    }
    const headerRequestId = requestIdOf(res)
    if (!res.ok) {
      const detail = await readErrorDetail(res)
      const canRetry504 = res.status === 504 && !retried504
      if (res.status === 504) retried504 = true
      lastError = httpError('ASR', res.status, detail, headerRequestId)
      const retry = (lastError.retryable || canRetry504) && attempt < maxRetries
      if (retry) {
        log?.warn?.(
          `DeepSeek ASR HTTP ${res.status}（request_id=${headerRequestId || '—'}，` +
            `${(wav.bytes.length / 1024).toFixed(1)} KiB / ${wav.durationSec.toFixed(1)} s），准备重试`,
        )
        await waitBeforeRetry(opt, attempt, res, 'DeepSeek ASR', log)
        continue
      }
      throw lastError
    }
    let json
    try {
      json = await res.json()
    } catch (e) {
      throw new DeepSeekError(`DeepSeek ASR 响应不是合法 JSON：${e?.message ?? e}`, {
        code: 'BAD_JSON',
        requestId: headerRequestId,
      })
    }
    const text = String(json?.text ?? '').trim()
    const requestId = String(json?.request_id ?? headerRequestId ?? '').trim()
    const durationMs = Number(json?.duration_ms) || 0
    if (!text) {
      throw new DeepSeekError(`DeepSeek ASR 返回空文本（request_id=${requestId || '—'}）`, {
        code: 'EMPTY_TEXT',
        requestId,
      })
    }
    const elapsedMs = Date.now() - t0
    log?.info?.(
      `DeepSeek ASR 完成：${(wav.bytes.length / 1024).toFixed(1)} KiB / ${wav.durationSec.toFixed(1)} s → ` +
        `"${text.slice(0, 40)}"，request_id=${requestId || '—'}，音频 ${durationMs} ms，耗时 ${elapsedMs} ms` +
        `（第 ${attempt + 1} 次）`,
    )
    return { text, requestId, durationMs, attempts: attempt + 1, ms: elapsedMs }
  }
  throw lastError ?? new DeepSeekError('DeepSeek ASR 失败（未知原因）', { code: 'ASR_FAILED' })
}
