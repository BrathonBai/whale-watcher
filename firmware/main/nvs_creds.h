// nvs_creds.h —— 从 nvs 分区里**只读**地把 WiFi 凭据捞回来。
//
// 为什么不用 nvs_open：这台设备的 NVS 已经满了（nvs_flash/nvs_open 返回
// ESP_ERR_NVS_NO_FREE_PAGES 0x1101），而 esp_wifi_init(nvs_enable=1) 会因为这个
// 直接 abort —— 我们第一次刷 v0.6 就是死在这里，然后被 bootloader 判为
// "app 起不来"、把 otadata 标成 INVALID 退回 ota_0。
//
// 所以：WiFi 驱动完全不用 NVS（nvs_enable=0），凭据由本模块按 NVS 的**磁盘格式**
// 直接扫分区读出来。只读，不写，不会把设备上仅存的那份配置搞坏。
//
// NVS 页面格式（与 IDF v5.5 components/nvs_flash 对得上，已用 backup/nvs_orig.bin 实测）：
//   偏移 0   : uint32 page_state   (0xfffffffc=FULL / 0xfffffffe=ACTIVE / 0xffffffff=空)
//   偏移 32  : uint8[32] entry_state_bitmap
//   偏移 64  : 条目，每个 32 字节
//              条目 = uint8 ns | uint8 type | uint8 span | uint8 chunk | uint32 crc |
//                     char key[16] | uint8 data[8]
//              span>1 的 blob：本条给 8 字节，后面 (span-1) 条整条 32 字节都是数据。
#pragma once

#include <cstddef>

namespace nvs_creds {

// 读出 nvs.net80211 里的 sta.ssid / sta.pswd（也就是小智当年存的那份）。
// 返回 true 表示两个都拿到了。凭据只放在调用方栈上，不落日志。
bool ReadStaCreds(char* ssid, size_t ssid_cap, char* pass, size_t pass_cap);

}  // namespace nvs_creds
