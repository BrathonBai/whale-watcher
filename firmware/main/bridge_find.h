// bridge_find.h —— 换网络后自己找到桥。
//
// 问题：桥跑在 PC 上，PC 的 IP 是 DHCP 的（家里 192.168.0.17、外面 172.16.1.222……）。
// 设备里的 URL 是编译期写死的，一换网就连不上，只能重刷固件。
//
// 做法：往 255.255.255.255:7789 发一条 {"t":"who"}，桥用**收到包的源地址**回话；
// 源地址就是设备该连的那个 IP。零配置、无依赖，比 mDNS 少一层解析。
#pragma once

#include <cstddef>

namespace bridge_find {

// 广播找桥。成功返回 true 并写出 host / port。
bool Find(char* host, size_t host_cap, int* port, int timeout_ms = 1500);

}  // namespace bridge_find
