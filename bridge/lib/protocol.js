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
  AUDIO,
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
const AUDIO_CODEC_SET = new Set(AUDIO.codecs)
const UPLINK_CODEC_SET = new Set(AUDIO.uplinkCodecs)
const TRANSPORTS = new Set(['ble', 'wifi'])

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
          // 2026-11-03 能力协商：老固件没有这两个字段 → 缺省 = 只会 PCM，不是错误。
          // codecs 里只认非空字符串（别让设备用奇怪类型把后续判断带偏）。
          codecs: Array.isArray(v.codecs)
            ? v.codecs.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 16).slice(0, 8)
            : [],
          opusRate: num(v.opusRate) ?? 0,
          // 2026-11-13（BLE）：全部可选；缺省 = wifi / pcm / 0 / 空名，老固件语义完全不变。
          transport: TRANSPORTS.has(str(v.transport)) ? str(v.transport) : 'wifi',
          uplink: UPLINK_CODEC_SET.has(str(v.uplink)) ? str(v.uplink) : 'pcm',
          mtu: num(v.mtu) ?? 0,
          name: str(v.name) ?? '',
        },
      }
    case 'pong': {
      // v2.1（2026-11-03）固件可能在 pong 里带音频/链路诊断字段；**缺字段不能报错**。
      // 只保留真的出现了的数字/字符串，缺失就是 undefined（不是 0）——否则"没有数据"
      // 会被自适应算法误当成"缓冲 0 ms"。
      const msg = { t }
      const pongFields = new Set([...AUDIO.pongDiag, ...AUDIO.pongStrings])
      for (const k of pongFields) {
        if (AUDIO.pongStrings.includes(k)) {
          const s = str(v[k])
          if (s) msg[k] = s
        } else {
          const n = num(v[k])
          if (n !== undefined) msg[k] = n
        }
      }
      return { ok: true, msg }
    }
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
      // 2026-11-13：voice.codec 可选（缺省 pcm）；adpcm 的字节上限比 PCM 小得多。
      const codec = UPLINK_CODEC_SET.has(str(v.codec)) ? str(v.codec) : 'pcm'
      const limit = codec === 'adpcm' ? AUDIO.adpcm.maxVoiceBytes : (DEVICE.audio.rate * 2 * DEVICE.audio.maxVoiceSeconds * 1.2) | 0
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes > limit) {
        return fail('BAD_BYTES', `voice.bytes 必须是 1..${limit}（codec=${codec}）`)
      }
      const samples = num(v.samples)
      if (samples !== undefined && (!Number.isFinite(samples) || samples <= 0 || samples > 480000)) {
        return fail('BAD_SAMPLES', 'voice.samples 必须是 1..480000')
      }
      return {
        ok: true,
        msg: {
          t,
          bytes,
          rate: num(v.rate) ?? DEVICE.audio.rate,
          seq: num(v.seq) ?? 0,
          codec,
          ...(samples !== undefined ? { samples } : {}),
        },
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

/**
 * 大脑 → 设备：一条语音的头（opus 时后面跟裸 Opus 包，pcm/adpcm 时跟二进制块，最后 audio_end）。
 *
 * codec（2026-11-03 契约新增；2026-11-13 加 adpcm）："pcm" | "opus" | "adpcm"；
 * 缺省/非法值一律按 pcm（老固件语义）。
 * opus 时约定 rate=24000（设备解码输出率）、bits=16、ch=1、bytes=0（流式，长度未知）。
 * adpcm 时可带 samples（解码后应有的 PCM 采样数，用于裁掉末块补齐的 1 个采样）。
 */
export function audioHead({ rate = DEVICE.audio.rate, bits = DEVICE.audio.bits, channels = DEVICE.audio.ch, bytes = 0, seq = 0, codec, samples } = {}) {
  const c = AUDIO_CODEC_SET.has(codec) ? codec : AUDIO.defaultCodec
  const head = { t: 'audio', rate, bits, ch: channels, bytes, seq, codec: c }
  const n = Number(samples)
  if (Number.isFinite(n) && n > 0) head.samples = n
  return head
}

export function audioEnd(seq) {
  return { t: 'audio_end', seq }
}
