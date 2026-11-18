// tools.js —— 让 DSH 里的模型能主动操作设备（大脑 → 设备这一半）。
//
// 这一版的核心变化：**能力门控**。
//   v0.2 把 device_listen / device_mic 注册给模型，但它们要发的 record / mic 下行
//   在 v2 固件里没有对端（解析得到、应用层不处理）→ 模型调用只会等超时。
//   现在每个工具声明自己依赖哪条下行（contract.TOOL_NEEDS），依赖不满足就不注册。
//
// 三个约定（2026-10-28 踩过，别改）：
//   1. schema 里不能出现 type 数组（`type: ['object','null']` 会在 tools.register 里抛，
//      把整个插件 fiber 拖死、所有工具一起消失，端口却还在听）；
//   2. 输出必须是无损 JSON —— 上行消息里可能带 undefined，注册前统一剥掉；
//   3. 每个工具单独 try/catch 注册，一个坏定义不该连累其它工具。
import { MOODS } from './contract.js'
import { summarize, TOOL_NEEDS } from './contract.js'

const str = (description) => ({ type: 'string', description })

export function createTools({ cfg, log, device, brain, speaker, shootOnce }) {
  const clamp = (text) => String(text ?? '').slice(0, Math.max(40, Number(cfg.get().maxReplyChars) || 240))

  const statusTool = {
    name: 'device_status',
    description: '查询具身设备是否在线、连了多久、固件版本、最近一次上行、以及它的能力边界。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          online: { type: 'boolean' },
          connectedMs: { type: 'integer' },
          fw: { type: 'string' },
          ver: { type: 'string' },
          lastEvent: { type: 'object' },
          brain: { type: 'string' },
          sessionId: { type: 'string' },
          collecting: { type: 'object' },
          seq: { type: 'integer' },
        },
        required: ['online'],
        additionalProperties: true,
      },
      render: (_a, v) =>
        v.online
          ? [
              {
                type: 'text',
                text:
                  `设备在线 ${Math.round((v.connectedMs ?? 0) / 1000)}s · fw ${v.fw || '?'}/${v.ver || '?'}` +
                  `（大脑 ${v.brain}${v.sessionId ? ' · ' + v.sessionId.slice(-8) : ''}）`,
              },
            ]
          : [{ type: 'text', text: '设备离线' }],
    },
    async execute() {
      const strip = (o) => JSON.parse(JSON.stringify(o ?? {}))
      const ver = device.version
      return {
        online: device.online,
        connectedMs: device.connectedMs,
        fw: ver.fw || '',
        ver: ver.ver || '',
        lastEvent: strip(device.lastEvent),
        brain: brain.effective ?? brain.mode,
        sessionId: brain.sessionId || '',
        collecting: strip(device.collecting),
        seq: device.counters.seq,
      }
    },
  }

  const sayTool = {
    name: 'device_say',
    description: '让具身设备显示并念出一段短文本。适合播报结果、提醒或聊天回复。',
    parameters: {
      type: 'object',
      properties: {
        text: str('要说的话，建议 ≤120 字'),
        mood: { type: 'string', enum: [...MOODS], description: '可选表情（同时决定桌宠动作）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { sent: { type: 'boolean' }, mood: { type: 'string' } },
        required: ['sent'],
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: v.sent ? `已发送（表情 ${v.mood}）` : '设备不在线，未发送' }],
    },
    async execute(args) {
      const r = device.say(clamp(args.text), args.mood)
      // 上屏 ≠ 出声。v0.2 拆模块时这里漏过 speaker，表现为"显示文字但一声不吭"。
      if (r.sent && cfg.get().tts !== false) speaker?.speak?.(r.text)
      return { sent: r.sent, mood: r.mood }
    },
  }

  const faceTool = {
    name: 'device_face',
    description: `只改表情（顺带换桌宠动作），不发声。取值 ${MOODS.join(' / ')}（think=张望 speak=挥手）。`,
    parameters: {
      type: 'object',
      properties: { mood: { type: 'string', enum: [...MOODS], description: '目标表情' } },
      required: ['mood'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { sent: { type: 'boolean' }, mood: { type: 'string' } },
        required: ['sent', 'mood'],
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: v.sent ? `表情 → ${v.mood}` : '设备不在线，未发送' }],
    },
    async execute(args) {
      return { sent: device.face(args.mood), mood: args.mood }
    },
  }

  const shotTool = {
    name: 'device_shot',
    description: '让设备现在拍一张（240×240 JPEG），返回落盘路径；桥可以把这张图交给模型看。',
    parameters: {
      type: 'object',
      properties: { timeoutMs: { type: 'integer', description: '等图超时，默认 8000' } },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          w: { type: 'integer' },
          h: { type: 'integer' },
          ms: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_a, v) =>
        v.ok
          ? [{ type: 'text', text: `拍到了 ${v.w}x${v.h}（${v.bytes} B，${v.ms} ms）→ ${v.path}` }]
          : [{ type: 'text', text: `拍照失败：${v.error || '未知'}` }],
    },
    async execute(args) {
      return shootOnce({ timeoutMs: args.timeoutMs ?? 8000 })
    },
  }

  const eventsTool = {
    name: 'device_events',
    description: '读设备最近的上行事件（v2 只有 hello/pong/image/voice 四种）。',
    parameters: {
      type: 'object',
      properties: {
        after: { type: 'integer', description: '只取序号大于它的（默认 0 = 全部）' },
        limit: { type: 'integer', description: '最多几条，默认 30' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { seq: { type: 'integer' }, events: { type: 'array', items: { type: 'object' } } },
        required: ['seq'],
        additionalProperties: true,
      },
      render: (_a, v) =>
        v.events?.length
          ? [
              {
                type: 'text',
                text:
                  `${v.events.length} 条（最新序号 ${v.seq}）：` +
                  v.events
                    .slice(-8)
                    .map((e) => e.kind)
                    .join(' / '),
              },
            ]
          : [{ type: 'text', text: '还没有上行事件' }],
    },
    async execute(args) {
      const list = device.since(args.after ?? 0, args.limit ?? 30)
      return { seq: device.counters.seq, events: JSON.parse(JSON.stringify(list)) }
    },
  }

  const capsTool = {
    name: 'device_capabilities',
    description: '列出这台设备支持的上行/下行消息、可用工具，以及不具备的能力和原因。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          fw: { type: 'string' },
          ver: { type: 'string' },
          uplink: { type: 'array', items: { type: 'string' } },
          downlink: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' } },
          unsupported: { type: 'object' },
        },
        required: ['uplink', 'downlink'],
        additionalProperties: true,
      },
      render: (_a, v) => [
        {
          type: 'text',
          text:
            `上行 ${v.uplink.join('/')} · 下行 ${v.downlink.join('/')}\n` +
            `不具备：${Object.keys(v.unsupported || {}).join('/')}`,
        },
      ],
    },
    async execute() {
      const s = summarize()
      return { ...s, tools: [...device.capabilities.tools], unsupported: { ...s.unsupported } }
    },
  }

  const all = [statusTool, sayTool, faceTool, shotTool, eventsTool, capsTool]

  // ---- 能力门控：依赖的下行不在契约里就不注册 ----
  const downlink = new Set(device.capabilities.downlink)
  const usable = []
  for (const t of all) {
    const need = TOOL_NEEDS[t.name]
    if (need && !downlink.has(need)) {
      log.warn(`工具 ${t.name} 需要下行 "${need}"，这台设备不支持 → 不注册`)
      continue
    }
    usable.push(t)
  }
  return usable
}
