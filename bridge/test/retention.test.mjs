// retention 单测：保留策略必须"只删旧的、不动新的、别误删别的文件"。
//
// 跑：node test/retention.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dirStats, pruneDir } from '../lib/retention.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'))
const touch = (dir, name, ageMs, size = 10) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, Buffer.alloc(size, 1))
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(p, t, t)
  return p
}

test('只保留最近 N 个，旧的删掉', () => {
  const d = tmp()
  touch(d, 'a.jpg', 5000)
  touch(d, 'b.jpg', 4000)
  touch(d, 'c.jpg', 3000)
  touch(d, 'd.jpg', 2000)
  touch(d, 'e.jpg', 1000)
  const r = pruneDir(d, 2, (n) => n.endsWith('.jpg'))
  assert.equal(r.kept, 2)
  assert.equal(r.removed, 3)
  assert.deepEqual(fs.readdirSync(d).sort(), ['d.jpg', 'e.jpg'], '应保留最新两个')
})

test('不碰非目标文件（比如 .txt、.wav）', () => {
  const d = tmp()
  touch(d, 'old.jpg', 9000)
  touch(d, 'new.jpg', 1000)
  touch(d, 'keep.txt', 9000)
  const r = pruneDir(d, 1, (n) => n.endsWith('.jpg'))
  assert.equal(r.removed, 1)
  assert.deepEqual(fs.readdirSync(d).sort(), ['keep.txt', 'new.jpg'])
})

test('keep=0 全删；目录不存在不报错', () => {
  const d = tmp()
  touch(d, 'x.jpg', 1000)
  const r = pruneDir(d, 0, (n) => n.endsWith('.jpg'))
  assert.equal(r.removed, 1)
  assert.deepEqual(fs.readdirSync(d), [])
  const missing = pruneDir(path.join(d, 'nope'), 5, () => true)
  assert.equal(missing.removed, 0)
  assert.equal(missing.kept, 0)
})

test('文件数少于上限时什么都不删', () => {
  const d = tmp()
  touch(d, 'a.jpg', 1000)
  const r = pruneDir(d, 20, (n) => n.endsWith('.jpg'))
  assert.equal(r.removed, 0)
  assert.equal(r.kept, 1)
})

test('dirStats 只统计匹配的文件与字节', () => {
  const d = tmp()
  touch(d, 'a.jpg', 1000, 100)
  touch(d, 'b.jpg', 1000, 50)
  touch(d, 'c.wav', 1000, 999)
  assert.deepEqual(dirStats(d, (n) => n.endsWith('.jpg')), { files: 2, bytes: 150 })
  assert.deepEqual(dirStats(path.join(d, 'nope')), { files: 0, bytes: 0 })
})
