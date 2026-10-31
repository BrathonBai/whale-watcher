// tts.js —— 本机离线 TTS：Windows SAPI（System.Speech）→ 24kHz/16bit/单声道 PCM。
//
// 为什么照小智的模式、却换掉它的引擎：
//   小智是"云端 TTS 合成 Opus 流 → 设备端解码播放"，设备端只负责播放。
//   这个分工我们照抄（合成在桥侧、设备只写 I2S），但引擎换成 Windows 自带的 SAPI：
//   不花钱、不依赖网络、断网也能响，适合先把"出声"这条链路验通。
//   要换成云 TTS（或小智那套）时，只要仍然产出 {rate,bits,channels,pcm} 就行。
//
// 输出格式写死 24000/16/1 —— 与设备端 ES8311 的配置一致，设备不做重采样。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RATE = 24000
const BITS = 16
const CHANNELS = 1

const PS_SCRIPT = `
param([string]$TextFile, [string]$OutFile, [string]$Voice, [int]$Rate, [int]$Volume)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($Voice) { $synth.SelectVoice($Voice) }
  $synth.Rate = $Rate
  $synth.Volume = $Volume
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    24000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($OutFile, $fmt)
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
`

/** 解析 WAV，取出 PCM 与格式；只认 16bit PCM。 */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV')
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

/**
 * 合成一段语音。
 * @param {string} text UTF-8 文本（中文可以）
 * @returns {Promise<{rate:number,bits:number,channels:number,pcm:Buffer,ms:number}>}
 */
export async function synthesize(text, { voice = '', rate = 0, volume = 90 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tts-'))
  const txtFile = path.join(dir, 'in.txt')
  const wavFile = path.join(dir, 'out.wav')
  const psFile = path.join(dir, 'tts.ps1')
  fs.writeFileSync(txtFile, text, 'utf8')
  fs.writeFileSync(psFile, PS_SCRIPT, 'utf8')

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile, txtFile, wavFile, voice, String(rate), String(volume)],
        { windowsHide: true },
      )
      let err = ''
      child.stderr.on('data', (d) => (err += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`SAPI 失败(${code}): ${err.slice(0, 200)}`))))
    })

    const wav = parseWav(fs.readFileSync(wavFile))
    if (wav.bits !== 16) throw new Error(`只支持 16bit，实际 ${wav.bits}`)
    if (wav.channels !== 1) throw new Error(`只支持单声道，实际 ${wav.channels}`)
    if (wav.rate !== RATE) {
      // SAPI 一般会照办；真不一样就直接报错，别让设备放成倍速/慢放
      throw new Error(`采样率 ${wav.rate} != ${RATE}`)
    }
    return { rate: wav.rate, bits: wav.bits, channels: wav.channels, pcm: wav.pcm, ms: Math.round((wav.pcm.length / 2 / RATE) * 1000) }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

/** 把 PCM 切成设备端能吃的块（4KB，对齐到样本）。 */
export function chunkPcm(pcm, chunkBytes = 4096) {
  const even = chunkBytes - (chunkBytes % 2)
  const out = []
  for (let i = 0; i < pcm.length; i += even) out.push(pcm.subarray(i, Math.min(i + even, pcm.length)))
  return out
}

export const TTS_FORMAT = { rate: RATE, bits: BITS, channels: CHANNELS }
