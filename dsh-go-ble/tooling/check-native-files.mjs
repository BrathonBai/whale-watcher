#!/usr/bin/env node
// Static self-check for the dsh-Go native side of the BLE modification set (protocol §4/§10).
//
// This checkout has no Flutter and no Gradle, so nothing here compiles Kotlin. What it does check is
// what a broken overwrite or a contract drift would hit first: the expected file set, UTF-8/LF,
// balanced delimiters outside strings/comments, the manifest edits §10.4 requires, and the frozen
// channel names, UUIDs and framing constants §4/§10.3 require.
//
//   node dsh-go-ble/tooling/check-native-files.mjs
//
// Exit code 0 = every check passed; 1 = at least one failure (listed).

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const FILES = join(REPO, 'files')
const KOTLIN = 'app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app'

const failures = []
const notes = []

function fail(message) {
  failures.push(message)
}

function check(condition, message) {
  if (!condition) fail(message)
}

async function readText(path) {
  const bytes = await readFile(path)
  return { bytes, text: bytes.toString('utf8') }
}

/** Kotlin delimiters outside strings/comments; raw strings, escapes and nested block comments skip. */
function delimiterProblems(source) {
  const problems = []
  const stack = []
  const pairs = { ')': '(', ']': '[', '}': '{' }
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      index = end < 0 ? source.length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      let depth = 1
      index += 2
      while (index < source.length && depth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') { depth++; index += 2; continue }
        if (source[index] === '*' && source[index + 1] === '/') { depth--; index += 2; continue }
        index++
      }
      continue
    }
    if (char === '"' && next === '"' && source[index + 2] === '"') {
      const end = source.indexOf('"""', index + 3)
      if (end < 0) { problems.push('unterminated raw string'); break }
      index = end + 3
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      index++
      let closed = false
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue }
        if (source[index] === quote) { closed = true; index++; break }
        if (source[index] === '\n' && quote === '"') break
        index++
      }
      if (!closed) problems.push('unterminated string or char literal')
      continue
    }
    if (char === '(' || char === '[' || char === '{') stack.push({ char, index })
    if (char === ')' || char === ']' || char === '}') {
      const open = stack.pop()
      if (!open || open.char !== pairs[char]) {
        problems.push(`unbalanced '${char}' at offset ${index}`)
        break
      }
    }
    index++
  }
  if (stack.length > 0) problems.push(`unclosed '${stack[stack.length - 1].char}' at offset ${stack[stack.length - 1].index}`)
  return problems
}

async function checkKotlin(relativePath) {
  const path = join(FILES, relativePath)
  let file
  try {
    file = await readText(path)
  } catch {
    return fail(`missing file: files/${relativePath}`)
  }
  const { bytes, text } = file
  const name = relativePath.split('/').pop()
  check(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${name}: UTF-8 BOM`)
  check(!text.includes('\r'), `${name}: CRLF line ending`)
  check(text.endsWith('\n'), `${name}: missing trailing newline`)
  check(!text.includes('\t'), `${name}: tab indentation`)
  for (const problem of delimiterProblems(text)) fail(`${name}: ${problem}`)
  const packageName = text.match(/^package ([^\n]+)$/m)?.[1]
  const expectedDir = relativePath.replace(/^.*dsh_app\//, '').split('/').slice(0, -1).join('.')
  const expectedPackage = expectedDir ? `io.github.ccch1mneyyy.dsh_app.${expectedDir}` : 'io.github.ccch1mneyyy.dsh_app'
  check(packageName === expectedPackage,
    `${name}: package '${packageName}' does not match directory '${expectedDir || '<root>'}'`)
  if (!text.includes('import ')) notes.push(`${name}: no imports (unusual for this tree)`)
  return { name, text }
}

const EMBODIED = [
  'EmbodiedPrefs.kt', 'EmbodiedFraming.kt', 'EmbodiedWebSocket.kt',
  'EmbodiedGateway.kt', 'EmbodiedBleService.kt', 'EmbodiedBlePlugin.kt',
]
const RUNTIME = ['EmbodiedGuest.kt', 'DshProcess.kt', 'RuntimeController.kt']

const sources = new Map()
for (const name of EMBODIED) {
  const result = await checkKotlin(`${KOTLIN}/embodied/${name}`)
  if (result) sources.set(name, result.text)
}
for (const name of RUNTIME) {
  const result = await checkKotlin(`${KOTLIN}/runtime/${name}`)
  if (result) sources.set(name, result.text)
}
const mainActivity = await checkKotlin(`${KOTLIN}/MainActivity.kt`)
if (mainActivity) sources.set('MainActivity.kt', mainActivity.text)

// §10.4 manifest
const manifestPath = join(FILES, 'app/android/app/src/main/AndroidManifest.xml')
try {
  const manifest = (await readText(manifestPath)).text
  const permission = (name) => new RegExp(`<uses-permission android:name="android.permission.${name}"`).test(manifest)
  check(permission('BLUETOOTH'), 'manifest: BLUETOOTH permission missing')
  check(permission('BLUETOOTH_ADMIN'), 'manifest: BLUETOOTH_ADMIN permission missing')
  check(permission('ACCESS_FINE_LOCATION'), 'manifest: ACCESS_FINE_LOCATION permission missing')
  check(!/android.permission.BLUETOOTH"\s+tools:node="remove"/.test(manifest), 'manifest: BLUETOOTH still removed with tools:node')
  check(/android.permission.MODIFY_AUDIO_SETTINGS"\s+tools:node="remove"/.test(manifest), 'manifest: MODIFY_AUDIO_SETTINGS remove line lost')
  check(manifest.includes('android:name=".embodied.EmbodiedBleService"'), 'manifest: EmbodiedBleService not declared')
  check(manifest.includes('android:foregroundServiceType="specialUse"'), 'manifest: specialUse FGS type missing')
  check((manifest.match(/android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE/g) ?? []).length >= 2,
    'manifest: PROPERTY_SPECIAL_USE_FGS_SUBTYPE missing for EmbodiedBleService')
  if (!manifest.includes('android:exported="false"')) fail('manifest: no non-exported service attribute found')
} catch {
  fail('missing file: files/app/android/app/src/main/AndroidManifest.xml')
}

// §10.3 channel contract and §4/§10.1 constants
const plugin = sources.get('EmbodiedBlePlugin.kt') ?? ''
check(plugin.includes('"dsh/embodied_ble"'), 'plugin: MethodChannel dsh/embodied_ble missing')
check(plugin.includes('"dsh/embodied_ble/events"'), 'plugin: EventChannel dsh/embodied_ble/events missing')
for (const method of ['status', 'start', 'stop', 'scan', 'connect', 'disconnect', 'config', 'configure', 'openSystemBluetooth']) {
  check(plugin.includes(`"${method}"`), `plugin: method ${method} missing`)
}
check(plugin.includes('ACCESS_FINE_LOCATION'), 'plugin: location permission request missing')

const framing = sources.get('EmbodiedFraming.kt') ?? ''
check(framing.includes('MAGIC = 0xA5'), 'framing: magic 0xA5 missing')
check(framing.includes('MAX_TEXT_BYTES = 4096'), 'framing: text cap 4096 missing')
check(framing.includes('MAX_BINARY_BYTES = 16384'), 'framing: binary cap 16384 missing')
check(framing.includes('MAX_FRAGMENTS = 255'), 'framing: frag_total cap 255 missing')
check(framing.includes('TIMEOUT_MS = 3_000L'), 'framing: 3 s reassembly timeout missing')

const gateway = sources.get('EmbodiedGateway.kt') ?? ''
check(gateway.includes('6a696e67-6a69-6e67-8000-000000000001'), 'gateway: service UUID missing')
check(gateway.includes('6a696e67-6a69-6e67-8000-000000000002'), 'gateway: DOWN UUID missing')
check(gateway.includes('6a696e67-6a69-6e67-8000-000000000003'), 'gateway: UP UUID missing')
check(gateway.includes('00002902-0000-1000-8000-00805f9b34fb'), 'gateway: CCCD UUID missing')
check(gateway.includes('REQUESTED_MTU = 247'), 'gateway: requestMtu(247) missing')
check(gateway.includes('longArrayOf(1_000L, 2_000L, 5_000L, 10_000L)'), 'gateway: 1/2/5/10 s backoff missing')
check(gateway.includes('"txBytes"') && gateway.includes('"rxDrop"'), 'gateway: status counters missing')

const prefs = sources.get('EmbodiedPrefs.kt') ?? ''
check(prefs.includes('DEFAULT_BRIDGE_URL = "ws://127.0.0.1:7788/device"'), 'prefs: default bridge URL missing')
check(prefs.includes('getBoolean(KEY_ENABLED, false)'), 'prefs: enabled must default to false')
for (const key of ['bridgeUrl', 'token', 'autoConnect', 'devicePrefix', 'lastAddress', 'enabled']) {
  check(new RegExp(`"${key}"`).test(prefs) || prefs.includes(`KEY_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`),
    `prefs: ${key} not stored`)
}

const guest = sources.get('EmbodiedGuest.kt') ?? ''
check(guest.includes('/opt/dsh-app/embodied'), 'guest: guest dir missing')
check(guest.includes('flutter_assets/assets/engine/embodied'), 'guest: asset dir missing')
check(guest.includes('dsh-embodied-bridge'), 'guest: patch entry id missing')
check(guest.includes('wsToken:'), 'guest: wsToken key missing')
check(guest.includes('discover: false'), 'guest: discover:false missing')
check(guest.includes('imageKeep: 5') && guest.includes('voiceKeep: 20'), 'guest: imageKeep/voiceKeep missing')

const dshProcess = sources.get('DshProcess.kt') ?? ''
check(dshProcess.includes('embodiedOverlay'), 'DshProcess: embodiedOverlay parameter missing')
check(dshProcess.includes('EmbodiedGuest.launchArg'), 'DshProcess: EmbodiedGuest.launchArg missing')

const controller = sources.get('RuntimeController.kt') ?? ''
check(controller.includes('EmbodiedGuest.writeFiles'), 'RuntimeController: guest not written')
check(controller.includes('EmbodiedBleService.syncEngine'), 'RuntimeController: service not synced with engine phase')

const activity = sources.get('MainActivity.kt') ?? ''
check(activity.includes('EmbodiedBlePlugin()'), 'MainActivity: plugin not registered')

// Expected file inventory
const expected = [
  `${KOTLIN}/embodied/EmbodiedPrefs.kt`,
  `${KOTLIN}/embodied/EmbodiedFraming.kt`,
  `${KOTLIN}/embodied/EmbodiedWebSocket.kt`,
  `${KOTLIN}/embodied/EmbodiedGateway.kt`,
  `${KOTLIN}/embodied/EmbodiedBleService.kt`,
  `${KOTLIN}/embodied/EmbodiedBlePlugin.kt`,
  `${KOTLIN}/embodied/README.md`,
  `${KOTLIN}/runtime/EmbodiedGuest.kt`,
  `${KOTLIN}/runtime/DshProcess.kt`,
  `${KOTLIN}/runtime/RuntimeController.kt`,
  `${KOTLIN}/MainActivity.kt`,
  'app/android/app/src/main/AndroidManifest.xml',
]

const present = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else present.push(path.slice(FILES.length + 1).split('\\').join('/'))
  }
}
await walk(FILES)
for (const path of expected) check(present.includes(path), `missing file: files/${path}`)
for (const path of present) {
  if (expected.includes(path)) continue
  // Other tasks share files/: T4 owns app/lib|test|pubspec, the Lead generates app/assets.
  if (path.startsWith('app/lib/') || path.startsWith('app/test/') || path === 'app/pubspec.yaml' || path.startsWith('app/assets/')) {
    notes.push(`other task's file (not checked here): files/${path}`)
  } else {
    notes.push(`unexpected file under files/: ${path}`)
  }
}

// Report
for (const note of notes) console.log(`note: ${note}`)
if (failures.length === 0) {
  console.log(`OK: ${present.length} file(s) under files/, all native checks passed`)
  process.exit(0)
}
for (const failure of failures) console.error(`FAIL: ${failure}`)
console.error(`${failures.length} check(s) failed`)
process.exit(1)
