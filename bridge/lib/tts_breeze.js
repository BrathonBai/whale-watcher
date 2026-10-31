// tts_breeze.js —— Breeze Blue 的 TTS（指令式表演，音色比 Edge 更有"人味"）。
//
// 接口（docs.breezeblue.ai，OpenAPI 实测确认）：
//   POST https://api.breeze.blue/v1/text-to-speech/{voice_id}?output_format=wav_24000&delivery=sync
//   header: xi-api-key: <BREEZE_API_KEY>
//   body:   { text, model_id, language_code, instructions, voice_settings:{guidance_scale,speed} }
//   resp:   二进制音频（Content-Type 跟 output_format 一致）
//
// 为什么请求 wav_24000：设备的 ES8311 固定 24 kHz/16bit/单声道，
// 直接要 24 kHz 的 WAV 就省掉一次重采样；不是 16bit/mono 时再用 ffmpeg 兜底转一次。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
// Windows 下 spawn('curl.exe') 不走 shell，PATH 里找不到会立刻 reject → 静默回落 Edge。
// 用绝对路径，且允许环境变量覆盖。
const CURL = process.env.BREEZE_CURL || 'C:\\Windows\\System32\\curl.exe'

const RATE = 24000
const API_BASE = process.env.BREEZE_API_BASE || 'https://api.breeze.blue'

const CACHE_DIR = (() => {
  try {
    return path.join(process.env.LOCALAPPDATA || process.env.HOME || os.tmpdir(), 'hubdev', 'tts-cache')
  } catch {
    return path.join(os.tmpdir(), 'hub-tts-cache')
  }
})()

/** 极简 WAV 解析：只要 fmt 和 data。 */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('返回的不是 WAV')
  }
  let off = 12
  let fmt = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV 缺 fmt')
      return { ...fmt, pcm: buf.subarray(body, Math.min(body + size, buf.length)) }
    }
    off = body + size + (size % 2)
  }
  throw new Error('WAV 缺 data')
}

function run(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.includes("curl") ? CURL : cmd, args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => (err += d.toString()))
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error('超时'))
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 失败(${code}): ${err.slice(0, 200)}`))
    })
  })
}

/**
 * 发请求拿音频。
 * Node 的 fetch 不读 Windows 系统代理（实测 api.breeze.blue 直连 10 s 超时），
 * 所以：先直连试 8 s，失败就用 curl 带代理再发一次（curl 挂在系统代理后面是通的）。
 * 全异步 —— 不能挡住 ws 的心跳。
 */
async function postAudio(url, apiKey, body, opt = {}) {
  const headers = { 'xi-api-key': apiKey, 'content-type': 'application/json' }
  // 配了代理（或之前 curl 成功过）就直接走 curl —— 先试直连会白等一个超时
  const explicitProxy = opt.proxy || process.env.BREEZE_PROXY || process.env.HTTPS_PROXY || ''
  if (!explicitProxy && !preferCurl) try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(opt.directTimeoutMs) || 8000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Breeze ${res.status}: ${detail.slice(0, 200)}`)
    }
    return Buffer.from(await res.arrayBuffer())
  } catch (e) {
    lastFetchError = e?.message ?? String(e)
  }

  // --- curl 兜底（带代理）---
  const proxy = opt.proxy || process.env.BREEZE_PROXY || process.env.HTTPS_PROXY || 'http://127.0.0.1:7897'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-breeze-req-'))
  const bodyFile = path.join(dir, 'body.json')
  const outFile = path.join(dir, 'out.wav')
  try {
    fs.writeFileSync(bodyFile, JSON.stringify(body), 'utf8')
    const args = ['-sS', '--fail', '--max-time', '90', '--ssl-no-revoke', '--http1.1', '-o', outFile]
    if (proxy) args.push('-x', proxy)
    args.push('-H', `xi-api-key: ${apiKey}`, '-H', 'content-type: application/json')
    args.push('--data-binary', `@${bodyFile}`, url)
    await run('curl.exe', args)
    const buf = fs.readFileSync(outFile)
    if (!buf.length) throw new Error('curl 拿回来是空的')
    preferCurl = true          // 记住这条路能通，下次别再白等直连超时
    return buf
  } catch (e) {
    throw new Error(`直连失败(${lastFetchError}) + 代理也失败(${e?.message ?? e})`)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

let lastFetchError = ''
let preferCurl = false

/**
 * 合成一段（带缓存）。
 * @param {string} text
 * @param {{apiKey:string, voiceId:string, modelId?:string, instructions?:string,
 *          guidanceScale?:number, speed?:number, language?:string, ffmpeg?:string}} opt
 */
export async function synthesizeBreeze(text, opt = {}) {
  const apiKey = opt.apiKey || process.env.BREEZE_API_KEY || ''
  const voiceId = opt.voiceId || ''
  if (!apiKey) throw new Error('缺少 BREEZE_API_KEY')
  if (!voiceId) throw new Error('缺少 voice_id（Breeze 控制台 Voice Library 里的 voc_…）')

  const modelId = opt.modelId || 'breeze-tts-2'
  const instructions = opt.instructions || ''
  const guidance = Number.isFinite(opt.guidanceScale) ? opt.guidanceScale : 4.0
  const speed = Number.isFinite(opt.speed) ? opt.speed : 1.0
  const language = opt.language || 'zh'

  const key = crypto.createHash('sha1')
    .update(`breeze|${voiceId}|${modelId}|${instructions}|${guidance}|${speed}|${text}`)
    .digest('hex')
  const cacheFile = path.join(CACHE_DIR, `${key}.pcm`)
  try {
    const hit = fs.readFileSync(cacheFile)
    if (hit.length > 1000) {
      return { rate: RATE, bits: 16, channels: 1, pcm: hit, ms: Math.round((hit.length / 2 / RATE) * 1000), cached: true }
    }
  } catch {}

  const body = {
    text,
    model_id: modelId,
    language_code: language,
    voice_settings: { guidance_scale: guidance, speed },
  }
  if (instructions) body.instructions = instructions

  // 参数名必须是 wav / mp3 / pcm —— 写 wav_24000 会被服务端当成"找不到音色"回 404
  // （2026-10-31 实测：?output_format=wav_24000 → 404 RESOURCE_NOT_FOUND "Voice not found"；
  //   ?output_format=wav → 200，且头就是 24000Hz/mono/16bit，正好是设备要的格式）
  const url = `${API_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav`
  const raw = await postAudio(url, apiKey, body, opt)
  if (raw.length < 100) throw new Error('Breeze 返回的音频是空的')

  let pcm
  const wav = parseWav(raw)
  if (wav.bits === 16 && wav.channels === 1 && wav.rate === RATE) {
    pcm = wav.pcm
  } else {
    // 不是我们要的格式：交给 ffmpeg 转（临时文件，用完就删）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-breeze-'))
    const inFile = path.join(dir, 'in.wav')
    const outFile = path.join(dir, 'out.pcm')
    try {
      fs.writeFileSync(inFile, raw)
      await run(opt.ffmpeg || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-i', inFile,
        '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-y', outFile,
      ])
      pcm = fs.readFileSync(outFile)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
  if (!pcm || !pcm.length) throw new Error('Breeze 音频转换后为空')

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(cacheFile, pcm)
  } catch {}

  return { rate: RATE, bits: 16, channels: 1, pcm, ms: Math.round((pcm.length / 2 / RATE) * 1000), cached: false }
}

/**
 * 流式合成：`/stream?output_format=pcm` 边生成边吐 **纯 PCM**（24k/16bit/mono，无头）。
 * 这是首包最快的一条路：不用等整句渲染完，收到多少就能往设备推多少。
 * 用 curl 是因为它支持 --no-buffer + 系统代理，Node 的 fetch 直连这里会超时。
 * @param {(chunk: Buffer) => void} onChunk 每收到一块就回调（调用方负责推给设备）
 */
export function streamBreeze(text, opt = {}, onChunk = () => {}) {
  const apiKey = opt.apiKey || process.env.BREEZE_API_KEY || ''
  const voiceId = opt.voiceId || ''
  if (!apiKey) return Promise.reject(new Error('缺少 BREEZE_API_KEY'))
  if (!voiceId) return Promise.reject(new Error('缺少 voice_id'))

  const modelId = opt.modelId || 'breeze-tts-2'
  const body = {
    text,
    model_id: modelId,
    language_code: opt.language || 'zh',
    voice_settings: {
      guidance_scale: Number.isFinite(opt.guidanceScale) ? opt.guidanceScale : 4.0,
      speed: Number.isFinite(opt.speed) ? opt.speed : 1.0,
    },
  }
  if (opt.instructions) body.instructions = opt.instructions

  const url = `${API_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm`
  const proxy = opt.proxy || process.env.BREEZE_PROXY || process.env.HTTPS_PROXY || ''
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-breeze-stream-'))
  const bodyFile = path.join(dir, 'body.json')
  fs.writeFileSync(bodyFile, JSON.stringify(body), 'utf8')

  const args = ['-sS', '--fail', '--no-buffer', '--max-time', '120', '--ssl-no-revoke', '--http1.1']
  if (proxy) args.push('-x', proxy)
  args.push('-H', `xi-api-key: ${apiKey}`, '-H', 'content-type: application/json')
  args.push('--data-binary', `@${bodyFile}`, url)

  return new Promise((resolve, reject) => {
    const child = spawn(CURL, args, { windowsHide: true })
    let bytes = 0
    let err = ''
    child.stdout.on('data', (d) => {
      if (!d.length) return
      bytes += d.length
      try { onChunk(d) } catch {}
    })
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
      if (code === 0 && bytes > 0) resolve(bytes)
      else reject(new Error(`stream 失败(${code}): ${err.slice(0, 200)}`))
    })
  })
}

/** 列可用音色（拿 voice_id 用；也可以只看控制台）。 */
export async function listBreezeVoices(apiKey) {
  const key = apiKey || process.env.BREEZE_API_KEY || ''
  if (!key) throw new Error('缺少 BREEZE_API_KEY')
  const res = await fetch(`${API_BASE}/v1/voices?page_size=100`, { headers: { 'xi-api-key': key } })
  if (!res.ok) throw new Error(`Breeze voices ${res.status}`)
  return res.json()
}
