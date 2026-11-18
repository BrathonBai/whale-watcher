// tts_edge.js —— 用 Edge 的在线朗读接口合成，音色比 Windows SAPI 好听一个档次。
//
// 为什么是这条路：SAPI（System.Speech）是 2006 年的拼接式引擎，中文只有 Huihui 那几个，
// 念出来是"机器朗读"；Edge 用的是微软的神经 TTS（zh-CN-XiaoxiaoNeural 这类），
// 同一个句子听起来是"有人在说话"。
//
// 管线：edge-tts（Python）→ mp3 → ffmpeg → 24k/16bit/单声道 raw PCM → 设备。
// 代价：一条链要起两个进程，约 3.5 s/句；所以外层做了**按句流水线 + 磁盘缓存**：
//   - 短句缓存命中直接返回（"在呢。"这类几乎零延迟）
//   - 第一句合成完就开口，后面的句子并行合成
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RATE = 24000
const BITS = 16
const CHANNELS = 1

const CACHE_DIR = (() => {
  try {
    const base = process.env.LOCALAPPDATA || process.env.HOME || os.tmpdir()
    return path.join(base, 'hubdev', 'tts-cache')
  } catch {
    return path.join(os.tmpdir(), 'hub-tts-cache')
  }
})()

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
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
 * 合成一段文本（带缓存）。
 * @param {string} text
 * @param {{voice?:string, python?:string, ffmpeg?:string, rate?:string, pitch?:string}} opt
 */
export async function synthesizeEdge(text, opt = {}) {
  const voice = opt.voice || 'zh-CN-XiaoxiaoNeural'
  const python = opt.python || 'python'
  const ffmpeg = opt.ffmpeg || 'ffmpeg'
  const rateArg = opt.rate || '+0%'      // 语速：'+10%' 更快
  const pitchArg = opt.pitch || '+0Hz'

  const key = crypto.createHash('sha1').update(`${voice}|${rateArg}|${pitchArg}|${text}`).digest('hex')
  const cacheFile = path.join(CACHE_DIR, `${key}.pcm`)
  try {
    const hit = fs.readFileSync(cacheFile)
    if (hit.length > 44) {
      return { rate: RATE, bits: BITS, channels: CHANNELS, pcm: hit, ms: Math.round((hit.length / 2 / RATE) * 1000), cached: true }
    }
  } catch {}

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-edge-'))
  const mp3 = path.join(dir, 'a.mp3')
  const pcmFile = path.join(dir, 'a.pcm')
  try {
    await run(python, [
      '-m', 'edge_tts',
      '--voice', voice,
      '--rate', rateArg,
      '--pitch', pitchArg,
      '--text', text,
      '--write-media', mp3,
    ])
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', mp3,
      '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-y', pcmFile,
    ])
    const pcm = fs.readFileSync(pcmFile)
    if (!pcm.length) throw new Error('转出来的 PCM 是空的')
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(cacheFile, pcm)
    } catch {}
    return { rate: RATE, bits: BITS, channels: CHANNELS, pcm, ms: Math.round((pcm.length / 2 / RATE) * 1000), cached: false }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

export const EDGE_DEFAULTS = {
  voice: 'zh-CN-XiaoxiaoNeural',
  // 备选（想换音色直接改配置）：
  //   zh-CN-XiaoyiNeural     少女、活泼
  //   zh-CN-XiaomengNeural   软糯
  //   zh-CN-YunxiNeural      年轻男声
  //   zh-CN-YunyangNeural    新闻男声
  //   zh-CN-liaoning-XiaobeiNeural  东北话
}
