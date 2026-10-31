// 板级最小 bring-up：IO 扩展器供电 → 背光 → QSPI 面板 → 画一张标定图
// 引脚与初始化顺序全部对照 Seeed 官方 BSP（components/sensecap-watcher），不猜。
#pragma once

#include <cstdint>

#include "esp_err.h"
#include "esp_lcd_types.h"

namespace watcher {

// IO 扩展器（PCA9535 @0x21，I2C0 SDA47/SCL48）
constexpr int kI2cPort = 0;
constexpr int kI2cSda = 47;
constexpr int kI2cScl = 48;
constexpr uint8_t kIoExpAddr = 0x21;

// 扩展器位（P1.x 对应 bit8+x）
constexpr uint32_t PWR_SDCARD  = 1u << 8;
constexpr uint32_t PWR_LCD     = 1u << 9;
constexpr uint32_t PWR_SYSTEM  = 1u << 10;
constexpr uint32_t PWR_AI_CHIP = 1u << 11;
constexpr uint32_t PWR_CODEC_PA= 1u << 12;
constexpr uint32_t PWR_BAT_DET = 1u << 13;
constexpr uint32_t PWR_GROVE   = 1u << 14;
constexpr uint32_t PWR_BAT_ADC = 1u << 15;

constexpr int kLcdWidth = 412;
constexpr int kLcdHeight = 412;

esp_err_t BoardInit();                 // I2C + 扩展器 + 供电
esp_err_t BacklightInit();             // LEDC on GPIO8
esp_err_t BacklightSet(int percent);
esp_err_t LcdInit(esp_lcd_panel_handle_t* out_panel);

// 画一条带并**等这次传输真正完成**再返回。
// 不等的话，下一条会覆盖正在被 DMA 读取的缓冲，屏幕上就是撕裂的色块。
// 麦克风：I2S0 RX + ES7243E(0x14)，24kHz/16bit/单声道
esp_err_t MicInit();
// 读 n 个样本（16bit 单声道）；返回实际读到的样本数
int MicRead(int16_t* buf, int n);

// 喇叭：I2S0 TX + ES8311(0x18)，24kHz/16bit/单声道（TTS 播放）
// 与麦克风共用一条 I2S0（全双工），第一次调用会一并把两个通道建好。
esp_err_t SpkInit();
// 写 PCM；返回写入字节数，0 = 失败/未初始化
int SpkWrite(const void* pcm, size_t bytes);

esp_err_t LcdDrawBand(esp_lcd_panel_handle_t panel, int x0, int y0, int x1, int y1, const void* data);

// 顶部那颗 RGB 灯（BSP_RGB_CTRL = GPIO40，单颗 WS2812，RMT 驱动）。
// 用途：录音状态必须"看不见屏也知道"——录音中是蓝色呼吸，空闲灭。
esp_err_t LedInit();
void LedSet(uint8_t r, uint8_t g, uint8_t b);   // 立即生效；未初始化时静默忽略

// 读 IO 扩展器输入口（P0 = 按键/旋钮，P1 = 电源状态）。
// 返回 -1 表示 I2C 读失败。位定义见上（PWR_*）；P0.3 = 旋钮按键（低有效）。
int ExpReadPort0();
int ExpReadPort1();

// 诊断：扫 I2C0(47/48) 与 I2C1(39/38) 并打印应答地址。
// **只在控制台里手动调用**；启动路径上跑会破坏已有设备句柄（见 .cc 里的注释）。
void BoardScanI2C();

// 诊断：绕过 codec 层直读 I2S（单/双声道各 0.5s），打印 RMS/峰值/非零样本。
// 只在控制台 >mic 时调用（会重配 I2S，别和播放/录音任务并发）。
void MicProbe();

// 音量（0..100）：滚轮转动调它。返回实际生效值。
int SetVolume(int percent);
int GetVolume();

// 关机：厂商 SDK 的做法是切断 BSP_PWR_SYSTEM（硬断电），
// 这里用**深度睡眠**代替——可被滚轮按键或定时器唤醒，不会变砖。
void Shutdown();

// 清空 WiFi 配网并重启（换网络时用；8 秒长按触发）
void ClearWifiAndReboot();

// 诊断：盯着 P0/P1 原始读数，任何变化都打印（含 bit 图）。
// 用 >keys 触发，用户在此期间按滚轮，就能看出按键到底在哪个 bit、极性如何。
void KeyProbe(int seconds);
void ExpProbe();   // 扩展器寄存器自检 + 回写验证 + 连读 P0

// 旋钮编码器（厂商 SDK：BSP_KNOB_A=GPIO41 / B=GPIO42）。
// 这台机器上"按下"那一位（P0.3）读不到，但**转动**是真实可用的物理输入，
// 所以用它做"开始说话"的手势。
esp_err_t KnobInit();

// TF 卡（SDSPI，SPI2：CLK=4 MOSI=5 MISO=6 CS=46），挂到 /sdcard。
// 上电由 BoardInit 的 PWR_SDCARD 位负责；这里只做总线初始化 + FATFS 挂载。
esp_err_t SdInit();
void SdProbeNow();   // 串口 >sdprobe：原始 CMD0/CMD8 探测
bool SdReady();
// 返回自上次调用以来的净转动步数（正=顺时针，负=逆时针）
int KnobDelta();

// P0.3：旋钮按下（低有效）—— 本机实测读不到（恒为 1），保留定义供其它批次使用
constexpr uint8_t kKeyMaskP0 = 1u << 3;

}  // namespace watcher
