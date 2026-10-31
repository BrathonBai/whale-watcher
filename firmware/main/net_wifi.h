// net_wifi.h —— WiFi STA 接入，凭据三级回退。
//
// 为什么要有"三级回退"：这台 Watcher 上原本跑小智，WiFi 凭据是**它**写进
// NVS（命名空间 nvs.net80211，键 sta.ssid / sta.pswd）的。我们只覆盖 ota_1，
// 不碰 NVS，所以最省事的做法是让 ESP-IDF 的 WiFi 驱动自己把那份配置读回来。
// 读不到再退到应用命名空间 "wifi"，最后才是编译期 Kconfig。
// 好处：**源码里不存任何 WiFi 密码**，换网络也不用重新编译。
#pragma once

#include <cstdint>

namespace net {

enum class Source : uint8_t { None, DriverNvs, LocalHeader, AppNvs, Kconfig };

// 起一个任务做初始化 + 连接 + 断线重连（不阻塞调用方）。
void WifiStart();

bool WifiConnected();

// 实际使用的凭据来源（日志与 UI 用）
Source WifiSource();
const char* SourceName(Source s);
const char* WifiSsid();    // 实际连上的 SSID（未连上时为空串）
const char* WifiIp();      // 点分十进制，未拿到 IP 时为空串
int WifiRssi();            // dBm，未连上返回 0

// 把凭据写进应用 NVS（namespace wifi / ssid+pass）并重启生效。
// 优先级最高：串口配过的网络会盖过编译期的 wifi_local.h。
bool SaveCredentials(const char* ssid, const char* pass);

}  // namespace net
