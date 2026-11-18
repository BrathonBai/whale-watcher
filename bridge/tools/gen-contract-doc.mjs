// gen-contract-doc.mjs —— 从 lib/contract.js 生成 docs/协议-v2-契约.md。
//
// 跑：node tools/gen-contract-doc.mjs
//
// 为什么要生成：上一轮的教训是"文档手写、代码另写，两边各说各话"。
// 现在契约只有一处（lib/contract.js），文档是它的投影；
// test/contract.test.mjs 会比对文档里的 json 块与 contract.js 是否逐字一致。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUDIO,
  DEVICE,
  DOWNLINK,
  MOODS,
  MOOD_CLIP,
  PROTOCOL_VERSION,
  ROUTES,
  TOOLS,
  TOOL_NEEDS,
  UPLINK,
  UNSUPPORTED,
} from '../lib/contract.js'
import { ADAPTIVE } from '../lib/audio_profile.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 文档目录：仓库里是 bridge/tools → ../../docs；装进插件目录后没有 docs/，
// 这时**明确跳过**，绝不往 ~/.dsh/plugins/ 里乱建目录。
// 也可以通过 HUB_DOCS_DIR 指到任意位置（CI 用）。
const CANDIDATES = [
  process.env.HUB_DOCS_DIR,
  path.join(HERE, '..', '..', 'docs'),
  path.join(HERE, '..', 'docs'),
].filter(Boolean)
const OUT_DIR = CANDIDATES.find((p) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
})
if (!OUT_DIR) {
  console.log('跳过：没找到 docs/ 目录（插件单独分发时正常）。' + '要生成请设 HUB_DOCS_DIR 指向仓库的 docs/。')
  process.exit(0)
}
const OUT = path.join(OUT_DIR, '协议-v2-契约.md')

const code = (s) => '`' + s + '`'
const rows = (arr, fn) => arr.map(fn).join('\n')

/** 每条声明的固件出处（改契约时同步改这里，审稿人能顺着查）。 */
const EVIDENCE = {
  hello: 'app_ui.cc:126（ver 是字符串 "0.2"，cam=1, w/h=240）；2026-11-03 起可选 codecs[] / opusRate',
  pong: 'app_ui.cc:255（收到 ping 回 pong）；2026-11-03 起可选带 bufMs/underruns/reconnects/rssi/codec',
  image: 'app_ui.cc:294-309（文本头 + 16KB 二进制分块）',
  voice: 'app_ui.cc:141 + proto.cc:401（BuildVoice 头 + 分块）',
  welcome: 'app_ui.cc:253（收到后只打一行日志，内容忽略）',
  ping: 'app_ui.cc:255',
  say: 'app_ui.cc:258-262（上屏 + mood，等音频播完才熄灯）',
  face: 'app_ui.cc:263（只改 mood）',
  audio: 'app_ui.cc:265-276（建环形缓冲 + 垫 120ms 头 / 180ms 尾）；2026-11-03 起新增 codec 字段',
  audio_end: 'app_ui.cc:270-276（对账丢帧 + 垫 180ms 尾）',
  shot: 'app_ui.cc:254（Parse 之前用裸 strstr 匹配 "shot"）',
}

const md = `# 协议 v2 契约（设备 ⇄ 桥）

> **本文件由 \`tools/gen-contract-doc.mjs\` 生成，请勿手改。**
> 唯一事实源是 \`bridge/lib/contract.js\`；改了契约就重新生成，并跑
> \`node test/contract.test.mjs\`（它会比对本文件与代码是否一致）。
>
> 上位背景：v0.2 的桥是照 v1 固件（fw 0.8）写的，v2 上来后只"让它连上"，
> 没有反向核对契约，于是 press/record/mic/level/sound/diag 这些消息在 v2 里
> 根本没有对端，工具却照样注册给模型 → "工具都在、用起来空转"。
> 这一版的原则：**设备没有的，桥就不假装有**。

- 协议版本（桥侧）：${PROTOCOL_VERSION}
- 设备自报：fw=${code(DEVICE.fw)} · ver=${code(DEVICE.ver)} · 屏 ${DEVICE.panel.w}×${DEVICE.panel.h}
- 摄像头：${DEVICE.camera.w}×${DEVICE.camera.h} JPEG，≤ ${(DEVICE.camera.maxBytes / 1024 / 1024).toFixed(0)} MB，周期 ${DEVICE.camera.periodMs} ms
- 音频：${DEVICE.audio.rate} Hz / ${DEVICE.audio.bits} bit / ${DEVICE.audio.ch} ch，单段 ≤ ${DEVICE.audio.maxVoiceSeconds} s
- 音频编码：${AUDIO.codecs.map(code).join(' / ')}（缺省 ${code(AUDIO.defaultCodec)}）；opus = 每包 ${AUDIO.opus.frameMs} ms、编码 ${AUDIO.opus.encodeRate / 1000} kHz mono、audio 头 rate 填 ${AUDIO.headRate}（设备解码输出率）、裸包 ≤ ${AUDIO.opus.maxPacketBytes} B
- 桌宠素材：三段（${Object.entries(DEVICE.clips).filter(([, v]) => Array.isArray(v)).map(([k]) => k).join(' / ')}），${DEVICE.clips.fps} fps

## 一、设备 → 桥（只有 ${UPLINK.length} 种）

| t | 字段 | 固件出处 |
|---|---|---|
${rows(UPLINK, (t) => `| ${code(t)} | ${t === 'hello' ? 'fw, board, ver(字符串), cam, w, h；可选 codecs[] / opusRate' : t === 'pong' ? '可选 bufMs / underruns / reconnects / rssi / codec（老固件没有）' : t === 'image' ? 'bytes, w, h, seq + 二进制分块' : t === 'voice' ? 'bytes, rate, seq + 二进制分块' : '—'} | ${EVIDENCE[t]} |`)}

其它任何 \`t\` 一律回 \`UNSUPPORTED_UPLINK\`（**不是**"向前兼容地解析成功"）。

## 二、桥 → 设备（只有 ${DOWNLINK.length} 种）

| t | 字段 | 固件出处 |
|---|---|---|
${rows(DOWNLINK, (t) => `| ${code(t)} | ${t === 'say' ? 'text, mood' : t === 'face' ? 'mood' : t === 'audio' ? 'rate, bits, ch, bytes, seq, codec（缺省 pcm）' : t === 'audio_end' ? 'seq' : t === 'ping' ? 'ver' : t === 'welcome' ? 'ver' : '—'} | ${EVIDENCE[t]} |`)}

\`device.send()\` 会拦：不在上表里的 \`t\` 直接拒绝并计入 \`counters.rejected\`。

## 三、v2 不具备的能力（写清原因，工具因此不注册）

| 消息 | 为什么没有 |
|---|---|
${rows(Object.entries(UNSUPPORTED), ([k, v]) => `| ${code(k)} | ${v} |`)}

## 四、音频编码协商与自适应（2026-11-03）

设备能力：hello 可选带 ${code('codecs')}（如 ${code('["pcm","opus"]')}）与 ${code('opusRate')}；
老固件没有这两个字段时，桥按"只有 PCM"处理——**缺字段不是错误**。

| 项 | 约定 |
|---|---|
| audio 头 ${code('codec')} | ${AUDIO.codecs.map(code).join(' / ')}；缺省 ${code(AUDIO.defaultCodec)} |
| ADPCM（2026-11-13，BLE 链路） | 上行 hello.uplink=${code('adpcm')}、voice 头 ${code('codec:"adpcm"')}；块 = ${AUDIO.adpcm.blockAlign} B（${AUDIO.adpcm.headerBytes} B 头 + nibbles）= ${AUDIO.adpcm.samplesPerBlock} 采样 = 85 ms，${AUDIO.adpcm.bytesPerSecond} B/s；voice/audio 头可带 ${code('samples')}（解码后采样数） |
| ADPCM 参考实现 | ${code('lib/adpcm.js')} 与 ffmpeg ${code('adpcm_ima_wav')} 同构：解码结果逐采样 0 差异（${code('test/adpcm.test.mjs')} + ${code('test/fixtures/adpcm-vectors.json')}）；固件 ${code('adpcm.cc')} 必须与共享向量逐字节一致 |
| opus 每帧 | 一个 WS 二进制帧 = 一个裸 Opus 包（${AUDIO.opus.frameMs} ms、${AUDIO.opus.encodeRate / 1000} kHz mono、无长度前缀、≤ ${AUDIO.opus.maxPacketBytes} B） |
| opus audio 头 | ${code(`rate=${AUDIO.headRate}`)}（设备解码输出率）、${code('bits=16')}、${code('ch=1')}、${code('bytes=0')}、${code('seq')} 递增 |
| opus 编码 | ffmpeg libopus（${code(AUDIO.opus.application)}），输入 PCM 24k mono → 编码率 16 kHz |
| audio_end | 语义不变 |
| pong 诊断 | 可选 ${AUDIO.pongDiag.map(code).join(' / ')}${AUDIO.pongStrings.filter((k) => !AUDIO.pongDiag.includes(k)).map((k) => code(k)).join(' ')}（缺字段不能报错） |

自适应档位（只在 opus 生效；**每段回复只选一次**，句子中间不切换）：

| 档位 | 判据（最近 ${ADAPTIVE.WINDOW} 条 pong） | 码率 |
|---|---|---|
| 健康 | 平均 bufMs ≥ ${ADAPTIVE.HEALTHY_MIN_BUF_MS} ms 且新增欠载 ≤ ${ADAPTIVE.HEALTHY_MAX_UNDERRUNS} | ${AUDIO.adaptive.healthyBps} bps |
| 中等 | 平均 bufMs ≥ ${ADAPTIVE.MEDIUM_MIN_BUF_MS} ms 且新增欠载 ≤ ${ADAPTIVE.MEDIUM_MAX_UNDERRUNS} | ${AUDIO.adaptive.mediumBps} bps |
| 差 | 其它（缓冲偏低 / 欠载多 / 没 pong） | ${AUDIO.adaptive.poorBps} bps |

回退策略（显式，不静默换编码）：

- 连续 ${ADAPTIVE.POOR_STREAK_TO_FALLBACK} 段判"差" → 回退 PCM ${ADAPTIVE.PCM_RATE} Hz；健康度恢复后自动回 opus；
- 连接后 ${ADAPTIVE.NO_PONG_MS / 1000} s 没有 pong → 回退 PCM；
- 编码不可用/失败（ffmpeg 缺失、连续失败 ${ADAPTIVE.ENCODE_FAILS_TO_BLOCK} 次）→ 本段回退 PCM，
  原因写入 ${code('/api/state.audio.lastEncodeError')}（${code('/api/diag')} 可解释）。

## 五、工具与依赖

| 工具 | 依赖下行 | 说明 |
|---|---|---|
${rows(TOOLS, (t) => `| ${code(t)} | ${TOOL_NEEDS[t] ? code(TOOL_NEEDS[t]) : '—'} | ${t === 'device_shot' ? '发 shot 等设备回 image，落盘后返回路径' : t === 'device_capabilities' ? '如实告诉模型能做什么、不能做什么' : ''} |`)}

## 六、HTTP 路由

- 只读：${ROUTES.read.map(code).join(' ')}
- 动作（本机免令牌 / 配了 panelToken 要 Bearer）：${ROUTES.act.map(code).join(' ')}
- 历史接口（返回 501 + 原因，不是 404）：
${rows(Object.entries(ROUTES.gone), ([k, v]) => `  - ${code(k)}：${v}`)}

## 七、表情 → 桌宠素材

| mood | clip |
|---|---|
${rows(MOODS, (m) => `| ${code(m)} | ${code(MOOD_CLIP[m])} |`)}

映射与固件 \`render.cc:269-282\` 的 \`PetClipFor\` 一一对应；改这里必须同时改那边。

## 八、机器可读摘要

\`\`\`json
${JSON.stringify(
  {
    protocolVersion: PROTOCOL_VERSION,
    audio: {
      codecs: [...AUDIO.codecs],
      uplinkCodecs: [...AUDIO.uplinkCodecs],
      defaultCodec: AUDIO.defaultCodec,
      headRate: AUDIO.headRate,
      opus: { ...AUDIO.opus },
      adpcm: { ...AUDIO.adpcm },
      adaptive: { ...AUDIO.adaptive },
      pongDiag: [...AUDIO.pongDiag],
      pongStrings: [...AUDIO.pongStrings],
    },
    uplink: [...UPLINK],
    downlink: [...DOWNLINK],
    tools: [...TOOLS],
    unsupported: { ...UNSUPPORTED },
    routes: { read: [...ROUTES.read], act: [...ROUTES.act] },
  },
  null,
  2,
)}
\`\`\`
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, md, 'utf8')
console.log(`已生成 ${OUT}（上行 ${UPLINK.length} / 下行 ${DOWNLINK.length} / 工具 ${TOOLS.length}）`)
