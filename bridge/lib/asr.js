// 听觉：把设备录上来的 WAV 变成文字。
//
// 三条路，按代价从低到高：
//   1. 常驻进程（asr_server.py + sherpa-onnx）：模型只加载一次，之后每句 ~90 ms
//   2. 单次命令（asr_sherpa.py）：每次起 python + 加载模型，~2.5 s
//   3. DSH 自带的 speechToText（如果这个 profile 里装了语音包）
//
// 2026-10-30 修掉的老坑：常驻进程用 `cmd /d /s /c "<带引号的程序路径> ..."` 启动时，
// cmd 会把首引号留在参数里，报「'"C:\..\python.exe"' 不是内部或外部命令」→ 常驻永远起不来
// → 每句话都退回单次 2.5 s。现在统一走 `spawn(cmd, { shell: true })`，由 Node 自己拼
// `cmd /d /s /c "<整条命令>"`，引号就对了（实测 READY → OK\t晚上好。）。
import { spawn } from 'node:child_process'
import { exec } from 'node:child_process'
import fs from 'node:fs'

/** 从识别器输出里取干净的一行文本（去掉 OK\t、提示、空行）。 */
export function cleanAsrOutput(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const ok = [...lines].reverse().find((l) => l.startsWith('OK\t'))
  if (ok) return ok.slice(3).trim()
  const last = lines[lines.length - 1] ?? ''
  // 常见的噪声行：计时/日志
  if (/^(RTF|INFO|WARN|\[)/.test(last)) return ''
  return last.slice(0, 400)
}

export function createAsr({ cfg, log, dsh }) {
  let proc = null
  let ready = null
  let buf = ''
  let pending = null
  let lastReason = '' // 上一次 transcribe 为什么没出字（给日志与 /health 看，不再只说"没听清"）

  const speechService = () => {
    try {
      const s = dsh?.speechToText ?? dsh?.get?.('speechToText')
      return typeof s === 'function' ? s : s && typeof s.transcribe === 'function' ? s : null
    } catch {
      return null
    }
  }

  function ensureServer() {
    if (proc) return ready
    const cmd = String(cfg.get().asrServerCommand || '').trim()
    if (!cmd) return Promise.resolve(false)
    try {
      proc = spawn(cmd, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      log.warn('ASR 常驻进程起不来：', e?.message ?? e)
      proc = null
      return Promise.resolve(false)
    }
    ready = new Promise((resolve) => {
      let settled = false
      const done = (v) => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8')
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (line.trim() === 'READY') {
            log.info('ASR 常驻进程就绪（之后每句 ~90 ms）')
            done(true)
            continue
          }
          if (pending) {
            const p = pending
            pending = null
            clearTimeout(p.timer)
            if (line.startsWith('OK\t')) p.resolve(line.slice(3).trim())
            else p.reject(new Error(line.slice(0, 120) || 'asr error'))
          }
        }
      })
      proc.stderr.on('data', (d) => {
        const s = d.toString().trim()
        if (s && !/^\s*$/.test(s)) log.warn('[asr]', s.slice(0, 200))
      })
      proc.on('exit', (code) => {
        if (code !== 0) log.warn('ASR 常驻进程退出：', code)
        proc = null
        ready = null
        if (pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error('asr exited'))
          pending = null
        }
      })
      setTimeout(() => done(false), 30000)
    })
    return ready
  }

  function askServer(wavPath) {
    if (!proc) return Promise.reject(new Error('no server'))
    return new Promise((resolve, reject) => {
      pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          pending = null
          reject(new Error('asr timeout'))
        }, 12000),
      }
      try {
        proc.stdin.write(wavPath + '\n')
      } catch (e) {
        reject(e)
      }
    })
  }

  function runOnce(command, wavPath) {
    const line = command.includes('{wav}') ? command.replaceAll('{wav}', wavPath) : `${command} "${wavPath}"`
    return new Promise((resolve) => {
      exec(line, { windowsHide: true, timeout: 90000, encoding: 'utf8', maxBuffer: 4 << 20 }, (e, so) => {
        if (e) log.warn('ASR 单次命令失败：', String(e.message).slice(0, 160))
        resolve(cleanAsrOutput(so))
      })
    })
  }

  async function viaDsh(wavPath) {
    const svc = speechService()
    if (!svc) return ''
    const bytes = fs.readFileSync(wavPath)
    const tries = [
      () => svc({ path: wavPath }),
      () => svc(wavPath),
      () => svc.transcribe({ path: wavPath }),
      () => svc.transcribe(wavPath),
      () => svc({ data: bytes, mimeType: 'audio/wav' }),
    ]
    for (const t of tries) {
      try {
        const r = await t()
        const text = typeof r === 'string' ? r : r?.text ?? r?.transcript ?? ''
        if (String(text).trim()) return String(text).trim().slice(0, 400)
      } catch {
        /* 换一种调法 */
      }
    }
    return ''
  }

  /** 常驻进程预热：插件加载时就起，第一句话不吃 2.5 s。 */
  function warm() {
    if (String(cfg.get().asrServerCommand || '').trim()) void ensureServer()
  }

  return {
    warm,
    get serverReady() {
      return Boolean(proc)
    },
    /** 上一次识别没出字的原因；成功时为空串。 */
    get lastReason() {
      return lastReason
    },
    /**
     * @returns {Promise<{text:string, route:'server'|'command'|'dsh'|'none', ms:number}>}
     */
    async transcribe(wavPath) {
      const t0 = Date.now()
      const mode = String(cfg.get().asr || 'auto')
      lastReason = ''
      const reasons = []
      if (mode === 'off') {
        lastReason = 'asr=off（配置里关掉了识别）'
        return { text: '', route: 'none', ms: 0 }
      }
      const done = (text, route) => {
        if (text) lastReason = ''
        else lastReason = reasons.join('；') || '没有任何识别路径可用'
        return { text, route, ms: Date.now() - t0 }
      }

      try {
        if (!fs.existsSync(wavPath)) {
          reasons.push('WAV 文件不存在')
          return done('', 'none')
        }
      } catch {
        reasons.push('读不到 WAV')
        return done('', 'none')
      }

      // 1) 常驻
      if (mode === 'auto' || mode === 'server') {
        if (await ensureServer()) {
          try {
            const text = await askServer(wavPath)
            if (text) return done(text, 'server')
            reasons.push('常驻识别返回空')
          } catch (e) {
            reasons.push('常驻识别报错：' + (e?.message ?? e))
            log.warn('常驻 ASR 失败，回退：', e?.message ?? e)
          }
        } else {
          reasons.push('没有 asrServerCommand（常驻进程没起）')
        }
      }
      // 2) DSH 自带
      if (mode === 'auto' || mode === 'dsh') {
        const text = await viaDsh(wavPath)
        if (text) return done(text, 'dsh')
        reasons.push('DSH speechToText 不可用或返回空')
      }
      // 3) 单次命令
      const cmd = String(cfg.get().asrCommand || '').trim()
      if (cmd && (mode === 'auto' || mode === 'command')) {
        const text = await runOnce(cmd, wavPath)
        if (text) return done(text, 'command')
        reasons.push('单次命令没输出')
      } else if (mode === 'auto' || mode === 'command') {
        reasons.push('没有 asrCommand')
      }
      return done('', 'none')
    },
    dispose() {
      try {
        proc?.kill()
      } catch {}
      proc = null
      ready = null
    },
  }
}
