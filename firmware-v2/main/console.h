// console.h —— 极简串口行命令（不引 esp_console：省内部 RAM，命令只有几条）。
//
// 契约：docs/协议-v2-契约.md §12.3（设备侧真机验收用）。
// 命令（都以 '>' 开头，回车执行）：
//   >help                 列出命令
//   >link                 模式 / 两条链路状态 / MTU / RSSI / 计数 / 桥地址
//   >link                 一行链路摘要（active/bleConn/mtu/rssi/reconnects + 名称/uplink）
//   >link reconnect       主动断开当前 BLE 连接（设备随后恢复广播；hello 会重发）
//   >stat                 一行链路摘要（transport/uplink/mtu/rssi/txDrop/rxDrop）+ 内存
//   >adpcm                IMA ADPCM 共享向量自检（PASS/FAIL + 最大采样差）
//
// 输入同时从 UART0（115200，CONFIG_ESP_CONSOLE_UART_DEFAULT）和 USB-Serial-JTAG
// （CONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG）读：真机上你可能是 USB-C 进终端，
// 不赌是哪条，两个都收。
#pragma once

namespace console {
void Init();
}
