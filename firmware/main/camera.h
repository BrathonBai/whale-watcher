// 摄像头（Himax HX6538，SPI2）：只做"按需拍照"，不做周期采集。
//
// 为什么取消周期采样（2026-10-31 用户决定）：
//   · ESP32-S3 上跑视频流不现实，8 秒一张也只够"看个大概"，谈不上连续；
//   · 每张 JPEG 要落盘，占用空间且没人清理；
//   · 真正有用的是"需要时拍一张"（桥的 device_shot / {"t":"shot"}）。
#pragma once
#include <cstdint>
namespace camera {
bool Init();      // 初始化并打印模块信息/模型
void Shoot();     // 立即拍一张（唯一入口）
void SetImageHandler(void (*cb)(const uint8_t* jpg, int len));   // 拿到 JPEG 后回调
}
