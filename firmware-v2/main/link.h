// link.h —— 对上层唯一的传输门面：BLE 直连手机。
//
// 契约：docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md §5.1。
// 2026-11-13 v0.4 起设备固件**取消 WiFi / PC 桥**，只保留 BLE（用户要求）；
// 上层（app_ui / input / camera）只看这个 namespace：
//   · Active() = 当前生效链路（None / Ble）；None→Ble 或 Ble→None 都算一次"新连接"
//     （app_ui 据此重发 hello）。
//   · 回调在 BLE RX 任务上下文执行；语义与旧 ws:: 一致。
//   · SendText/SendBinary 立即返回是否入队，绝不阻塞 UI 任务。
//   · 不再有 Mode / NVS 模式 / 桥地址：Init 后 Start 直接起 NimBLE 广播；初始化失败会
//     在监控任务里每 3 s 重试一次（内部内存紧张时可能第一次失败）。
#pragma once

#include <cstddef>
#include <cstdint>

namespace link {

enum class Kind : uint8_t { None = 0, Ble };

// 汇总状态（pong 与串口 `>link` 都用它）
struct Stats {
    Kind active = Kind::None;
    bool ble_connected = false;
    int reconnects = 0;   // "新连接"次数（Active 变更计数）
    int tx_frames = 0;    // 已发逻辑消息数
    int rx_frames = 0;    // 已收逻辑消息数
    int tx_drop = 0;      // BLE 字节丢弃
    int rx_drop = 0;      // BLE 坏帧/超时丢弃数
    int mtu = 0;          // BLE MTU
    int rssi = 0;         // BLE 连上 = BLE RSSI，否则 0
    char name[24] = {0};  // BLE 广播名（Jingjing-XXXX）
};

// 建 RX 分发与监控任务；NVS 需已 init。
void Init();
// 初始化 NimBLE（失败自动重试）并开始广播。
void Start();
Kind Active();
bool Connected();
const char* UplinkCodec();   // "adpcm"（已连接）/ "pcm"（未连接）

bool SendText(const char*, size_t);
bool SendBinary(const uint8_t*, size_t);
void SetTextHandler(void (*)(const char*, size_t));
void SetBinaryHandler(void (*)(const uint8_t*, size_t));

// 手机把 UP 的 CCCD 打开（订阅）时回调一次，用于"立刻重发 hello"。
void SetOnSubscribed(void (*)());

Stats Get();

const char* KindName(Kind);

// ---------------------------------------------------------------------------
// 扩展（spec 的 API 之外，只给 app_ui 的上传任务用，已在报告里注明）：
//   TxQueuedBytes()：当前 BLE TX 环待发字节数。10 s ADPCM 上行 ~120 KB > 32 KB 环，
//     上传任务据此做背压（等环降到半空再入队），避免"队列满丢最旧"啃掉音频中间段。
//   Reconnect()：hello 重发 3 次仍没收到 welcome 时主动重建链路（§5.1 的"然后断开重连"）。
// ---------------------------------------------------------------------------
int TxQueuedBytes();
void Reconnect();

}  // namespace link
