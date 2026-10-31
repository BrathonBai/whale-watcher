// 虚拟 Watcher：在没有硬件（或者设备在充电）时跑通整条回路。
//
//   node test/fake-watcher.mjs                  # 连 127.0.0.1:7788
//   node test/fake-watcher.mjs ws://192.168.0.17:7788/device
//
// 它会：握手（hello）→ 打印大脑下发的每一条消息 → 让你从键盘输入，当"设备说了这句话"。
// 命令：
//   /p        按一下（press down）
//   /p2       双击（重播上一句）
//   /l        让设备录 1 秒（上行一段静音 PCM，验证 record→voice→WAV 链路）
//   /s        发一条环境声事件
//   /h        重新握手
//   其它文本   当成设备说的一句话（会走大脑）
import readline from 'node:readline'

const url = process.argv[2] || 'ws://127.0.0.1:7788/device'
const ws = new WebSocket(url)
let seq = 0
let recording = 0

const send = (obj) => {
  ws.send(JSON.stringify(obj))
  console.log('  ↑', JSON.stringify(obj).slice(0, 120))
}

const log = (...a) => console.log(...a)

ws.addEventListener('open', () => {
  log(`连上了 ${url}`)
  send({ t: 'hello', fw: 'fake-0.8', board: 'watcher', ver: 1 })
})

ws.addEventListener('message', (e) => {
  if (typeof e.data !== 'string') {
    if (recording > 0) {
      recording -= e.data.byteLength ?? e.data.length ?? 0
      return
    }
    log(`  ↓ [binary ${e.data.byteLength ?? e.data.length} B]`)
    return
  }
  let m
  try {
    m = JSON.parse(e.data)
  } catch {
    log('  ↓ ', e.data)
    return
  }
  switch (m.t) {
    case 'welcome':
      log(`  ↓ welcome ver=${m.ver} moods=${(m.moods || []).join(',')}`)
      break
    case 'say':
      log(`  ↓ say [${m.mood}] ${m.text}`)
      break
    case 'face':
      log(`  ↓ face ${m.mood}`)
      break
    case 'audio':
      log(`  ↓ audio ${m.bytes} B @${m.rate}Hz seq=${m.seq}（后面跟二进制 PCM）`)
      break
    case 'audio_end':
      log('  ↓ audio_end')
      break
    case 'mic':
      log(`  ↓ mic auto=${m.auto}`)
      break
    case 'record':
      log(`  ↓ record ${m.seconds}s → 回一段静音 PCM`)
      recording = 24000 * 2 * Number(m.seconds || 1)
      send({ t: 'voice', bytes: recording, rate: 24000, seq: ++seq })
      ws.send(new Uint8Array(recording))
      break
    case 'ping':
      send({ t: 'pong' })
      break
    case 'result':
      log(`  ↓ result ok=${m.ok} ${m.ok ? '' : JSON.stringify(m.error)}`)
      break
    default:
      log('  ↓', JSON.stringify(m).slice(0, 160))
  }
})

ws.addEventListener('close', (e) => {
  log(`断开（${e.code} ${e.reason || ''}）`)
  process.exit(0)
})
ws.addEventListener('error', (e) => {
  log('连接出错：', e?.message ?? e)
  process.exit(1)
})

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你说> ' })
rl.prompt()
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return rl.prompt()
  if (s === '/p') send({ t: 'press', edge: 'down', count: 1 })
  else if (s === '/p2') send({ t: 'press', edge: 'down', count: 2 })
  else if (s === '/l') {
    recording = 48000
    send({ t: 'voice', bytes: recording, rate: 24000, seq: ++seq })
    ws.send(new Uint8Array(recording))
  } else if (s === '/s') send({ t: 'sound', kind: 'speech', level: 0.62, ms: 900 })
  else if (s === '/h') send({ t: 'hello', fw: 'fake-0.8', board: 'watcher', ver: 1 })
  else send({ t: 'text', text: s })
  setTimeout(() => rl.prompt(), 80)
})
