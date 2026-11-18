// link_ble.h —— BLE 链路传输层（NimBLE GATT peripheral），只被 link.cc 使用。
//
// 契约：docs/协议-v2-契约.md §3/§4/§5
//   - GATT Service / DOWN(write,write-no-rsp) / UP(notify)，MTU preferred 247；
//   - 每个 BLE 包 = 7 字节头 + 负载（magic 0xA5 / type / flags / frag_index /
//     frag_total / payload_len LE16）；
//   - TX：32 KB PSRAM 环形队列 + `bletx` 任务（prio 6，栈 4096）分片 notify，
//     ENOMEM/忙重试（同一片最多 200 ms，超时丢整条并计 tx_drop）；
//   - RX：GATT write 回调只做头校验+拷进重组缓冲（text 4 KB 内部 RAM / binary
//     16 KB PSRAM），完整消息入 2 槽 rxq → `blerx` 任务（prio 6，栈 6144）调用上层回调。
//
// 线程模型：
//   · Send()/TxQueuedBytes() 可被任意任务调用（内部短临界区 + PSRAM 环）；
//   · 上层回调在 blerx 任务上下文执行（与旧 ws:: 回调语义一致：短小、只入队）；
//   · 其它函数由 link.cc 的仲裁任务调用。
#pragma once

#include <cstddef>
#include <cstdint>

namespace ble_link {

constexpr int kDefaultMtu = 23;    // 未协商前的 ATT MTU
constexpr int kPreferredMtu = 247; // sdkconfig 里 CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU
constexpr int kMaxTextBytes = 4096;
constexpr int kMaxBinaryBytes = 16384;
constexpr size_t kTxRingBytes = 32 * 1024;

struct Status {
    bool inited = false;        // NimBLE 协议栈是否起来了
    bool advertising = false;   // 当前是否在广播
    bool connected = false;     // 是否有 central 连着
    uint16_t mtu = kDefaultMtu; // 协商后的 ATT MTU
    int rssi = 0;               // 连接 RSSI（dBm）；未连上 0
    int tx_frames = 0;          // 已发 notify 包数
    int rx_frames = 0;          // 已收完整逻辑消息数
    int tx_drop = 0;            // 丢的 TX **字节数**（队列满/通知重试超时/断线清队）
    int rx_drop = 0;            // 丢的 RX **消息数**（坏帧/重组超时/覆盖未消费）
    int connects = 0;           // 连接建立次数（含首次；重连次数用它 - 1）
    char name[24] = {0};        // 广播名 "Jingjing-XXXX"
};

// 一条完整逻辑消息到达（is_text=true: JSON 控制消息；false: 二进制音频/图片）。
// 在 blerx 任务上下文执行，回调返回后缓冲会被复用 —— 需要保留就自己拷走。
using OnMessage = void (*)(bool is_text, const uint8_t* data, size_t len);

// 初始化 NimBLE（NVS 需已 init）。失败只返回 false（link 只 warn，不挡开机）。
bool Init(const char* name_hint);
void SetOnMessage(OnMessage cb);

// UP 的 CCCD 被打开（notify 订阅）时回调一次；在 NimBLE host task 上下文执行，
// 回调里只应置标志/入队，不要做耗时操作。
void SetOnSubscribed(void (*cb)());

void StartAdv();     // 开始广播（未 init/已连接/已在广播时是 no-op）
void StopAdv();      // 停广播（不断已有连接）
void Disconnect();   // 主动断开当前连接
void Stop();         // 停广播 + 断连接（协议栈保留，可再 StartAdv）

// 入队一条逻辑消息。true = 已入队。
// false = 未连接 / 参数非法 / 文本队列满（二进制队列满时丢最旧的整条，按契约返回 true）。
bool Send(bool is_text, const uint8_t* data, size_t len);

// 当前 TX 环里待发字节数。上传任务用它做背压（避免音频被"丢最旧"啃掉中间段）。
int TxQueuedBytes();

Status GetStatus();

}  // namespace ble_link
