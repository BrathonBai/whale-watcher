// 配置：默认值 + 一份 JSON 文件（改完即生效，不用重启 DSH）。
//
// 抄 aurabot 的两条做法：
//   1. 默认值写死在代码里，用户只存"覆盖项"——升级不会把旧配置冲掉；
//   2. 保存 = 写盘 + 就地替换内存里的对象（调用方读 cfg.x，永远读最新的）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULTS = {
  // ---- 传输 ----
  host: '0.0.0.0',
  port: 7788,
  path: '/device',
  heartbeatMs: 25000,
  discoverPort: 7789,

  // ---- 大脑 ----
  // session：设备对话进一个真正的 DSH 会话（看得见、能插话、共用工具与记忆）——默认
  // llm    ：老路子，插件自己拼 messages 调 ctx.llm（不占会话，但也没有工具）
  brain: 'session',
  preset: '',            // 空 = DSH 默认 preset
  workspaceDir: '',      // 空 = <plugins-data>/embodied-bridge/workspace
  workspaceTitle: '具身Agent · Watcher',
  sessionId: '',         // 自动写入；删掉即新开一个设备会话
  provider: '',
  model: '',
  reasoningEffort: '',
  systemPrompt:
    '你是一部戴在用户身上的小型具身设备的大脑。回复要短——一到两句，最多 120 字，' +
    '适合在 412×412 的圆屏上显示并被念出来。不要用 Markdown、列表或代码块。',
  historyTurns: 8,
  maxReplyChars: 240,
  filler: true,          // 思考超过 1.2s 先出个"嗯…"垫一下（像人在接话）

  // ---- 语音（TTS）----
  tts: true,
  ttsEngine: 'edge',     // edge | sapi | breeze
  ttsVoice: '',
  ttsRate: '+0%',
  ttsPython: '',
  ttsFfmpeg: 'ffmpeg',
  ttsVoiceSapi: '',
  breezeApiKey: '',
  breezeVoiceId: '',
  breezeModel: 'breeze-tts-2',
  breezeInstructions: '',
  breezeGuidance: 4.0,
  breezeSpeed: 1.0,
  breezeProxy: '',
  breezeStream: true,
  // 流式预缓冲：攒够这么多毫秒的 PCM 才开始往设备推（0 = 来了就推，会卡）。
  // 实测 Breeze 首包 ~1.1 s 才到、前段块间隔最大 393 ms，边到边播必断粮；1000 够覆盖开局。
  ttsPreBufferMs: 1000,

  // ---- 听觉（ASR）----
  // auto：先试 DSH 自带的 speechToText（桌面版内置 sherpa-onnx，零配置），再试命令
  asr: 'auto',           // auto | dsh | command | server | off
  asrCommand: '',
  asrServerCommand: '',

  // ---- 交互 ----
  // v2 没有 record/mic 下行：录音只能按设备上的按键，自动送录（VAD）也不存在；
  // 也没有 press 上行，所以"按键打断/双击重播"这类配置一并删掉（留着就是死配置）。

  // ---- 面板 ----
  panel: true,
  panelToken: '',        // 空 = 只允许本机访问 /api/*
  eventRing: 200,

  // ---- 落盘保留（ESP32 侧不存长视频，桥侧也没必要留一堆图） ----
  // 拍照改成"按需"之后数量不可预测；模型真正需要的只有最新一张，所以只留最近 N 个。
  imageKeep: 20,
  voiceKeep: 50,

  // ---- 诊断 ----
  // 日志文件（空 = %LOCALAPPDATA%\hubdev\bridge.log，v0.1 就在写这个路径）
  logFile: '',
}

const SUSPECT = new Set(['__proto__', 'constructor', 'prototype'])

/** 深合并：对象递归，数组/标量直接覆盖（数组不合并，避免"删不掉元素"）。 */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (SUSPECT.has(k)) continue
    const b = base?.[k]
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)
      ? merge(b, v)
      : v
  }
  return out
}

export function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dir = path.join(home, 'plugins-data', 'embodied-bridge')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export const configPath = () => path.join(dataDir(), 'config.json')

export function readOverrides() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

/** 载入配置：默认值 ← config.json ← 插件 config（cordis.patch.yml）。 */
export function loadConfig(pluginConfig) {
  return merge(merge(DEFAULTS, readOverrides()), pluginConfig ?? {})
}

/** 把一层的覆盖写进 config.json（只写覆盖项，不写默认值）。 */
export function saveOverrides(patch) {
  const next = merge(readOverrides(), patch)
  const file = configPath()
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return next
}

/**
 * 可热更新的配置句柄：`cfg.x` 永远读当前值；
 * `reload()` 把 config.json 重新叠上去（面板保存后调它，下一次用到就是新值）。
 */
export function createConfig(pluginConfig) {
  const base = pluginConfig ?? {}
  let current = loadConfig(base)
  return {
    get: () => current,
    value: () => current,
    /** 重新读盘（保留 cordis.patch.yml 那一层）。 */
    reload() {
      current = loadConfig(base)
      return current
    },
    /** 保存覆盖项并立即生效；返回新的完整配置。 */
    save(patch) {
      saveOverrides(patch)
      current = loadConfig(base)
      return current
    },
    /** 只改内存（用于 sessionId 这种程序自己写回的量）。 */
    setLocal(patch) {
      current = merge(current, patch)
      return current
    },
  }
}
