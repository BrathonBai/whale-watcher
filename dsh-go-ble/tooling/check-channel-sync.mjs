#!/usr/bin/env node
// 手机端「契约三方一致性」静态检查（不需要 Flutter/Gradle/设备）：
//
//   契约文档 §10.3/§4/§6  ⇄  Kotlin 原生侧  ⇄  Dart 通道侧  ⇄  固件 link_ble/adpcm  ⇄  桥 contract/config
//
// 为什么需要：T3 的 check-native-files.mjs 只查 Kotlin 文件自身完整性，T4 只自查 Dart；
// 本机没有 Flutter/Gradle 编不了，方法名/字段名/常量对不上只有到真机才炸。本脚本把能静态
// 对的全对一遍：方法集合、事件类型、status/config 字段、通道名、UUID、分帧常量、ADPCM 参数、
// guest patch 的键与路径、桥的监听路径/端口/token 参数、Manifest 权限、覆盖集清单。
//
// 用法：node dsh-go-ble/tooling/check-channel-sync.mjs   （失败逐条打印并 exit 1）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const readJson = (p) => JSON.parse(read(p))

const F = {
  spec: 'docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md',
  plugin: 'dsh-go-ble/files/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/embodied/EmbodiedBlePlugin.kt',
  framing: 'dsh-go-ble/files/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/embodied/EmbodiedFraming.kt',
  gateway: 'dsh-go-ble/files/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/embodied/EmbodiedGateway.kt',
  prefs: 'dsh-go-ble/files/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/embodied/EmbodiedPrefs.kt',
  guest: 'dsh-go-ble/files/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/EmbodiedGuest.kt',
  manifest: 'dsh-go-ble/files/app/android/app/src/main/AndroidManifest.xml',
  channel: 'dsh-go-ble/files/app/lib/embodied/embodied_channel.dart',
  fwBle: 'firmware-v2/main/link_ble.cc',
  fwBleH: 'firmware-v2/main/link_ble.h',
  fwAdpcm: 'firmware-v2/main/adpcm.h',
  bridgeConfig: 'bridge/lib/config.js',
  bridgeWs: 'bridge/lib/ws.js',
  bridgeDevice: 'bridge/lib/device.js',
}
const src = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, read(p)]))

const failures = []
let checks = 0
const fail = (what, detail = '') => failures.push(detail ? `${what}\n    ${detail}` : what)
const eq = (what, actual, expected) => {
  checks++
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) fail(what, `实际=${a} 期望=${b}`)
}
const sameSet = (what, actual, expected) => eq(what, [...new Set(actual)].sort(), [...new Set(expected)].sort())
const has = (what, text, needles) => {
  for (const n of needles) {
    checks++
    if (!text.includes(n)) fail(`${what}：缺少 ${JSON.stringify(n)}`)
  }
}
const matchAll = (text, re) => [...text.matchAll(re)].map((m) => m[1])

// ───────────── 1. §10.3 方法集合 ─────────────
const specSection = (() => {
  const a = src.spec.indexOf('### 10.3')
  const b = src.spec.indexOf('### 10.4')
  return a >= 0 && b > a ? src.spec.slice(a, b) : ''
})()
const specMethods = matchAll(specSection, /^\|\s*`([a-zA-Z]+)`\s*\|/gm)
const kotlinWhen = (() => {
  const a = src.plugin.indexOf('when (call.method)')
  const b = src.plugin.indexOf('else -> result.notImplemented()')
  return a >= 0 && b > a ? src.plugin.slice(a, b) : ''
})()
const kotlinMethods = matchAll(kotlinWhen, /"([a-zA-Z]+)"\s*->/g)
const dartMethods = matchAll(src.channel, /_(?:invoke|expectOk)\('([a-zA-Z]+)'/g)
eq('§10.3 方法数（文档表）', specMethods.length, 9)
sameSet('方法集合：文档 vs Kotlin when(call.method)', kotlinMethods, specMethods)
sameSet('方法集合：文档 vs Dart invoke/expectOk', dartMethods, specMethods)

// ───────────── 2. 通道名 / 事件类型 ─────────────
const chanNames = (text) => [...new Set(matchAll(text, /"(dsh\/embodied_ble(?:\/events)?)"/g).concat(matchAll(text, /'(dsh\/embodied_ble(?:\/events)?)'/g)))]
sameSet('通道名：Kotlin vs Dart', chanNames(src.plugin), chanNames(src.channel))
eq('通道名应是文档里的两个', chanNames(src.channel).sort(), ['dsh/embodied_ble', 'dsh/embodied_ble/events'])
const kotlinEvents = matchAll(src.gateway, /"type" to "([a-z]+)"/g)
const dartEvents = matchAll(src.channel, /case '([a-z]+)':/g)
sameSet('事件 type：Kotlin emit vs Dart parse', kotlinEvents, ['status', 'scan', 'log'])
sameSet('事件 type：Dart parse 覆盖三种', dartEvents, ['status', 'scan', 'log'])

// ───────────── 3. status / config 字段（文档 §10.3 ⇄ 两侧） ─────────────
const EXPECT_STATUS = ['service', 'enabled', 'adapter', 'permission', 'engine', 'ble', 'bridge', 'lastError']
const EXPECT_BLE = ['state', 'device', 'txBytes', 'rxBytes', 'txDrop', 'rxDrop']
const EXPECT_DEVICE = ['name', 'address', 'rssi', 'mtu']
const EXPECT_BRIDGE = ['url', 'connected', 'reconnects']
const snap = (() => {
  const a = src.gateway.indexOf('fun snapshot()')
  const b = src.gateway.indexOf('\n    fun start()', a)
  return a >= 0 ? src.gateway.slice(a, b > a ? b : undefined) : ''
})()
for (const k of EXPECT_STATUS) {
  checks++
  if (!new RegExp(`"${k}" to `).test(snap)) fail(`Kotlin snapshot 缺顶层字段 ${k}`)
  checks++
  if (!src.channel.includes(`map['${k}']`)) fail(`Dart EmbodiedStatus.fromMap 不读 ${k}`)
}
for (const k of EXPECT_BLE.concat(EXPECT_DEVICE, EXPECT_BRIDGE)) {
  checks++
  const inKotlin = new RegExp(`"${k}" to `).test(snap)
  if (!inKotlin) fail(`Kotlin snapshot 缺嵌套字段 ${k}`)
}
has('Dart 读取嵌套字段', src.channel, EXPECT_BLE.map((k) => `map['${k}']`))
has('Dart 读取设备字段', src.channel, EXPECT_DEVICE.map((k) => `map['${k}']`))
has('Dart 读取桥字段', src.channel, EXPECT_BRIDGE.map((k) => `map['${k}']`))
has('Kotlin prefs.config 暴露页面所需字段', src.prefs, ['"bridgeUrl" to ', '"autoConnect" to ', '"devicePrefix" to ', '"enabled" to '])
has('Dart EmbodiedConfig 读取页面所需字段', src.channel, ["map['bridgeUrl']", "map['autoConnect']", "map['devicePrefix']", "map['enabled']"])

// ───────────── 4. UUID（文档 ⇄ Kotlin ⇄ 固件 C 数组） ─────────────
const SPEC_UUIDS = [
  '6a696e67-6a69-6e67-8000-000000000001',
  '6a696e67-6a69-6e67-8000-000000000002',
  '6a696e67-6a69-6e67-8000-000000000003',
]
const specUuids = matchAll(src.spec, /`(6a696e67-6a69-6e67-8000-[0-9a-f]{12})`/g)
sameSet('§3 UUID 清单', specUuids, SPEC_UUIDS)
sameSet('UUID：文档 vs Kotlin', matchAll(src.gateway, /UUID\.fromString\("([0-9a-f-]{36})"\)/g).filter((u) => u.startsWith('6a696e67')), SPEC_UUIDS)
const wire = (u) => u.replace(/-/g, '').match(/../g).reverse().map((h) => `0x${h}`)
const cUuid = (name) => {
  const m = src.fwBle.match(new RegExp(`${name}\\[16\\] = \\{([^}]*)\\}`))
  checks++
  if (!m) fail(`固件缺 ${name}[16]`)
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => `0x${BigInt(s).toString(16).padStart(2, '0')}`) : []
}
eq('UUID 线上字节：固件 kUuidSvcLe vs 文档', cUuid('kUuidSvcLe'), wire(SPEC_UUIDS[0]))
eq('UUID 线上字节：固件 kUuidDownLe vs 文档', cUuid('kUuidDownLe'), wire(SPEC_UUIDS[1]))
eq('UUID 线上字节：固件 kUuidUpLe vs 文档', cUuid('kUuidUpLe'), wire(SPEC_UUIDS[2]))

// ───────────── 5. 分帧常量（§4 ⇄ Kotlin ⇄ 固件） ─────────────
const kotlinConst = (n) => Number(BigInt(src.framing.match(new RegExp(`${n}\\s*=\\s*(0x[0-9A-Fa-f]+|\\d+)`))?.[1] ?? 'NaN'))
const cConst = (n) => Number(BigInt(src.fwBle.match(new RegExp(`${n}\\s*=\\s*(0x[0-9A-Fa-f]+|\\d+)`))?.[1] ?? 'NaN'))
eq('分帧 magic/type/header：Kotlin', [kotlinConst('MAGIC'), kotlinConst('TYPE_TEXT'), kotlinConst('TYPE_BINARY'), kotlinConst('HEADER_BYTES')], [0xa5, 1, 2, 7])
eq('分帧 magic/type/header：固件', [cConst('kMagic'), cConst('kTypeText'), cConst('kTypeBinary'), cConst('kFrameHeader')], [0xa5, 1, 2, 7])
eq('消息上限：Kotlin', [kotlinConst('MAX_TEXT_BYTES'), kotlinConst('MAX_BINARY_BYTES')], [4096, 16384])
const fwHeaderConst = (n) => Number(BigInt(src.fwBleH.match(new RegExp(`${n}\\s*=\\s*(0x[0-9A-Fa-f]+|\\d+)`))?.[1] ?? 'NaN'))
eq('消息上限：固件 link_ble.h', [fwHeaderConst('kMaxTextBytes'), fwHeaderConst('kMaxBinaryBytes')], [4096, 16384])

// ───────────── 6. ADPCM 参数（桥 ⇄ 固件 ⇄ 文档） ─────────────
const { ADPCM } = await import(pathToFileURL(path.join(ROOT, 'bridge/lib/adpcm.js')).href)
const num = (re) => Number(src.fwAdpcm.match(re)?.[1] ?? NaN)
const cRate = num(/kRate\s*=\s*(\d+)/)
const cBlock = num(/kBlockBytes\s*=\s*(\d+)/)
const cHeader = num(/kHeaderBytes\s*=\s*(\d+)/)
checks++
const cSamples = /kSamplesPerBlock\s*=\s*kNibbleSamples\s*\+\s*1/.test(src.fwAdpcm) ? (cBlock - cHeader) * 2 + 1 : num(/kSamplesPerBlock\s*=\s*(\d+)/)
if (cSamples !== (cBlock - cHeader) * 2 + 1) fail('固件 samplesPerBlock 推导不是 (block-header)*2+1')
const cBpsExpr = /kBytesPerSecond\s*=\s*\(kBlockBytes \* kRate\) \/ kSamplesPerBlock/.test(src.fwAdpcm)
const cBps = cBpsExpr ? Math.floor((cBlock * cRate) / cSamples) : num(/kBytesPerSecond\s*=\s*(\d+)/)
eq('ADPCM 参数：桥 vs 固件', [ADPCM.rate, ADPCM.blockAlign, ADPCM.headerBytes, ADPCM.samplesPerBlock, ADPCM.bytesPerSecond, ADPCM.maxVoiceBytes], [cRate, cBlock, cHeader, cSamples, cBps, num(/kVoiceMaxBytes\s*=\s*(\d+)/)])
has('文档 §6 写明 ADPCM 关键数字', src.spec, ['1024', '2041', '12041', 'samples'])

// ───────────── 7. guest 注入（Kotlin patch ⇄ 桥 config/路由） ─────────────
const patchFn = (() => {
  const a = src.guest.indexOf('fun patchYaml(')
  const b = src.guest.indexOf('fun launchArg', a)
  return a >= 0 ? src.guest.slice(a, b > a ? b : undefined) : ''
})()
for (const k of ['host', 'port', 'wsToken', 'discover', 'imageKeep', 'voiceKeep']) {
  checks++
  if (!new RegExp(`${k}:`).test(patchFn)) fail(`guest patch 缺桥配置键 ${k}`)
}
has('guest patch 指向回环 7788 并关发现', patchFn, ['host: 127.0.0.1', 'port: 7788', 'discover: false'])
has('桥 config.js 认识这些键', src.bridgeConfig, ['host:', 'port:', 'wsToken:', 'discover:', 'imageKeep:', 'voiceKeep:'])
has('guest 注入目录/入口/注入方式', src.guest, ['"/opt/dsh-app/embodied"', 'lib/index.js', '--patch $PATCH'])
has('手机默认桥 URL 与桥端口/路径一致', src.prefs, ['ws://127.0.0.1:7788/device'])
checks++
if (!/searchParams\.get\('token'\)/.test(src.bridgeWs)) fail('桥 ws.js 不读 ?token=')
checks++
if (!/path:\s*'\/device'/.test(src.bridgeConfig)) fail("桥 config.js 默认升级路径不是 '/device'")
checks++
if (!src.gateway.includes('token=') || !src.gateway.includes('"?"')) fail('网关 URL 不追加 ?token=')

// ───────────── 8. Manifest 权限 / FGS ─────────────
has('Manifest 权限', src.manifest, [
  'android:name="android.permission.BLUETOOTH"',
  'android:name="android.permission.BLUETOOTH_ADMIN"',
  'android:name="android.permission.ACCESS_FINE_LOCATION"',
])
checks++
if (/android:name="android\.permission\.BLUETOOTH"\s+tools:node="remove"/.test(src.manifest)) fail('Manifest 仍把 BLUETOOTH 标成 remove')
has('Manifest 声明 EmbodiedBleService/specialUse', src.manifest, ['android:name=".embodied.EmbodiedBleService"', 'foregroundServiceType="specialUse"'])

// ───────────── 9. 覆盖集清单 / assets ─────────────
const manifest = readJson('dsh-go-ble/files-manifest.json')
eq('files-manifest 条目数', manifest.entries.length, 45)
eq('files-manifest 新增/替换计数', [manifest.counts.added, manifest.counts.replaced], [35, 10])
for (const p of ['assets/engine/embodied/package.json', 'assets/engine/embodied/lib/index.js', 'assets/engine/embodied/lib/adpcm.js']) {
  checks++
  if (!fs.existsSync(path.join(ROOT, 'dsh-go-ble/files/app', p))) fail(`assets 缺 ${p}`)
}

// ───────────── 输出 ─────────────
if (failures.length) {
  console.error(`✗ ${failures.length}/${checks} 项不一致：\n`)
  for (const f of failures) console.error('  ✗ ' + f + '\n')
  process.exit(1)
}
console.log(`OK: ${checks} 项契约一致性检查全部通过`)
console.log('  · §10.3 方法/事件/status/config 字段：文档 ⇄ Kotlin ⇄ Dart')
console.log('  · UUID/分帧/ADPCM：文档 ⇄ Kotlin ⇄ 固件 ⇄ 桥')
console.log('  · guest 注入/patch 键/监听路径/端口/token：Kotlin ⇄ 桥')
console.log('  · Manifest 权限 + FGS + 覆盖集清单 + 插件 assets')
