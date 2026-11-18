// audio_dec.h —— 下行 Opus 裸包解码（设备侧，基于 vendored micro-opus / libopus）。
//
// 线协议（跨线已定，改动要同步 docs/协议-v2-契约.md）：
//   audio 头 codec="opus" 时，**每个 WS 二进制帧 = 一个裸 Opus 包**
//   （20 ms / 16 kHz 单声道，无长度前缀，1..1275 B）。
//   解码器输出 24 kHz / 16 bit / 单声道 PCM，写进 audio 模块现有的 PCM 环形缓冲。
//
// 为什么要独立解码任务：
//   WS 收包任务（优先级 6，栈 5 KB）绝不能被 20 ms 一次的解码占住 —— 它一旦慢下来，
//   内核 rx 队列就会堆包 → 桥判定拥塞 → 断连丢音频。所以收包回调只做一次 memcpy
//   入包队列（PSRAM），解码在单独的 "adec" 任务（优先级 7）里做。
//
// 线程模型：
//   PushPacket() 只在 WS 收包任务调用；解码任务只从此模块取包；
//   audio::StreamWrite() 是 PCM 环的生产者（消费者是 audio 的 "aud" 任务）。
//   除 Init() 外都可重入调用，内部用互斥锁保护包队列。
#pragma once

#include <cstddef>
#include <cstdint>

namespace audio_dec {

// 解码器输出采样率（与 ES8311 的 24 kHz 配置一致）。
constexpr int kOutRate = 24000;
// 桥侧编码采样率（hello.opusRate 上报值；解码器内部会 16k→24k 重采样）。
constexpr int kEncRate = 16000;

// 诊断计数（pong 与 audio_end 日志用；全部单调递增，进程生命周期内不归零）。
struct Stats {
    int queued = 0;         // 当前积压包数
    int dropped = 0;        // 包队列满/长度非法的丢包数（累计）
    int decode_errors = 0;  // opus_decode 返回错误次数（累计）
    int write_drops = 0;    // 解出的 PCM 被 PCM 环形缓冲丢弃的采样数（累计）
};

// 初始化：预检 PSRAM → 申请包队列/解码缓冲 → 创建 OpusDecoder → 起解码任务。
// 任意一步失败都会打 ERROR 并返回 false；调用方必须回退 PCM
// （hello 不再上报 opus 能力，桥侧就不会发 opus），不能静默假报可用。
// 可重复调用：已就绪直接返回 true；失败后再次调用会重试。
bool Init();

// WS 二进制回调调用：一帧裸 Opus 包入队。非阻塞（锁最多等 5 ms）。
// false = 当前没有接收（未就绪/队列满/长度非法），调用方无需重试，内部已计数并限频打日志。
bool PushPacket(const uint8_t* data, size_t len);

// audio_end 时调用：等包队列清空且最后一包解码完成，保证随后写入的尾静音排在
// 全部 PCM 之后。解码速度远快于实时（64 包上限 → 正常 <150 ms），可在 WS 任务里调用。
void Flush();

// 当前统计快照（一次上锁，避免多次读之间状态漂移）。
Stats GetStats();

// ---------------------------------------------------------------------------
// ADPCM 下行解码（2026-11-13 BLE 契约 §6.3）
//
// 与 Opus 不同：IMA ADPCM 块头自带状态、24 kHz 直出、无重采样，解码极便宜
// （10 s 音频 ~240 个块，<2 ms），所以**同步**在调用任务里解，不建包队列/任务。
// 但仍按块解码写 audio::StreamWrite，与 Opus 共用 PCM 环形缓冲。
//
// 用法（app_ui 的 audio 头/二进制块/audio_end 三处）：
//   AdpcmBegin(samples)  → PushAdpcm(块) × N → AdpcmFlush()
// samples = 头里声明的 PCM 采样数（<=0 = 未知，不裁剪末块补齐的 1 个采样）。
// ---------------------------------------------------------------------------
void AdpcmBegin(int samples_expected);
bool PushAdpcm(const uint8_t* data, size_t len);
void AdpcmFlush();
int AdpcmSamplesWritten();   // 本次 ADPCM 会话已写入 PCM 环的采样数（日志用）

}  // namespace audio_dec
