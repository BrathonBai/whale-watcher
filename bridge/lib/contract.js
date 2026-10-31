// contract.js —— 鲸鲸 v2 设备与桥之间的**唯一契约**。
//
// 为什么有这个文件：v0.2 的桥是按 v1 固件（fw 0.8）写的，v2 上线时只"让它连上"，
// 没有拿 v2 的代码反向核对过契约。结果 press/record/mic/state/level/sound/diag
// 这些消息在 v2 上根本没有对端，工具却照样注册给模型 → "工具都在、用起来空转"。
//
// 现在的规则：
//   1. 这个文件是唯一事实源；protocol / device / tools / http 全部从它派生；
//   2. 每条声明都要能在固件里指出出处（见 evidence 字段）；
//   3. 与它不符的实现由 test/contract.test.mjs 判红；docs/协议-v2-契约.md 由
//      tools/gen-contract-doc.mjs 从它生成，禁止手写。
//
// 出处（逐条核对过）：
//   上行只有 4 种：
//     hello  app_ui.cc:126   {"t":"hello","fw":"hub_v2",...,"ver":"0.2","cam":1,...}
//     pong   app_ui.cc:255   收到 ping 回 {"t":"pong"}
//     image  app_ui.cc:294-309  先文本头再 16KB 二进制分块
//     voice  app_ui.cc:141   BuildVoice 头 + 16KB 分块（proto.cc:401）
//   下行只有 7 种（app_ui.cc 的 SetTextHandler）：
//     welcome(:253 忽略) ping(:255) say(:258) face(:263)
//     audio(:265) audio_end(:270) shot(:254，出现在 Parse 之前的裸 strstr)
//   设备解析得出但**应用层不处理**的：record / mic / result（proto.cc:447-493 只赋值，
//   app_ui.cc:279 的 else 只打一行日志）→ 一律按"不支持"处理，不注册对应工具。

export const PROTOCOL_VERSION = 2

/** 设备自报的身份（hello 原文）。ver 是**字符串**，不是数字。 */
export const DEVICE = Object.freeze({
  fw: 'hub_v2',
  board: 'watcher',
  ver: '0.2',
  camera: { w: 240, h: 240, maxBytes: 4 * 1024 * 1024, periodMs: 8000 },
  audio: { rate: 24000, bits: 16, ch: 1, maxVoiceSeconds: 10 },
  panel: { w: 412, h: 412 },
  clips: { fps: 10, idle: [160, 180], look: [156, 180], wave: [137, 180] },
})

/** 设备 → 桥。只有这四种；其它一律 UNSUPPORTED_UPLINK。 */
export const UPLINK = Object.freeze(['hello', 'pong', 'image', 'voice'])

/** 桥 → 设备。只有这七种；device.send() 会对其它值直接拒绝。 */
export const DOWNLINK = Object.freeze([
  'welcome',
  'ping',
  'say',
  'face',
  'audio',
  'audio_end',
  'shot',
])

/**
 * v2 明确不具备的能力：键是消息名，值是"为什么没有"。
 * 用途：① 工具按它做能力门控（不支持就不注册）；
 *      ② /health 与面板如实展示，别让人以为能用。
 */
export const UNSUPPORTED = Object.freeze({
  press: '按键只在设备本地起作用（录音开关/菜单），v2 不上行 press',
  record: 'v2 不处理 record 下行：录音只能由设备物理按键触发',
  mic: 'v2 不处理 mic 下行：没有免按键自动录音',
  state: 'v2 不上报电量/表情状态',
  level: 'v2 不上报旋钮/触摸数值',
  sound: 'v2 不做环境声分类',
  diag: 'v2 不上报自检遥测',
  text: 'v2 没有文本上行通道（按键录音后走 voice）',
})

/** 表情：与固件 proto.h 的 Mood 枚举同序同名（8 个）。 */
export const MOODS = Object.freeze([
  'idle',
  'blink',
  'listen',
  'think',
  'speak',
  'happy',
  'sad',
  'error',
])

/**
 * mood → 桌宠动作。v2 只有三段素材（pet_idle/look/wave），
 * 映射与固件 render.cc:269-282 的 PetClipFor 一一对应——改这里必须同时改那边。
 */
export const MOOD_CLIP = Object.freeze({
  idle: 'idle',
  blink: 'idle',
  sad: 'idle',
  listen: 'look',
  think: 'look',
  error: 'look',
  speak: 'wave',
  happy: 'wave',
})

/** 工具清单：名字必须与 tools.js 实际注册的一致（contract.test 会比对）。 */
export const TOOLS = Object.freeze([
  'device_status',
  'device_say',
  'device_face',
  'device_shot',
  'device_events',
  'device_capabilities',
])

/**
 * 每个工具依赖的下行能力。缺能力就不注册（而不是注册个空转的）。
 * device_shot 依赖 shot：设备收到后拍一张、立刻上行 image。
 */
export const TOOL_NEEDS = Object.freeze({
  device_status: null,
  device_say: 'say',
  device_face: 'face',
  device_shot: 'shot',
  device_events: null,
  device_capabilities: null,
})

/** HTTP 路由：只读 vs 动作（动作要令牌或本机）。http.js 从这里派生。 */
export const ROUTES = Object.freeze({
  read: ['/health', '/api/state', '/events', '/commands', '/moods', '/panel', '/', '/shot.jpg'],
  act: ['/say', '/api/speak', '/api/face', '/shot', '/api/config', '/api/linktest'],
  /** v2 做不到、但历史上存在过的接口：保留路径，返回 501 + 原因，不静默 404。 */
  gone: {
    '/listen': 'v2 没有 record 下行，无法远程触发录音；请按设备上的按键',
    '/mic': 'v2 没有 mic 下行，无法远程开关自动录音',
  },
})

export const CAPABILITIES = Object.freeze({
  uplink: UPLINK,
  downlink: DOWNLINK,
  unsupported: UNSUPPORTED,
  tools: TOOLS,
  routes: ROUTES,
})

/** 人读的摘要（/health、日志、工具输出共用）。unsupported 带原因，不只是一串名字。 */
export function summarize() {
  return {
    fw: DEVICE.fw,
    ver: DEVICE.ver,
    uplink: [...UPLINK],
    downlink: [...DOWNLINK],
    unsupported: { ...UNSUPPORTED },
  }
}
