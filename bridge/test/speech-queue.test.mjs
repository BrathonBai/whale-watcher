// speech 队列回归：一次 speak() 里的**每一句**都必须真的下发。
//
// 为什么有这个测试（2026-11-02 审计 BR-01）：
//   speech.js 里 speakOne() 曾经 `const myToken = ++token`，而 drain() 在进入时捕获
//   myToken 并在循环顶部比较 `myToken !== token` → 第一句播完 token 已变，drain 误判
//   "被打断"，清空 queue 退出。表现：多句回复只念第一句（生产日志 7/7 条 "TTS … / 1 句"）。
//
// 跑：node test/speech-queue.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSpeaker, splitForTts, cacheKeyOf } from '../lib/speech.js'
import * as voiceCache from '../lib/voicecache.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'speech-queue-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 测试用配置（闭包返回，改键即生效）。 */
function makeCfg(voiceId, extra = {}) {
  return {
    get: () => ({
      tts: true,
      ttsEngine: 'breeze',
      breezeVoiceId: voiceId,
      breezeStream: false,
      ttsPreBufferMs: 0,
      wsFrameBytes: 4096,
      ...extra,
    }),
  }
}

/** 预生成两个本地台词包（避免真的调 TTS 网络）。键必须与 speech.js 生产路径同一套字段。 */
function seedCache(cfg, text) {
  const dir = tmp()
  process.env.DSH_VOICEPACK_DIR = dir
  const parts = splitForTts(text)
  for (const p of parts) {
    const key = cacheKeyOf(p, cfg.get(), { codec: 'pcm' })
    const w = voiceCache.beginWrite(key, { codec: 'pcm', rate: 24000, bits: 16, ch: 1 })
    w.push(Buffer.alloc(4800, 0)) // 0.1 s 静音，够走完 playLocal 的整段
    assert.equal(w.commit(), true, 'seed cache commit')
  }
  return { dir, parts }
}

function makeFakeDevice() {
  const calls = { head: [], end: [], bytes: 0 }
  return {
    calls,
    get online() {
      return true
    },
    audioHead(info) {
      calls.head.push(info)
      return true
    },
    sendBinary(buf) {
      calls.bytes += buf.length
      return true
    },
    audioEnd(seq) {
      calls.end.push(seq)
      return true
    },
  }
}

async function waitIdle(speaker, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!speaker.busy && speaker.pending === 0) return
    await sleep(10)
  }
  throw new Error('speaker 没有在超时内跑完（可能卡在 drain）')
}

test('多句文本会逐句下发（回归：曾经只念第一句）', async () => {
  const text = '第一句。第二句！'
  const voiceId = 'v-test'
  const cfg = makeCfg(voiceId)
  const { parts } = seedCache(cfg, text)
  assert.equal(parts.length, 2, '这条用例前提：文本被切成两句')

  const device = makeFakeDevice()
  const log = { info: () => {}, warn: () => {} }
  const speaker = createSpeaker({ cfg, log, device })

  speaker.speak(text)
  await waitIdle(speaker)

  assert.equal(device.calls.head.length, 2, `应下发 2 个 audio 头，实际 ${device.calls.head.length}`)
  assert.equal(device.calls.end.length, 2, `应下发 2 个 audio_end，实际 ${device.calls.end.length}`)
  assert.ok(device.calls.bytes > 0, '应真的写了 PCM 字节')
  fs.rmSync(process.env.DSH_VOICEPACK_DIR, { recursive: true, force: true })
  delete process.env.DSH_VOICEPACK_DIR
})

test('stop() 之后队列清空、后续句不再下发', async () => {
  const text = '第一句。第二句。第三句。'
  const voiceId = 'v-test'
  const cfg = makeCfg(voiceId)
  seedCache(cfg, text)
  const device = makeFakeDevice()
  const speaker = createSpeaker({ cfg, log: { info: () => {}, warn: () => {} }, device })
  speaker.speak(text)
  speaker.stop() // 立刻打断：drain 应放弃剩余句
  await waitIdle(speaker).catch(() => {})
  assert.ok(device.calls.end.length <= 1, `打断后不应继续念，实际 audio_end=${device.calls.end.length}`)
  fs.rmSync(process.env.DSH_VOICEPACK_DIR, { recursive: true, force: true })
  delete process.env.DSH_VOICEPACK_DIR
})
