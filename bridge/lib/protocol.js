// protocol.js —— 设备 ⇄ 桥 的线协议（严格对齐 v2 契约）。
//
// 设计取向（沿用 v0.2 的三条，仍然成立）：
//   · 上行只发"原语"，语义留在云端；
//   · 下行统一由这里构造，别处不许手拼 JSON；
//   · 解析器自带长度上限，坏帧只丢一条，不拖垮连接。
//
// 与 v1（fw 0.8）的差别——这一版是**砍**，不是加：
//   · 只解析 hello / pong / image / voice 四种上行；press/level/sound/diag/state/text
//     在 v2 里根本没有对端，收到就报 UNSUPPORTED_UPLINK（不再"解析成功然后没人用"）。
//   · 只构造 welcome/ping/say/face/audio/audio_end/shot 七种下行；device.send() 会拦。
//   · hello.ver 是字符串 "0.2"，这里按 string|number 都收，统一成字符串——v1 桥按数字解析，
//     所以日志里永远是 ver=0，版本校验形同虚设。
//
// 契约本体在 contract.js；本文件只做编解码，不重新定义清单。
import {
  DEVICE,
  DOWNLINK,
  MOODS,
  MOOD_CLIP,
  PROTOCOL_VERSION,
  UPLINK,
  UNSUPPORTED,
} from './contract.js'

export { PROTOCOL_VERSION, MOODS, MOOD_CLIP, UPLINK, DOWNLINK, UNSUPPORTED }

const MOOD_SET = new Set(MOODS)

/** 设备能渲染的表情（给工具 schema 用）。 */
export const MOOD_NAMES = [...MOODS]

/**
 * 命令目录：字段形状照 Muse 的 add_command(description, required, optional)。
 * 这里只列 v2 真做得到的；做不到的（listen/mic）不列，免得模型反复调用。
 */
export const COMMANDS = Object.freeze({
  'device.say': {
    description: '让设备把这段话显示/说出来。mood 可选，缺省按内容自动选。',
    required: { text: { type: 'string', description: '要说的话，建议 ≤120 字' } },
    optional: { mood: { type: 'string', description: `表情，取值 ${MOODS.join('/')}` } },
  },
  'device.face': {
    description: `只改表情（顺带换桌宠动作），不发声。取值 ${MOODS.join('/')}`,
    required: { mood: { type: 'string', description: '目标表情' } },
    optional: {},
  },
  'device.shot': {
    description: '让设备现在拍一张（240×240 JPEG），返回落盘路径。',
    required: {},
    optional: { timeoutMs: { type: 'integer', description: '等图超时，默认 8000' } },
  },
  'device.status': {
    description: '查询设备是否在线、连了多久、固件版本、最近一次上行、以及它支持什么。',
    required: {},
    optional: {},
  },
  'device.events': {
    description: '读设备最近的上行事件（目前只有 hello/pong/image/voice）。',
    required: {},
    optional: {
      after: { type: 'integer', description: '只取序号大于它的（默认 0 = 全部）' },
      limit: { type: 'integer', description: '最多几条，默认 30' },
    },
  },
  'device.capabilities': {
    description: '列出这台设备支持的上行/下行消息和不具备的能力（含原因）。',
    required: {},
    optional: {},
  },
})

/** 把命令目录整理成模型可读的一行行文本。 */
export function describeCommands() {
  return Object.entries(COMMANDS)
    .map(([name, c]) => {
      const req = Object.keys(c.required)
      const opt = Object.keys(c.optional)
      const args = [...req.map((k) => `<${k}>`), ...opt.map((k) => `[${k}]`)].join(' ')
      return `- ${name}${args ? ' ' + args : ''}: ${c.description}`
    })
    .join('\n')
}

/** 从一段回复里猜一个表情（很轻的规则，失败就 idle）。 */
export function guessMood(text) {
  const s = String(text ?? '')
  if (!s) return 'idle'
  if (/[!！]|哈哈|太好了|棒|开心|nice|cool/i.test(s)) return 'happy'
  if (/抱歉|对不起|失败|错误|无法|sorry|error/i.test(s)) return 'sad'
  if (/[?？]/.test(s)) return 'think'
  return 'speak'
}

const fail = (code, message) => ({ ok: false, error: { code, message } })
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** ver 可能是 "0.2" / 0.2 / 2；统一成非空字符串，绝不静默变 0。 */
function normalizeVersion(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

/**
 * 解析设备上行的一条 JSON 文本。
 * @returns {{ok:true,msg:object}|{ok:false,error:{code:string,message:string}}}
 */
export function parseDeviceMessage(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return fail('EMPTY', 'empty frame')
  if (raw.length > 8192) return fail('TOO_LARGE', 'frame exceeds 8 KiB')

  let v
  try {
    v = JSON.parse(raw)
  } catch {
    return fail('BAD_JSON', 'not valid JSON')
  }
  if (!isPlainObject(v)) return fail('BAD_SHAPE', 'message must be an object')
  const t = v.t
  if (typeof t !== 'string' || t.length === 0) return fail('NO_TYPE', 'missing "t"')

  switch (t) {
    case 'hello':
      return {
        ok: true,
        msg: {
          t,
          fw: str(v.fw) ?? 'unknown',
          board: str(v.board) ?? '',
          ver: normalizeVersion(v.ver),
          cam: num(v.cam) ?? 0,
          w: num(v.w) ?? 0,
          h: num(v.h) ?? 0,
        },
      }
    case 'pong':
      return { ok: true, msg: { t } }
    case 'image': {
      const bytes = num(v.bytes)
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes > DEVICE.camera.maxBytes) {
        return fail('BAD_IMAGE', `image.bytes 必须是 1..${DEVICE.camera.maxBytes}`)
      }
      return {
        ok: true,
        msg: { t, bytes, w: num(v.w) ?? 0, h: num(v.h) ?? 0, seq: num(v.seq) ?? 0 },
      }
    }
    case 'voice': {
      const bytes = num(v.bytes)
      const limit = DEVICE.audio.rate * 2 * DEVICE.audio.maxVoiceSeconds * 1.2 | 0
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes > limit) {
        return fail('BAD_BYTES', `voice.bytes 必须是 1..${limit}`)
      }
      return {
        ok: true,
        msg: { t, bytes, rate: num(v.rate) ?? DEVICE.audio.rate, seq: num(v.seq) ?? 0 },
      }
    }
    default: {
      // 这里**不是**"向前兼容"，是显式拒绝：v2 没有这个对端，解析成功只会掩盖问题。
      const why = UNSUPPORTED[t] ? `（${UNSUPPORTED[t]}）` : ''
      return fail('UNSUPPORTED_UPLINK', `设备不发 "${t}"：v2 契约只有 ${UPLINK.join('/')}${why}`)
    }
  }
}

// ============================ 下行 ============================
// 每个构造器都必须产出 DOWNLINK 里的类型；test/contract.test.mjs 会逐条比对。

/** 大脑 → 设备：让设备说话（文本 + 动作；是否出声由 speaker 决定）。 */
export function say(text, mood) {
  const m = MOOD_SET.has(mood) ? mood : guessMood(text)
  return { t: 'say', text: String(text ?? '').slice(0, 2000), mood: m }
}

/** 大脑 → 设备：只改表情/动作。 */
export function face(mood) {
  return { t: 'face', mood: MOOD_SET.has(mood) ? mood : 'idle' }
}

/** 大脑 → 设备：现在拍一张（设备回一条 image 上行）。 */
export function shot() {
  return { t: 'shot' }
}

/** 大脑 → 设备：心跳。 */
export function ping() {
  return { t: 'ping', ver: PROTOCOL_VERSION }
}

/** 大脑 → 设备：上线握手回执（设备只记一行日志并忽略内容）。 */
export function welcome() {
  return { t: 'welcome', ver: PROTOCOL_VERSION }
}

/** 大脑 → 设备：一条语音的头（后面跟二进制 PCM，最后 audio_end）。 */
export function audioHead({ rate = DEVICE.audio.rate, bits = DEVICE.audio.bits, channels = DEVICE.audio.ch, bytes = 0, seq = 0 }) {
  return { t: 'audio', rate, bits, ch: channels, bytes, seq }
}

export function audioEnd(seq) {
  return { t: 'audio_end', seq }
}
