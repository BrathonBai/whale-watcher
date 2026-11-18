// adpcm.h —— IMA/DVI ADPCM 编/解码（BLE 链路的上下行音频编码）。
//
// 契约来源（唯一事实源）：docs/协议-v2-契约.md §6 +
// bridge/lib/adpcm.js（参考实现，已用 ffmpeg 的 adpcm_ima_wav 交叉验证）。
//
// 块格式（与 ffmpeg 的 adpcm_ima_wav 同构）：
//   block = 1024 字节 = 4 字节头 + 1020 字节 nibbles
//   头：[0..1] predictor int16 LE = **本块第一个 PCM 采样**
//       [2]    index  u8          = 本块起点 step index（跨块延续）
//       [3]    reserved = 0
//   nibbles：每个字节 2 个采样，**低半字节在前**
//   整块 = 1 + 1020×2 = 2041 采样（85.04 ms @24 kHz）
//   末块允许短：4 B 头 + ceil((n-1)/2) B nibbles，n 必须奇数；
//   n 为偶数时编码器补 1 个采样（编码成 n+1 个采样），解码端用头里的 `samples`
//   字段裁掉那 1 个采样（voice/audio 头都带 samples）。
//
// 设计取向：
//   - 不依赖任何 esp_* 头文件（可被主机单测 / 未来 host 测试复用）；
//   - 块头自带状态 → BLE 丢一包只坏这一块（85 ms），下一块立即自愈；
//   - 编解码逐样本/逐字节与 bridge/lib/adpcm.js 一致（>adpcm 自检用共享向量验证）。
#pragma once

#include <cstddef>
#include <cstdint>

namespace adpcm {

// 线上常量（与 bridge/lib/adpcm.js 的 ADPCM 对象一致）。
constexpr int kRate = 24000;
constexpr int kBlockBytes = 1024;   // 整块字节数
constexpr int kHeaderBytes = 4;
constexpr int kNibbleSamples = (kBlockBytes - kHeaderBytes) * 2;  // 2040
constexpr int kSamplesPerBlock = kNibbleSamples + 1;              // 2041（含块头采样）
// 实测码率：1024 B / 2041 采样 × 24000 ≈ 12041.6 B/s（桥侧同值）。
constexpr int kBytesPerSecond = (kBlockBytes * kRate) / kSamplesPerBlock;  // 12041
constexpr int kVoiceMaxBytes = 240000;  // 桥侧协议上限（20 s）

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------
// 编码器状态：只有 index 跨块延续；predictor 每块被"本块第一个采样"覆盖。
struct Encoder {
    int16_t predictor = 0;
    uint8_t index = 0;
};

// 编码一个块。
//   pcm   : 至少 count 个采样可读（count 为偶数时内部会多读 1 个采样用于补齐，
//           读越界位置按 0 处理 —— 与 JS 的 `?? 0` 一致，调用方最好保证可读）。
//   count : 1..kSamplesPerBlock。
//   out/cap: 输出缓冲，需要 4 + count/2 字节。
// 返回写入字节数（4 + count/2）；0 = 参数非法或 cap 不够。
size_t EncodeBlock(Encoder* st, const int16_t* pcm, int count, uint8_t* out, size_t cap);

// 整段 PCM → ADPCM 块流（块边界 = kSamplesPerBlock，末块短块）。
// 返回写入字节数；0 = 参数非法或 cap 不够。
size_t EncodePcm(const int16_t* pcm, int samples, uint8_t* out, size_t cap);

// 预估 samples 个 PCM 采样编码后的字节数（上限，用于申请缓冲/协议 bytes 字段）。
size_t EncodedSizeForSamples(int samples);

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------
// 解码一个块。len = 4..1024（末块可短）；输出采样数 = (len-4)*2+1。
// 返回输出采样数；0 = 参数非法（len<4 / cap 不够 / len>1024）。
int DecodeBlock(const uint8_t* in, size_t len, int16_t* out, int cap);

// 解码多块（整块 1024B 步进；最后不足 1024B 的块按短块解）。
//   consumed: 可选，返回实际消费的字节数（尾部不足 4B 的残余不消费）。
// 返回总采样数；0 = 没有可解的块。
int DecodeBlocks(const uint8_t* in, size_t len, int16_t* out, int cap, size_t* consumed);

// ---------------------------------------------------------------------------
// 自检（串口 `>adpcm`）：用桥侧共享向量逐条比对。
//   decode[i]：ffmpeg 编码的块 → 期望 PCM（逐采样，要求 maxDiff == 0）
//   encode[i]：PCM → 期望 ADPCM（逐字节一致）
// report 里写每条 PASS/FAIL 与最大采样差；全过返回 true。
// ---------------------------------------------------------------------------
bool SelfTest(char* report, size_t cap);

}  // namespace adpcm
