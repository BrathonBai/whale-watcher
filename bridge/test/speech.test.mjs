// speech 单测：PCM 汇聚器必须只发偶数字节（设备按 int16_t 解析）。
//
// 跑：node test/speech.test.mjs
//
// 背景（2026-10-31）：Breeze 流式分块 121 块里 72 块是奇数字节，
// 设备端 `(const int16_t*)p` + `n/2` 会丢掉最后 1 字节，之后整体错位 → 满耳噪声。
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEvenSink, makePrebufferGate, splitForTts } from '../lib/speech.js'

const collect = (chunks, maxBytes) => {
  const out = []
  const sink = makeEvenSink((b) => out.push(Buffer.from(b)), maxBytes)
  for (const c of chunks) sink.push(Buffer.from(c))
  const left = sink.end()
  return { out, left }
}

test('任意分块长度 → 发出的每一帧都是偶数且 ≤ 上限', () => {
  // 复刻实测里那些奇怪的长度
  const sizes = [8836, 4898, 1225, 377, 3621, 27, 2422, 1226, 1199, 27, 1250, 171, 1180, 27]
  const chunks = sizes.map((n) => Buffer.alloc(n, 7))
  const total = sizes.reduce((a, b) => a + b, 0)
  const { out, left } = collect(chunks)
  for (const b of out) {
    assert.equal(b.length % 2, 0, `发出了奇数字节帧：${b.length}`)
    assert.ok(b.length <= 16384, `帧太大：${b.length}`)
  }
  const sent = out.reduce((a, b) => a + b.length, 0)
  assert.equal(sent + left, total, '字节不能凭空消失')
  assert.ok(left <= 1, '最多留 1 个字节的 carry')
})

test('单帧超过 16 KB 会被切开', () => {
  const { out } = collect([Buffer.alloc(40001, 1)])
  for (const b of out) assert.ok(b.length <= 16384, `帧太大：${b.length}`)
  assert.equal(out.reduce((a, b) => a + b.length, 0), 40000, '偶数部分应全部发出')
})

test('字节顺序保持不变（拼回去与原始偶数前缀一致）', () => {
  const chunks = [3, 5, 7, 9].map((n, i) => Buffer.alloc(n, i + 1))
  const total = chunks.reduce((a, b) => a + b.length, 0)
  const { out } = collect(chunks)
  const joined = Buffer.concat(out)
  const original = Buffer.concat(chunks).subarray(0, joined.length)
  assert.deepEqual(joined, original, '拼接结果必须与原始字节顺序一致')
  assert.equal(joined.length % 2, 0)
  assert.ok(joined.length <= total)
})

test('空输入不出帧', () => {
  const { out, left } = collect([])
  assert.equal(out.length, 0)
  assert.equal(left, 0)
})

test('splitForTts 仍然按句切', () => {
  const parts = splitForTts('第一句。第二句！')
  assert.deepEqual(parts, ['第一句。', '第二句！'])
})

// ---- 预缓冲闸门（2026-10-31：首包 1117 ms + 块间隔 393 ms → 边到边播会卡顿）----
test('预缓冲：没攒够一个字节都不发，攒够了才发头+首批', () => {
  const sent = []
  let started = 0
  const gate = makePrebufferGate({
    bytes: 480, // 10 ms
    onStart: () => {
      ++started
      return true
    },
    send: (b) => sent.push(Buffer.from(b)),
  })
  gate.push(Buffer.alloc(100, 1))
  gate.push(Buffer.alloc(200, 2))
  assert.equal(sent.length, 0, '没攒够之前一帧都不该发')
  assert.equal(started, 0, 'onStart 也不该被调用')
  gate.push(Buffer.alloc(200, 3)) // 到 500 ≥ 480
  assert.equal(started, 1, 'onStart 只调用一次')
  assert.equal(sent.reduce((a, b) => a + b.length, 0), 500, '首批必须一次性全发（保持顺序）')
  assert.equal(sent[0][0], 1)
  assert.equal(gate.primed, 500)
})

test('预缓冲：起播之后的帧直通，不再攒', () => {
  const sent = []
  const gate = makePrebufferGate({ bytes: 100, onStart: () => true, send: (b) => sent.push(b.length) })
  gate.push(Buffer.alloc(120, 1))
  assert.equal(sent.length, 1)
  gate.push(Buffer.alloc(4, 1))
  gate.push(Buffer.alloc(6, 1))
  assert.deepEqual(sent, [120, 4, 6])
})

test('预缓冲：短句不足预缓冲时，start() 兜底全发一次', () => {
  const sent = []
  const gate = makePrebufferGate({ bytes: 1000, onStart: () => true, send: (b) => sent.push(b.length) })
  gate.push(Buffer.alloc(48, 1))
  assert.equal(sent.length, 0)
  gate.start()
  assert.equal(gate.started, true)
  assert.deepEqual(sent, [48])
  gate.start() // 幂等
  assert.deepEqual(sent, [48])
})

test('预缓冲：onStart 放弃（设备下线/被打断）→ 一个字节都不发', () => {
  const sent = []
  const gate = makePrebufferGate({ bytes: 10, onStart: () => false, send: (b) => sent.push(b) })
  gate.push(Buffer.alloc(20, 1))
  gate.push(Buffer.alloc(20, 1))
  gate.start()
  assert.equal(sent.length, 0)
  assert.equal(gate.aborted, true)
  assert.equal(gate.started, true, 'aborted 之后也不能重复触发 onStart')
})

test('预缓冲：0 即"来了就发"，行为与旧版一致', () => {
  const sent = []
  let started = 0
  const gate = makePrebufferGate({ bytes: 0, onStart: () => ++started, send: (b) => sent.push(b.length) })
  gate.push(Buffer.alloc(8, 1))
  assert.deepEqual(sent, [8])
  assert.equal(started, 1)
})
