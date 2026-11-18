// gen_adpcm_vectors.mjs —— 把桥侧共享测试向量转成固件可内嵌的 C 头文件。
//
// 契约来源（唯一事实源）：bridge/lib/adpcm.js + bridge/test/fixtures/adpcm-vectors.json
// 用法（仓库根目录）： node firmware-v2/tools/gen_adpcm_vectors.mjs
// 产物：firmware-v2/main/adpcm_vectors.h（只含十六进制字符串常量，自检时解析到缓冲区比对）
//
// 为什么用十六进制字符串而不是字节数组：同样的数据，字符串是 2 字符/字节，C 数组是
// "0xAB," 5 字符/字节 —— 省 ~60% 的 .rodata，而自检只在串口手工触发时解析一次。
// 桥侧重新生成向量后重跑本脚本即可；文件里有 `// 自动生成` 标记，别手改。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const vectorsPath = join(root, 'bridge', 'test', 'fixtures', 'adpcm-vectors.json')
const outPath = join(here, '..', 'main', 'adpcm_vectors.h')

const v = JSON.parse(readFileSync(vectorsPath, 'utf8'))
const { decode = [], encode = [] } = v
if (!decode.length || encode.length < 2) {
  throw new Error('fixtures 形状不符：需要 decode[>=1] + encode[>=2]')
}
if (!v.adpcm || v.adpcm.blockAlign !== 1024 || v.adpcm.samplesPerBlock !== 2041) {
  throw new Error(`fixtures.adpcm 参数不是 1024B/2041 采样：${JSON.stringify(v.adpcm)}`)
}

/** 十六进制 → C 字符串字面量（按行切，避免单行过长）。 */
function hexLiteral(hex, indent = '    ') {
  const lines = []
  for (let i = 0; i < hex.length; i += 64) lines.push(`${indent}"${hex.slice(i, i + 64)}"`)
  return lines.join('\n')
}

const parts = []
parts.push('// adpcm_vectors.h —— 自动生成，别手改（生成器：firmware-v2/tools/gen_adpcm_vectors.mjs）')
parts.push('// 来源：bridge/test/fixtures/adpcm-vectors.json（桥侧用 ffmpeg 交叉验证过）')
parts.push('// 格式：十六进制字符串；自检时解析成字节/PCM 再比对。')
parts.push('#pragma once')
parts.push('')
parts.push('namespace adpcm {')
parts.push('namespace vectors {')
parts.push('')

decode.forEach((d, i) => {
  parts.push(`// decode[${i}]：${d.source || 'fixture'}，samples=${d.samples}`)
  parts.push(`constexpr int kDecode${i}Samples = ${d.samples};`)
  parts.push(`constexpr const char* kDecode${i}AdpcmHex =`)
  parts.push(hexLiteral(d.adpcmHex) + ';')
  parts.push(`constexpr const char* kDecode${i}PcmHex =`)
  parts.push(hexLiteral(d.pcmHex) + ';')
  parts.push('')
})

encode.forEach((e, i) => {
  parts.push(`// encode[${i}]：samples=${e.samples}（PCM → 期望 ADPCM 字节）`)
  parts.push(`constexpr int kEncode${i}Samples = ${e.samples};`)
  parts.push(`constexpr const char* kEncode${i}PcmHex =`)
  parts.push(hexLiteral(e.pcmHex) + ';')
  parts.push(`constexpr const char* kEncode${i}AdpcmHex =`)
  parts.push(hexLiteral(e.adpcmHex) + ';')
  parts.push('')
})

parts.push(`constexpr int kDecodeCount = ${decode.length};`)
parts.push(`constexpr int kEncodeCount = ${encode.length};`)
parts.push('')
parts.push('}  // namespace vectors')
parts.push('}  // namespace adpcm')
parts.push('')

writeFileSync(outPath, parts.join('\n'))
console.log(`写入 ${outPath}`)
for (const [i, d] of decode.entries()) console.log(`  decode[${i}] adpcm=${d.adpcmHex.length / 2}B pcm=${d.pcmHex.length / 2}B samples=${d.samples}`)
for (const [i, e] of encode.entries()) console.log(`  encode[${i}] pcm=${e.pcmHex.length / 2}B adpcm=${e.adpcmHex.length / 2}B samples=${e.samples}`)
