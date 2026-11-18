#!/usr/bin/env node
// 生成 dsh-go-ble/files-manifest.json：覆盖集里每个文件是「新增」还是「替换」，
// 替换的记下上游原始 sha256（应用前用它做漂移检查：目标文件必须与上游一致，或已是本补丁）。
//
// 用法：node dsh-go-ble/tooling/make-manifest.mjs [--upstream <dsh-go 源码根>]
// 默认上游：本工作区 reference/dsh-go-main（只读解压件）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OVERLAY = path.join(ROOT, 'dsh-go-ble', 'files')
const argUp = process.argv.indexOf('--upstream')
const UPSTREAM = argUp > 0 ? path.resolve(process.argv[argUp + 1]) : path.join(ROOT, 'reference', 'dsh-go-main')
const OUT = path.join(ROOT, 'dsh-go-ble', 'files-manifest.json')

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

function walk(dir, rel = '') {
  const out = []
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name)
    const r = rel ? path.posix.join(rel, name) : name
    if (fs.statSync(p).isDirectory()) out.push(...walk(p, r))
    else out.push(r)
  }
  return out
}

if (!fs.existsSync(OVERLAY)) {
  console.error(`覆盖集目录不存在：${OVERLAY}`)
  process.exit(1)
}
if (!fs.existsSync(UPSTREAM)) {
  console.error(`上游源码不存在：${UPSTREAM}（用 --upstream 指定 dsh-go 源码根）`)
  process.exit(1)
}

const entries = []
for (const rel of walk(OVERLAY)) {
  const overlayPath = path.join(OVERLAY, rel)
  const upPath = path.join(UPSTREAM, rel)
  const overlaySha = sha256(overlayPath)
  if (fs.existsSync(upPath)) {
    entries.push({ path: rel, kind: 'replaced', upstreamSha256: sha256(upPath), overlaySha256: overlaySha })
  } else {
    entries.push({ path: rel, kind: 'added', overlaySha256: overlaySha })
  }
}

const manifest = {
  format: 'dsh-go-ble-overlay/v1',
  upstream: { version: '1.0.16', source: 'dsh-Go-main.zip', sha256OfZip: '2628ddd96966d7e157a7a285520d641b661a4ca8cfc6127b453ccfd7776555be' },
  counts: {
    total: entries.length,
    added: entries.filter((e) => e.kind === 'added').length,
    replaced: entries.filter((e) => e.kind === 'replaced').length,
  },
  entries,
}
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1) + '\n')
console.log(`已生成 ${OUT}：共 ${entries.length} 个文件（新增 ${manifest.counts.added} / 替换 ${manifest.counts.replaced}）`)
for (const e of entries) console.log(`  ${e.kind === 'added' ? 'A' : 'M'}  ${e.path}`)
