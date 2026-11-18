#!/usr/bin/env node
// 把 bridge/ 里的 DSH 插件（dsh-embodied-bridge）同步成 dsh-go 的 Flutter assets。
//
// 为什么：手机端不改 dsh-Go 运行时，而是用「guest 插件注入」——App 每次启动引擎前把
// assets 里的插件文件递归拷到 PRoot 的 /opt/dsh-app/embodied/，再用 --patch 让 DSH 按
// 绝对路径加载（见 runtime/EmbodiedGuest.kt）。
//
// 用法：
//   node dsh-go-ble/tooling/sync-embodied-assets.mjs          # 生成/更新
//   node dsh-go-ble/tooling/sync-embodied-assets.mjs --check  # 只校验是否一致（CI/应用前）
//
// 只拷运行期需要的：package.json（必须带 "type":"module"）+ lib/**.js + lib/panel.html。
// 不拷 test/、tools/、README、cordis.patch.yml（手机端的 patch 由 Kotlin 动态生成，带 token）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..') // 工作区根
const SRC = path.join(ROOT, 'bridge')
const DST = path.join(ROOT, 'dsh-go-ble', 'files', 'app', 'assets', 'engine', 'embodied')
const CHECK = process.argv.includes('--check')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 要拷的文件（相对 bridge/）。目录里的每个 .js 单独列，避免漏掉新模块。 */
function collect() {
  const out = ['package.json']
  const lib = path.join(SRC, 'lib')
  for (const name of fs.readdirSync(lib).sort()) {
    const p = path.join(lib, name)
    if (!fs.statSync(p).isFile()) continue
    if (name.endsWith('.js') || name.endsWith('.html')) out.push(path.posix.join('lib', name))
  }
  return out
}

/** 校验 package.json 能被 DSH 按 ESM 加载（type=module + main 指向 lib/index.js）。 */
function checkPackage() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'))
  if (pkg.type !== 'module') throw new Error('bridge/package.json 缺少 "type":"module"（DSH 会按 CJS 解析 .js 而失败）')
  if (pkg.main !== 'lib/index.js') throw new Error(`bridge/package.json main=${pkg.main}，期望 lib/index.js`)
  return pkg
}

function main() {
  const pkg = checkPackage()
  const files = collect()
  const plan = files.map((rel) => {
    const src = path.join(SRC, rel)
    const bytes = fs.readFileSync(src)
    return { rel, bytes, sha: sha256(bytes) }
  })

  let stale = 0
  let missing = 0
  for (const item of plan) {
    const dst = path.join(DST, item.rel)
    if (!fs.existsSync(dst)) {
      missing++
      continue
    }
    if (sha256(fs.readFileSync(dst)) !== item.sha) stale++
  }
  // 目标里多出来的旧文件也要报（插件删了模块后不能留死文件）；清单文件自身除外。
  const extra = []
  const MANIFEST = 'ASSETS-MANIFEST.json'
  const walk = (dir, rel = '') => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const r = rel ? path.posix.join(rel, name) : name
      if (fs.statSync(p).isDirectory()) walk(p, r)
      else if (!files.includes(r) && r !== MANIFEST) extra.push(r)
    }
  }
  walk(DST)

  if (CHECK) {
    console.log(`源：${SRC}`)
    console.log(`目标：${DST}`)
    console.log(`文件 ${plan.length} 个；缺失 ${missing}，内容不一致 ${stale}，多余 ${extra.length}`)
    for (const e of extra) console.log(`  多余：${e}`)
    if (missing || stale || extra.length) {
      console.error('不一致：请运行 node dsh-go-ble/tooling/sync-embodied-assets.mjs')
      process.exit(1)
    }
    console.log('一致 ✅')
    return
  }

  fs.mkdirSync(path.join(DST, 'lib'), { recursive: true })
  for (const item of plan) {
    const dst = path.join(DST, item.rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, item.bytes)
  }
  for (const e of extra) fs.rmSync(path.join(DST, e), { force: true })
  // 写一份清单，方便 review/apply 时核对（不含时间戳，保证可复现）
  const manifest = {
    format: 'embodied-plugin-assets/v1',
    source: 'bridge/',
    package: { name: pkg.name, version: pkg.version },
    files: plan.map((p) => ({ path: p.rel, bytes: p.bytes.length, sha256: p.sha })),
  }
  fs.writeFileSync(path.join(DST, 'ASSETS-MANIFEST.json'), JSON.stringify(manifest, null, 1) + '\n')
  console.log(`已同步 ${plan.length} 个文件 → ${DST}`)
  for (const p of plan) console.log(`  ${String(p.bytes.length).padStart(7)} B  ${p.rel}`)
}

main()
