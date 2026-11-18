// WebSocket 编解码单测（从原 protocol.test.mjs 拆出来，保持原样）。
//
// 跑：node test/ws.test.mjs
// 为什么单独一个文件：协议测试要能独立演进（v1→v2 已经换过一次），
// WS 分帧是 RFC 6455 的稳定实现，不该被协议改版牵连。
import test from 'node:test'
import assert from 'node:assert/strict'

import { FrameParser, OPCODE, encodeText, wsAccept } from '../lib/ws.js'

/** 构造一个「客户端→服务端」的掩码帧。 */
function clientFrame(opcode, payload, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

test('wsAccept 命中 RFC 6455 官方样例', () => {
  assert.equal(wsAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('服务端文本帧可被解析回原文', () => {
  const frame = encodeText({ t: 'say', text: '你好' })
  // 服务端帧不带 mask：默认解析器（服务端视角）必须拒；客户端视角必须收
  const strict = new FrameParser().push(frame)
  assert.equal(strict.error, 'client frame not masked', '服务端视角拒未掩码帧')
  const client = new FrameParser({ requireMask: false }).push(frame)
  assert.equal(client.messages.length, 1)
  assert.deepEqual(JSON.parse(client.messages[0].payload.toString('utf8')), { t: 'say', text: '你好' })
  assert.equal(frame[0] & 0x80, 0x80, 'FIN 必须置位')

  // 带 mask 的客户端帧，两边都能解
  const asClient = clientFrame(OPCODE.TEXT, JSON.stringify({ t: 'say', text: '你好' }))
  const p = new FrameParser()
  const { messages } = p.push(asClient)
  assert.equal(messages.length, 1)
  assert.deepEqual(JSON.parse(messages[0].payload.toString('utf8')), { t: 'say', text: '你好' })
})

test('分片消息会被累积成一条', () => {
  const p = new FrameParser()
  const a = p.push(clientFrame(OPCODE.TEXT, 'he', false))
  assert.equal(a.messages.length, 0, '首片不应产出消息')
  const b = p.push(clientFrame(OPCODE.CONT, 'llo', true))
  assert.equal(b.messages.length, 1)
  assert.equal(b.messages[0].payload.toString(), 'hello')
})

test('未掩码的客户端帧被拒', () => {
  const maskedless = Buffer.concat([Buffer.from([0x81, 0x03]), Buffer.from('abc')])
  const { error } = new FrameParser().push(maskedless)
  assert.equal(error, 'client frame not masked')
})

test('超长帧被拒', () => {
  const p = new FrameParser(16)
  const { error } = p.push(clientFrame(OPCODE.TEXT, 'x'.repeat(64)))
  assert.equal(error, 'frame too large')
})

// ============ 2026-11-13：/device 的 wsToken 校验（手机 loopback 用） ============
import { acceptUpgrade } from '../lib/ws.js'

/** 假 socket：只记录写/销毁，acceptUpgrade 成功路径需要 on/setNoDelay。 */
function fakeSocket() {
  const writes = []
  return {
    writes,
    destroyed: false,
    write(s) {
      writes.push(String(s))
    },
    end() {},
    destroy() {
      this.destroyed = true
    },
    setNoDelay() {},
    on() {},
  }
}

/** 用真实握手头构造一个 upgrade 请求。 */
function upgradeReq(url) {
  return {
    url,
    headers: {
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  }
}

test('acceptUpgrade：配置了 token 时，错误/缺失 token → 401 且不升级', () => {
  for (const url of ['/device', '/device?token=wrong', '/device?token=']) {
    const socket = fakeSocket()
    const conn = acceptUpgrade(upgradeReq(url), socket, Buffer.alloc(0), { path: '/device', token: 'abc123' })
    assert.equal(conn, null, `${url} 不该升级`)
    assert.ok(socket.writes[0].includes(' 401 '), `${url} 应返回 401`)
    assert.equal(socket.destroyed, true)
  }
})

test('acceptUpgrade：token 正确 → 101 升级；未配置 token 时不校验（PC 老行为）', () => {
  const ok = fakeSocket()
  const conn = acceptUpgrade(upgradeReq('/device?token=abc123'), ok, Buffer.alloc(0), {
    path: '/device',
    token: 'abc123',
    onOpen: () => {},
  })
  assert.ok(conn, 'token 正确应升级')
  assert.ok(ok.writes[0].startsWith('HTTP/1.1 101'), ok.writes[0])

  const legacy = fakeSocket()
  const conn2 = acceptUpgrade(upgradeReq('/device'), legacy, Buffer.alloc(0), { path: '/device' })
  assert.ok(conn2, '未配置 token（空串）时老行为不变')
})

test('acceptUpgrade：路径不对仍然是 404（先于 token 校验）', () => {
  const socket = fakeSocket()
  const conn = acceptUpgrade(upgradeReq('/other?token=abc123'), socket, Buffer.alloc(0), { path: '/device', token: 'abc123' })
  assert.equal(conn, null)
  assert.ok(socket.writes[0].includes(' 404 '))
})
