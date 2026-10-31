// v2 音频：全部走 BSP（ES8311 放音 + ES7243E 录音），不自写 I2S/codec
#pragma once
#include <cstdint>
namespace audio {
bool Init();                                   // codec + 采样率
int  Record(int16_t* buf, int samples);        // 返回实际采样数
int  Play(const int16_t* buf, int samples);    // 返回实际写出采样数
void Volume(int percent);

// 流式播放（学小智）：WS 任务只把 PCM 推进环形缓冲，独立任务喂 I2S。
// 关键：WS 任务绝不能被播放阻塞，否则停止收包 → 缓冲溢出 → 断连丢音频。
void StreamInit();
int  StreamWrite(const int16_t* buf, int samples);   // 返回实际入队采样数
void StreamFlush();                                  // 等缓冲播完
int  StreamBuffered();                               // 当前积压采样数
}