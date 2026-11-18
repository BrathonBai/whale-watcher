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
  // 2026-11-13（BLE 直连手机）：wsToken 非空时 /device 必须带 ?token=xxx（手机 guest 注入时
  // 由 App 生成随机 token；PC 保持空 = 行为不变）。手机 loopback 上任何 App 都能连 127.0.0.1，
  // 没有 token 就等于把设备控制面开放给全机，所以手机端必须开。
  wsToken: '',
  heartbeatMs: 25000,
  discoverPort: 7789,
  // UDP 局域网发现（PC 桥给设备换网后自动找地址用）。手机端无意义 → guest 注入时关掉。
  discover: true,

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
  // auto（默认）：deepseekApiKey / 环境变量 DEEPSEEK_API_KEY 非空 → deepseek，否则回退 edge。
  // 显式值：deepseek | edge | sapi | breeze（老引擎保留，显式值永远优先，不静默换引擎）。
  ttsEngine: 'auto',
  // DeepSeek 取值 stella（默认女声）/ tide（男声）；edge/sapi 的音色名照旧可用。
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
  // 流式下发时单帧字节数（必须是偶数；固件 kMaxBinaryPayload = 16384）。
  // 之前 speech.js 读了这个键但 DEFAULTS 没声明 → audit.mjs 静态哨兵一直红（BR-29）。
  wsFrameBytes: 4096,

  // ---- DeepSeek 官方语音 API（2026-11-13；TTS 与 ASR 共用一把 key）----
  // secret：默认读环境变量 DEEPSEEK_API_KEY；空串 = 未配置（auto 模式回退老引擎）。
  // 注意：这里只是"配置层默认"+ 环境变量兜底，不把 key 写进 config.json 也行。
  deepseekApiKey: '',
  // 默认 https://api.deepseek.com；也支持环境变量 DEEPSEEK_BASE_URL（代理/自测）。
  deepseekBaseUrl: 'https://api.deepseek.com',
  // 单次 HTTP 超时（ms）：TTS 整段合成与 ASR 上传识别共用。
  deepseekTimeoutMs: 30000,
  // 429（并发/限流）/ 503（服务忙）的退避重试：首次之外再试几次、退避基数（指数退避）。
  // ASR 504（识别超时）按官方建议只额外重试一次，不受这个值无限放大。
  deepseekMaxRetries: 2,
  deepseekRetryBackoffMs: 800,

  // ---- 音频编码（2026-11-03 Opus 协商；2026-11-13 加 ADPCM）----
  // auto 的优先级：设备支持 opus 且 ffmpeg 可用 → opus；设备支持 adpcm 且 ffmpeg 不可用
  //   → adpcm（手机桥没有 ffmpeg，12 KB/s，BLE 带宽够）；都不支持 → PCM 24k（老固件零回归）。
  // 显式值：pcm / opus / adpcm；设备不支持所选编码时**显式回退** PCM 并告警，不静默。
  audioCodec: 'auto',    // auto | opus | pcm | adpcm
  // 基准码率（bps）：自适应关闭 / 健康度未知时用它；自适应开启后按档位 24k/16k/8k 切。
  opusBitrate: 16000,
  // 自适应：按最近 pong 的 bufMs/underruns 选档位；连续差或长期没 pong → 显式回退 PCM。
  audioAdaptive: true,
  // 每帧时长（ms）。契约固定 20 ms（裸 Opus 包）；改这里必须同时改固件解码侧。
  opusFrameMs: 20,

  // ---- 听觉（ASR）----
  // auto（默认）：有 deepseekApiKey 先用 DeepSeek 官方 ASR，失败/未配置再走老链路
  //   （DSH 自带 speechToText → 命令）；显式 deepseek/dsh/command/server 只走对应那条。
  asr: 'auto',           // auto | deepseek | dsh | command | server | off
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

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const sameVal = (a, b) => {
  if (Object.is(a, b)) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 每个配置项最终值来自哪一层，以及"file 被 patch 盖住"的项。
 *
 * 2026-11-02 审计：`config.json` 的 maxReplyChars=60 被插件 patch 的 240 静默盖住，
 * 表现为"改了没用、重启回退"。这里把来源显式化，供启动日志、/api/config、/api/diag 使用。
 *
 * @returns {{sources: Record<string,{from:'default'|'file'|'patch', value:any}>,
 *            shadowed: Array<{key:string, file:any, patch:any, effective:any}>}}
 */
export function layerInfo(pluginConfig) {
  const file = readOverrides()
  const patch = pluginConfig ?? {}
  const keys = new Set([...Object.keys(DEFAULTS), ...Object.keys(file), ...Object.keys(patch)])
  const sources = {}
  const shadowed = []
  for (const k of [...keys].sort()) {
    const from = own(patch, k) ? 'patch' : own(file, k) ? 'file' : 'default'
    const value = from === 'patch' ? patch[k] : from === 'file' ? file[k] : DEFAULTS[k]
    sources[k] = { from, value }
    if (own(file, k) && own(patch, k) && !sameVal(file[k], patch[k])) {
      shadowed.push({ key: k, file: file[k], patch: patch[k], effective: patch[k] })
    }
  }
  return { sources, shadowed }
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
    /** 配置来源分层（default / file / patch）与被 patch 盖住的项。 */
    layerInfo: () => layerInfo(base),
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

// ============================ DeepSeek 语音 API 的解析器（纯函数） ============================
//
// 2026-11-13：把「配置层」与「实际用哪条路」分开：
//   · 配置层 deepseekApiKey 为空时，环境变量 DEEPSEEK_API_KEY 兜底（secret 不落 config.json 也能用）；
//   · ttsEngine/asr 默认 auto：有 key → DeepSeek；没 key → 老引擎/老链路（零回归）；
//   · 显式 deepseek / edge / sapi / breeze / dsh / command / server 永远优先，不做静默换引擎。
// 放 config.js 是为了让 speech/asr/http 三处用同一套判断，不会各说各话。

/** DeepSeek API key：配置层 > 环境变量 DEEPSEEK_API_KEY；空串 = 未配置。 */
export function deepseekApiKeyOf(configured) {
  const own = String(configured ?? '').trim()
  return own || String(process.env.DEEPSEEK_API_KEY ?? '').trim()
}

/** DeepSeek base URL：配置层 > 环境变量 DEEPSEEK_BASE_URL > 官方默认（去掉尾部斜杠）。 */
export function deepseekBaseUrlOf(configured) {
  const own = String(configured ?? '').trim()
  const env = String(process.env.DEEPSEEK_BASE_URL ?? '').trim()
  return (own || env || DEFAULTS.deepseekBaseUrl).replace(/\/+$/, '')
}

/**
 * 实际生效的 TTS 引擎。
 *   auto（默认）→ 有 key 用 deepseek，否则 edge（老默认，行为与以前一致）；
 *   显式值原样返回（老配置写死 edge/sapi/breeze 时永远优先，不被 key 抢走）。
 */
export function ttsEngineOf(c = {}) {
  const want = String(c?.ttsEngine ?? '').trim().toLowerCase() || 'auto'
  if (want === 'auto') return deepseekApiKeyOf(c?.deepseekApiKey) ? 'deepseek' : 'edge'
  return want
}

/**
 * 实际生效的 ASR 模式。
 *   auto（默认）→ 有 key 先走 deepseek（调用侧仍保留旧链路兜底），没 key 就是原来的 auto；
 *   显式值原样返回。
 */
export function asrModeOf(c = {}) {
  const want = String(c?.asr ?? '').trim().toLowerCase() || 'auto'
  if (want === 'auto') return deepseekApiKeyOf(c?.deepseekApiKey) ? 'deepseek' : 'auto'
  return want
}

