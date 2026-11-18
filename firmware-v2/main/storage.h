// storage.h —— TF 卡挂载（/sdcard）。
//
// v2 之前没有挂卡：board_watcher.h 里声明了 SdInit()，但既没实现也没人调用，
// 于是 clip_player 读 /sdcard/anim/*.bin 永远失败，只有固件内嵌的 3 段动画能播。
// 这里把 v1（firmware/device/main/board_watcher.cc:772）踩过的两个坑带上：
//   1. 先给卡做一次真正的上电复位（PCA9535 在 ESP 复位后保留输出）；
//   2. 只挂一次，失败不重试（每次失败都会留下 FATFS 结构，吃内部堆）。
#pragma once

#include "esp_err.h"

namespace storage {

// 上电复位 + 挂载 /sdcard；只尝试一次。成功返回 ESP_OK。
esp_err_t Init();

// 卡是否已经挂上；后续所有文件操作前先问一句。
bool Ready();

}  // namespace storage
