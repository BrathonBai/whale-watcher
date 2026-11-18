// protocol 单测：对着 v2 固件的真实帧，而不是凭印象写。
//
// 跑：node test/protocol.test.mjs
// （不要用 node --test：它给每个文件派生子进程，受限环境会 spawn EPERM）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMANDS,
  DOWNLINK,
  MOODS,
  MOOD_CLIP,
  PROTOCOL_VERSION,
  UPLINK,
  audioEnd,
  audioHead,
  describeCommands,
  face,
  guessMood,
  parseDeviceMessage,
  ping,
  say,
  shot,
  welcome,
} from '../lib/protocol.js'
import { DEVICE, UNSUPPORTED } from '../lib/contract.js'

// app_ui.cc:126 的原文（ver 是**字符串**，这是 v1 桥解析成 0 的根因）
const REAL_HELLO = '{"t":"hello","fw":"hub_v2","board":"watcher","ver":"0.2","cam":1,"w":240,"h":240}'

test('hello：真实抓帧能被解析，ver 保留为字符串', () => {
  const r = parseDeviceMessage(REAL_HELLO)
  assert.equal(r.ok, true)
  assert.equal(r.msg.fw, 'hub_v2')
  assert.equal(r.msg.board, 'watcher')
  assert.equal(r.msg.ver, '0.2') // 关键：不是 0
  assert.equal(r.msg.cam, 1)
  assert.equal(r.msg.w, 240)
})

test('hello：数字 ver 也收，统一成字符串', () => {
  const r = parseDeviceMessage('{"t":"hello","fw":"hub_v2","ver":1.5}')
  assert.equal(r.ok, true)
  assert.equal(r.msg.ver, '1.5')
})

test('image / voice 头能解析（真实字段）', () => {
  const img = parseDeviceMessage('{"t":"image","bytes":5888,"w":240,"h":240,"seq":272}')
  assert.equal(img.ok, true)
  assert.deepEqual({ ...img.msg }, { t: 'image', bytes: 5888, w: 240, h: 240, seq: 272 })

  const v = parseDeviceMessage('{"t":"voice","bytes":177600,"rate":24000,"seq":3}')
  assert.equal(v.ok, true)
  assert.equal(v.msg.bytes, 177600)
  assert.equal(v.msg.rate, 24000)
})

test('v2 没有的上行必须被拒（不再"解析成功然后没人用"）', () => {
  const dead = ['press', 'record', 'mic', 'state', 'level', 'sound', 'diag', 'text']
  for (const t of dead) {
    const r = parseDeviceMessage(JSON.stringify({ t }))
    assert.equal(r.ok, false, `${t} 应该被拒`)
    assert.equal(r.error.code, 'UNSUPPORTED_UPLINK', `${t} 的错误码`)
    assert.match(r.error.message, new RegExp(t))
  }
  // 每一种都应该在契约里写明"为什么没有"
  for (const t of dead) assert.ok(UNSUPPORTED[t], `${t} 缺少原因说明`)
})

test('坏帧只丢一条：空串 / 非 JSON / 非对象 / 缺 t / 超长', () => {
  assert.equal(parseDeviceMessage('').error.code, 'EMPTY')
  assert.equal(parseDeviceMessage('{').error.code, 'BAD_JSON')
  assert.equal(parseDeviceMessage('[1,2]').error.code, 'BAD_SHAPE')
  assert.equal(parseDeviceMessage('{"x":1}').error.code, 'NO_TYPE')
  assert.equal(parseDeviceMessage('x'.repeat(9000)).error.code, 'TOO_LARGE')
})

test('字节数越界要拒：image > 4MB、voice > 10s', () => {
  const bigImg = parseDeviceMessage(JSON.stringify({ t: 'image', bytes: 5 * 1024 * 1024 }))
  assert.equal(bigImg.error.code, 'BAD_IMAGE')
  const bigVoice = parseDeviceMessage(JSON.stringify({ t: 'voice', bytes: 24000 * 2 * 60 }))
  assert.equal(bigVoice.error.code, 'BAD_BYTES')
})

test('所有下行构造器都落在 DOWNLINK 里', () => {
  const built = [
    say('hi'),
    say('hi', 'happy'),
    say('hi', '不存在的表情'),
    face('think'),
    face('乱写'),
    shot(),
    ping(),
    welcome(),
    audioHead({ bytes: 10, seq: 1 }),
    audioEnd(1),
  ]
  for (const m of built) assert.ok(DOWNLINK.includes(m.t), `构造出了契约外的下行：${m.t}`)
  assert.deepEqual(built[0], { t: 'say', text: 'hi', mood: 'speak' })
  assert.equal(built[3].mood, 'think')
  assert.equal(built[4].mood, 'idle') // 非法表情退回 idle，而不是发出去
  assert.equal(built[7].ver, PROTOCOL_VERSION)
  assert.equal(built[8].rate, DEVICE.audio.rate)
  assert.equal(built[8].ch, DEVICE.audio.ch)
})

test('表情 8 个，且三段素材映射只出现 idle/look/wave', () => {
  assert.equal(MOODS.length, 8)
  for (const m of MOODS) assert.ok(['idle', 'look', 'wave'].includes(MOOD_CLIP[m]), `${m} 映射到未知素材 ${MOOD_CLIP[m]}`)
  // 与固件 render.cc:269-282 的 PetClipFor 一致
  assert.deepEqual(
    MOODS.map((m) => MOOD_CLIP[m]),
    ['idle', 'idle', 'look', 'look', 'wave', 'wave', 'idle', 'look'],
  )
})

test('命令目录只列 v2 做得到的', () => {
  const tails = Object.keys(COMMANDS).map((k) => k.split('.')[1])
  assert.deepEqual(tails.sort(), ['capabilities', 'events', 'face', 'say', 'shot', 'status'])
  for (const t of tails) assert.ok(!UNSUPPORTED[t], `${t} 在"不具备"里，不该出现在命令目录`)
  assert.match(describeCommands(), /device\.shot/)
})

test('guessMood 的轻规则', () => {
  assert.equal(guessMood('太好了！'), 'happy')
  assert.equal(guessMood('抱歉，失败了'), 'sad')
  assert.equal(guessMood('现在几点？'), 'think')
  assert.equal(guessMood('好的'), 'speak')
  assert.equal(guessMood(''), 'idle')
})

test('上行清单就是 4 种，没有历史残留', () => {
  assert.deepEqual([...UPLINK], ['hello', 'pong', 'image', 'voice'])
})

// ============ 2026-11-13 BLE：新增可选字段全部向后兼容 ============

test('hello：老帧缺省 wifi/pcm，新帧解析 transport/uplink/mtu/name', () => {
  const old = parseDeviceMessage(REAL_HELLO)
  assert.equal(old.ok, true)
  assert.equal(old.msg.transport, 'wifi', '老固件缺省按 wifi')
  assert.equal(old.msg.uplink, 'pcm', '老固件缺省按 pcm')
  assert.equal(old.msg.mtu, 0)
  assert.equal(old.msg.name, '')

  const ble = parseDeviceMessage(
    JSON.stringify({
      t: 'hello', fw: 'hub_v2', ver: '0.3', codecs: ['pcm', 'opus', 'adpcm'], opusRate: 24000,
      transport: 'ble', uplink: 'adpcm', mtu: 247, name: 'Jingjing-1A2B',
    }),
  )
  assert.equal(ble.ok, true)
  assert.equal(ble.msg.transport, 'ble')
  assert.equal(ble.msg.uplink, 'adpcm')
  assert.equal(ble.msg.mtu, 247)
  assert.equal(ble.msg.name, 'Jingjing-1A2B')
  assert.deepEqual(ble.msg.codecs, ['pcm', 'opus', 'adpcm'])

  // 乱写的值不能带偏后续判断：transport/uplink 不合法 → 落回缺省
  const junk = parseDeviceMessage(JSON.stringify({ t: 'hello', transport: 'zigbee', uplink: 'flac' }))
  assert.equal(junk.msg.transport, 'wifi')
  assert.equal(junk.msg.uplink, 'pcm')
})

test('pong：新增 transport 字符串字段，缺字段不报错', () => {
  const bare = parseDeviceMessage('{"t":"pong"}')
  assert.equal(bare.ok, true)
  assert.equal(bare.msg.transport, undefined, '没带就是 undefined，不能假装成 wifi')
  const full = parseDeviceMessage('{"t":"pong","bufMs":120,"underruns":1,"codec":"adpcm","transport":"ble","mtu":247,"txDrop":0,"rxDrop":2}')
  assert.equal(full.ok, true)
  assert.equal(full.msg.codec, 'adpcm')
  assert.equal(full.msg.transport, 'ble')
  assert.equal(full.msg.mtu, 247)
  assert.equal(full.msg.rxDrop, 2)
})

test('voice：codec 缺省 pcm；adpcm 上限更小；samples 可选且要合法', () => {
  const old = parseDeviceMessage('{"t":"voice","bytes":177600,"rate":24000,"seq":3}')
  assert.equal(old.msg.codec, 'pcm')
  assert.equal(old.msg.bytes, 177600)

  const adpcm = parseDeviceMessage('{"t":"voice","bytes":120000,"codec":"adpcm","samples":240000,"seq":4}')
  assert.equal(adpcm.ok, true)
  assert.equal(adpcm.msg.codec, 'adpcm')
  assert.equal(adpcm.msg.samples, 240000)

  // adpcm 超过 240000 B 要被拒（上限比 PCM 小）
  const tooBig = parseDeviceMessage('{"t":"voice","bytes":300000,"codec":"adpcm"}')
  assert.equal(tooBig.ok, false)
  assert.equal(tooBig.error.code, 'BAD_BYTES')
  // PCM 的 300000 B 仍然合法（老固件 10 s 语音约 480 KB）
  assert.equal(parseDeviceMessage('{"t":"voice","bytes":300000}').ok, true)

  // 非法 codec → 落回 pcm 并按 pcm 上限判（不当成新编码）
  assert.equal(parseDeviceMessage('{"t":"voice","bytes":120,"codec":"flac"}').msg.codec, 'pcm')
  // samples 非法
  assert.equal(parseDeviceMessage('{"t":"voice","bytes":120,"samples":0}').error.code, 'BAD_SAMPLES')
})

test('audioHead：adpcm + samples 进入下行头，非法 codec 仍落 pcm', () => {
  const h = audioHead({ codec: 'adpcm', rate: 24000, bits: 16, ch: 1, bytes: 1024, seq: 7, samples: 2041 })
  assert.deepEqual(h, { t: 'audio', rate: 24000, bits: 16, ch: 1, bytes: 1024, seq: 7, codec: 'adpcm', samples: 2041 })
  assert.equal(audioHead({ codec: 'adpcm' }).samples, undefined)
  assert.equal(audioHead({ codec: 'flac' }).codec, 'pcm')
})
