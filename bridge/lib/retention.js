// retention.js —— 落盘文件的保留策略（按数量，不按时间）。
//
// 为什么按数量：设备拍照是"按需"的，频率完全不可预测；按天/按小时算很容易
// 在演示当天把内存撑爆，或者把昨天的证据整批删掉。留最近 N 个最省心：
//   · 模型真正用到的只有"最新一张"（见 index.js 的 lastImagePath）；
//   · 面板只预览最新一张；
//   · 留 20 张足够翻看当天发生了什么。
//
// 只删普通文件，不递归、不碰目录；删除失败不影响调用方（记录在返回值里）。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 保留 dir 下最近 keep 个（按 mtime 倒序），其余删除。
 * @param {string} dir
 * @param {number} keep 保留个数；<=0 表示全部删除
 * @param {(name:string)=>boolean} [match] 只处理满足条件的文件名
 * @returns {{kept:number, removed:number, failed:number, bytesFreed:number}}
 */
export function pruneDir(dir, keep, match = () => true) {
  const n = Math.max(0, Number(keep) || 0)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { kept: 0, removed: 0, failed: 0, bytesFreed: 0 }
  }
  const items = []
  for (const name of names) {
    if (!match(name)) continue
    const p = path.join(dir, name)
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) continue
      items.push({ p, name, mtime: st.mtimeMs, size: st.size })
    } catch {
      /* 单个文件读不到就跳过，不影响整批 */
    }
  }
  items.sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  let failed = 0
  let bytesFreed = 0
  for (const it of items.slice(n)) {
    try {
      fs.unlinkSync(it.p)
      removed++
      bytesFreed += it.size
    } catch {
      failed++
    }
  }
  return { kept: items.length - removed, removed, failed, bytesFreed }
}

/** 统计一个目录里的文件数与总字节（/health 展示用）。 */
export function dirStats(dir, match = () => true) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { files: 0, bytes: 0 }
  }
  let files = 0
  let bytes = 0
  for (const name of names) {
    if (!match(name)) continue
    try {
      const st = fs.statSync(path.join(dir, name))
      if (st.isFile()) {
        files++
        bytes += st.size
      }
    } catch {}
  }
  return { files, bytes }
}
