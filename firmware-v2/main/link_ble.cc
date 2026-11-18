// link_ble.cc —— 见 link_ble.h。NimBLE GATT peripheral + 7 字节帧分片/重组。
//
// 契约：docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md §3/§4/§5。
// 关键点（都是"真机上最容易踩"的地方，先写死在代码里）：
//   · GATT write 回调在 NimBLE host task 里跑：只做头校验 + 拷进重组缓冲，绝不解析 JSON；
//   · notify 在 mbuf 不足时返回 BLE_HS_ENOMEM：按片重试 200 ms，超时丢整条并计 tx_drop；
//   · TX 环满时 text 丢新、binary 丢最旧（音频宁可少一段，不要让队列无限涨）；
//   · 断线恢复广播、清 TX 环、清重组状态；RSSI/MTU 只在有连接时读。
#include "link_ble.h"

#include <cstdio>
#include <cstring>

#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_adv.h"
#include "host/ble_hs_id.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_l2cap.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "nimble/ble.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "store/config/ble_store_config.h"

// ble_store_config.c 定义了它但公开头文件没声明；C++ 里必须显式给 C linkage，
// 否则在 ble_link 命名空间里会找 ble_link::ble_store_config_init（链接期才报 undefined）。
extern "C" void ble_store_config_init(void);

namespace ble_link {
namespace {

constexpr const char* TAG = "ble";

// 帧头（§4）：magic/type/flags/frag_index/frag_total/payload_len(LE16) = 7 B
constexpr uint8_t kMagic = 0xA5;
constexpr uint8_t kTypeText = 0x01;
constexpr uint8_t kTypeBinary = 0x02;
constexpr uint8_t kFlagFirst = 0x01;
constexpr uint8_t kFlagLast = 0x02;
constexpr size_t kFrameHeader = 7;

// 连接参数（§3）：interval 12–24 ms、latency 0、timeout 4 s
constexpr uint16_t kConnItvlMin = 10;   // 12.5 ms（1.25 ms 单位）
constexpr uint16_t kConnItvlMax = 19;   // 23.75 ms
constexpr uint16_t kConnTimeout = 400;  // 4 s（10 ms 单位）
constexpr int kFragRetryMs = 200;       // 同一片 notify 重试上限
constexpr int kRxTimeoutMs = 3000;      // 重组超时（§4）

constexpr int kTxTaskPrio = 6;
constexpr int kRxTaskPrio = 6;
constexpr int kTxTaskStack = 4096;
constexpr int kRxTaskStack = 6144;

// ---------------------------------------------------------------- 状态
struct RxSlot {
    uint8_t* buf = nullptr;
    size_t cap = 0;
    size_t off = 0;
    uint8_t next_frag = 0;
    uint8_t total_frag = 0;
    bool active = false;   // 正在收
    bool done = false;     // 收全了，等 blerx 消费
    bool busy = false;     // blerx 正在调用上层回调（此时新消息不能覆盖缓冲）
    int64_t start_ms = 0;
};

// 128-bit UUID 的线上字节序是**小端**（最低字节在前）。
// Service 6a696e67-6a69-6e67-8000-000000000001 / DOWN ...0002 / UP ...0003
constexpr uint8_t kUuidSvcLe[16] = {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
                                    0x67, 0x6e, 0x69, 0x6a, 0x67, 0x6e, 0x69, 0x6a};
constexpr uint8_t kUuidDownLe[16] = {0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
                                     0x67, 0x6e, 0x69, 0x6a, 0x67, 0x6e, 0x69, 0x6a};
constexpr uint8_t kUuidUpLe[16] = {0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
                                   0x67, 0x6e, 0x69, 0x6a, 0x67, 0x6e, 0x69, 0x6a};

// GATT 定义（静态存储：NimBLE 注册后只读引用，指针必须活到进程结束）
ble_uuid128_t s_svc_uuid;
ble_uuid128_t s_down_uuid;
ble_uuid128_t s_up_uuid;
ble_gatt_chr_def s_chr_defs[3];
ble_gatt_svc_def s_svc_defs[2];
uint16_t s_up_handle = 0;

// 连接/广播状态
volatile bool s_inited = false;
volatile bool s_advertising = false;
volatile bool s_connected = false;
volatile uint16_t s_conn_handle = 0;
volatile uint16_t s_mtu = kDefaultMtu;
uint8_t s_own_addr_type = 0;
char s_name[24] = {0};

// 计数器（跨任务；用 __atomic 读写，避免 blerx/bletx/host task 互相踩）
volatile int s_tx_frames = 0;
volatile int s_rx_frames = 0;
volatile int s_tx_drop = 0;
volatile int s_rx_drop = 0;
volatile int s_connects = 0;

// TX 环（PSRAM）：记录 = [kind u8][len u16 LE][data]
uint8_t* s_tx_ring = nullptr;
size_t s_tx_head = 0;   // 消费位置
size_t s_tx_tail = 0;   // 生产位置（写到这里）
size_t s_tx_used = 0;
int s_tx_gen = 0;       // 清队代数：tx 任务据此发现自己的消息已被 flush 掉
SemaphoreHandle_t s_tx_lock = nullptr;
SemaphoreHandle_t s_tx_wake = nullptr;

// RX 重组（text 4 KB 内部 RAM / binary 16 KB PSRAM）
RxSlot s_rx_text;
RxSlot s_rx_bin;
portMUX_TYPE s_rx_mux = portMUX_INITIALIZER_UNLOCKED;
SemaphoreHandle_t s_rx_wake = nullptr;
OnMessage s_on_message = nullptr;
void (*s_on_subscribed)() = nullptr;

inline int64_t NowMs() { return esp_timer_get_time() / 1000; }

inline int AtomicGet(volatile int* p) { return __atomic_load_n(p, __ATOMIC_RELAXED); }
inline void AtomicAdd(volatile int* p, int v) { __atomic_fetch_add(p, v, __ATOMIC_RELAXED); }

inline uint16_t ReadU16(const uint8_t* p) { return uint16_t(p[0]) | uint16_t(uint16_t(p[1]) << 8); }
inline void WriteU16(uint8_t* p, uint16_t v) {
    p[0] = uint8_t(v & 0xff);
    p[1] = uint8_t((v >> 8) & 0xff);
}

void MakeIdUuid(ble_uuid128_t* out, const uint8_t le[16]) {
    std::memset(out, 0, sizeof(*out));
    out->u.type = BLE_UUID_TYPE_128;
    std::memcpy(out->value, le, 16);
}

void CopyStr(char* dst, size_t cap, const char* src) {
    if (!dst || cap == 0) return;
    size_t i = 0;
    if (src) {
        for (; i + 1 < cap && src[i]; ++i) dst[i] = src[i];
    }
    dst[i] = '\0';
}

// ---------------------------------------------------------------- TX 环
bool EnqueueLocked(bool is_text, const uint8_t* data, size_t len) {
    const size_t need = 3 + len;
    if (need > kTxRingBytes) return false;
    bool fits = (kTxRingBytes - s_tx_used) >= need;
    if (!fits && !is_text) {
        // 二进制：丢最旧的整条消息直到装得下（契约 §5.1）
        while (!fits && s_tx_used >= 3) {
            const uint16_t old_len = ReadU16(s_tx_ring + s_tx_head + 1);
            const size_t old_rec = 3 + size_t(old_len);
            if (old_rec > s_tx_used) {   // 环坏了，直接清空重建
                s_tx_head = s_tx_tail = s_tx_used = 0;
                break;
            }
            s_tx_head += old_rec;
            s_tx_used -= old_rec;
            AtomicAdd(&s_tx_drop, int(old_len));
            if (s_tx_used == 0) {
                s_tx_head = s_tx_tail = 0;
            }
            fits = (kTxRingBytes - s_tx_used) >= need;
        }
    }
    if (!fits) return false;
    // 线性化：只要 head>0 就把剩余数据搬到开头，使 tail 后面始终有连续空间
    if (s_tx_head > 0) {
        if (s_tx_used > 0) std::memmove(s_tx_ring, s_tx_ring + s_tx_head, s_tx_used);
        s_tx_head = 0;
        s_tx_tail = s_tx_used;
    }
    s_tx_ring[s_tx_tail] = is_text ? kTypeText : kTypeBinary;
    WriteU16(s_tx_ring + s_tx_tail + 1, uint16_t(len));
    std::memcpy(s_tx_ring + s_tx_tail + 3, data, len);
    s_tx_tail += need;
    s_tx_used += need;
    return true;
}

// 清空 TX 环（断线/模式切换）。返回丢弃的字节数。
int FlushTxLocked() {
    int dropped = 0;
    size_t pos = s_tx_head;
    while (s_tx_used >= 3) {
        const uint16_t len = ReadU16(s_tx_ring + pos + 1);
        const size_t rec = 3 + size_t(len);
        if (rec > s_tx_used) break;
        dropped += int(len);
        pos += rec;
        s_tx_used -= rec;
    }
    s_tx_head = 0;
    s_tx_tail = 0;
    s_tx_used = 0;
    ++s_tx_gen;   // 让正在发消息的 tx 任务知道"尾巴被砍了"
    return dropped;
}

// 发一包（阻塞当前任务，最长 kFragRetryMs）。成功 true。
bool NotifyWithRetry(const uint8_t* buf, size_t len) {
    const int64_t deadline = NowMs() + kFragRetryMs;
    int attempt = 0;
    for (;;) {
        if (!s_connected) return false;
        struct os_mbuf* om = ble_hs_mbuf_from_flat(buf, uint16_t(len));
        if (om) {
            const int rc = ble_gatts_notify_custom(s_conn_handle, s_up_handle, om);
            if (rc == 0) {
                AtomicAdd(&s_tx_frames, 1);
                return true;
            }
            // om 的所有权归 NimBLE（成功/失败都会回收），这里不能再 free。
        }
        if (NowMs() >= deadline) {
            if ((attempt % 20) == 0) {
                ESP_LOGW(TAG, "notify 重试 %d 次仍失败（mtu=%u，本片 %u B），丢弃本消息",
                         attempt, unsigned(s_mtu), unsigned(len));
            }
            return false;
        }
        // mbuf 不足/控制器忙：2 ms 后再试（§5.3）
        vTaskDelay(pdMS_TO_TICKS(2));
        ++attempt;
    }
}

// ---------------------------------------------------------------- TX 任务
void TxTask(void*) {
    uint8_t frag[kFrameHeader + 256];
    for (;;) {
        xSemaphoreTake(s_tx_wake, pdMS_TO_TICKS(100));

        for (;;) {
            if (!s_connected) break;

            // 取一条消息的头（拷贝在锁里做，数据和后续分片也逐片拷）
            bool is_text = false;
            size_t msg_len = 0;
            size_t msg_head = 0;
            int gen = 0;
            xSemaphoreTake(s_tx_lock, portMAX_DELAY);
            if (s_tx_used < 3) {
                xSemaphoreGive(s_tx_lock);
                break;
            }
            const uint8_t kind = s_tx_ring[s_tx_head];
            is_text = (kind == kTypeText);
            msg_len = ReadU16(s_tx_ring + s_tx_head + 1);
            msg_head = s_tx_head;
            gen = s_tx_gen;
            xSemaphoreGive(s_tx_lock);

            // 分片参数：payload ≤ MTU-3-7
            size_t chunk_max = size_t(s_mtu) > (3 + kFrameHeader) ? size_t(s_mtu) - 3 - kFrameHeader : 1;
            if (chunk_max > 256) chunk_max = 256;   // frag 缓冲上限（MTU 247 → 237）
            const size_t frag_total = (msg_len + chunk_max - 1) / chunk_max;
            if (frag_total < 1 || frag_total > 255) {
                ESP_LOGW(TAG, "消息 %u B 分片数 %u 非法，丢弃", unsigned(msg_len), unsigned(frag_total));
                xSemaphoreTake(s_tx_lock, portMAX_DELAY);
                if (s_tx_head == msg_head && s_tx_used >= 3) {
                    s_tx_head += 3 + msg_len;
                    s_tx_used -= 3 + msg_len;
                    if (s_tx_used == 0) s_tx_head = s_tx_tail = 0;
                }
                xSemaphoreGive(s_tx_lock);
                AtomicAdd(&s_tx_drop, int(msg_len));
                continue;
            }

            bool ok = true;
            size_t off = 0;
            uint8_t frag_index = 0;
            while (off < msg_len) {
                const size_t chunk = (msg_len - off) > chunk_max ? chunk_max : (msg_len - off);
                // 锁内校验消息是否还在（可能被 flush / 丢最旧砍掉），并拷出本片负载
                xSemaphoreTake(s_tx_lock, portMAX_DELAY);
                const bool intact = (gen == s_tx_gen) && (s_tx_head == msg_head) && (s_tx_used >= 3 + msg_len);
                if (intact) {
                    std::memcpy(frag + kFrameHeader, s_tx_ring + msg_head + 3 + off, chunk);
                }
                xSemaphoreGive(s_tx_lock);
                if (!intact) {
                    AtomicAdd(&s_tx_drop, int(msg_len - off));
                    ok = false;
                    break;
                }

                frag[0] = kMagic;
                frag[1] = is_text ? kTypeText : kTypeBinary;
                frag[2] = uint8_t((off == 0 ? kFlagFirst : 0) |
                                  (off + chunk == msg_len ? kFlagLast : 0));
                frag[3] = frag_index;
                frag[4] = uint8_t(frag_total);
                WriteU16(frag + 5, uint16_t(chunk));

                if (!NotifyWithRetry(frag, kFrameHeader + chunk)) {
                    AtomicAdd(&s_tx_drop, int(msg_len - off));
                    ok = false;
                    break;
                }
                off += chunk;
                ++frag_index;
                // 每 4 片让出 1 ms，避免饿死同优先级任务（§5.3）
                if ((frag_index % 4) == 0) vTaskDelay(1);
            }

            // 消费掉这条消息（只有 head 没被别人动过才推进）
            xSemaphoreTake(s_tx_lock, portMAX_DELAY);
            if (s_tx_head == msg_head && (gen == s_tx_gen) && s_tx_used >= 3 + msg_len) {
                s_tx_head += 3 + msg_len;
                s_tx_used -= 3 + msg_len;
                if (s_tx_used == 0) s_tx_head = s_tx_tail = 0;
            }
            xSemaphoreGive(s_tx_lock);
            if (!ok) {
                ESP_LOGW(TAG, "TX 消息丢弃（剩余 %u B，gen=%d）", unsigned(msg_len), gen);
                break;   // 让外层重新看连接状态
            }
        }
    }
}

// ---------------------------------------------------------------- RX 重组
inline RxSlot* SlotFor(bool is_text) { return is_text ? &s_rx_text : &s_rx_bin; }

// 7 字节头 + 负载 → 重组缓冲。运行在 NimBLE host task（§5.4 只做拷贝）。
void OnWriteFrame(const uint8_t* d, size_t len) {
    if (len < kFrameHeader) {
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    const uint8_t magic = d[0];
    const uint8_t type = d[1];
    const uint8_t flags = d[2];
    const uint8_t frag_index = d[3];
    const uint8_t frag_total = d[4];
    const uint16_t payload_len = ReadU16(d + 5);

    if (magic != kMagic) {
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    // 0x10–0x1F 是保留的传输控制帧（v1 不用）：静默丢 + 计数，不能断链（§4）
    if (type != kTypeText && type != kTypeBinary) {
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    if (payload_len != len - kFrameHeader) {
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    const int max_payload = int(s_mtu) - 3 - int(kFrameHeader);
    if (max_payload <= 0 || int(payload_len) > max_payload) {
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    if (frag_total < 1 || frag_index >= frag_total) {
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    const bool is_text = (type == kTypeText);
    RxSlot* slot = SlotFor(is_text);
    const bool first = (flags & kFlagFirst) != 0;
    const bool last = (flags & kFlagLast) != 0;
    const int64_t now = NowMs();

    portENTER_CRITICAL(&s_rx_mux);
    // 3 s 没凑齐的旧消息先丢（§4）
    if (slot->active && slot->start_ms && (now - slot->start_ms) > kRxTimeoutMs) {
        slot->active = false;
        slot->done = false;
        AtomicAdd(&s_rx_drop, 1);
    }
    if (slot->busy) {
        // blerx 还在把上一条交给上层：这条直接丢（正常忙窗口 < 10 ms，只在音频解码时见到）
        portEXIT_CRITICAL(&s_rx_mux);
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    if (first) {
        if (slot->active || slot->done) AtomicAdd(&s_rx_drop, 1);   // 覆盖进行中/未消费：计丢
        slot->active = true;
        slot->done = false;
        slot->off = 0;
        slot->next_frag = 0;
        slot->total_frag = frag_total;
        slot->start_ms = now;
        if (frag_index != 0) {
            slot->active = false;
            portEXIT_CRITICAL(&s_rx_mux);
            AtomicAdd(&s_rx_drop, 1);
            return;
        }
    }
    if (!slot->active || frag_index != slot->next_frag || frag_total != slot->total_frag) {
        slot->active = false;
        portEXIT_CRITICAL(&s_rx_mux);
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    if (slot->off + payload_len > slot->cap) {
        slot->active = false;
        portEXIT_CRITICAL(&s_rx_mux);
        AtomicAdd(&s_rx_drop, 1);
        return;
    }
    portEXIT_CRITICAL(&s_rx_mux);

    // 负载拷贝：只有 host task 写这块缓冲，且 slot->done=false 时 blerx 不会读
    std::memcpy(slot->buf + slot->off, d + kFrameHeader, payload_len);

    portENTER_CRITICAL(&s_rx_mux);
    slot->off += payload_len;
    ++slot->next_frag;
    bool complete = false;
    if (last) {
        if (slot->next_frag == slot->total_frag) {
            slot->active = false;
            slot->done = true;
            complete = true;
            AtomicAdd(&s_rx_frames, 1);
        } else {
            slot->active = false;
            AtomicAdd(&s_rx_drop, 1);
        }
    }
    portEXIT_CRITICAL(&s_rx_mux);
    if (complete) xSemaphoreGive(s_rx_wake);
}

// ---------------------------------------------------------------- RX 任务
void RxTask(void*) {
    for (;;) {
        xSemaphoreTake(s_rx_wake, pdMS_TO_TICKS(500));
        for (;;) {
            bool did = false;
            for (int pass = 0; pass < 2; ++pass) {
                const bool is_text = (pass == 0);
                RxSlot* slot = SlotFor(is_text);
                bool ready = false;
                size_t len = 0;
                portENTER_CRITICAL(&s_rx_mux);
                if (slot->done && !slot->busy) {
                    slot->done = false;
                    slot->busy = true;
                    len = slot->off;
                    ready = true;
                }
                portEXIT_CRITICAL(&s_rx_mux);
                if (!ready) continue;
                did = true;
                OnMessage cb = s_on_message;
                if (cb && len > 0) cb(is_text, slot->buf, len);
                portENTER_CRITICAL(&s_rx_mux);
                slot->busy = false;
                slot->off = 0;
                slot->active = false;
                portEXIT_CRITICAL(&s_rx_mux);
            }
            if (!did) break;
        }
    }
}

// ---------------------------------------------------------------- GATT
int GattAccess(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt* ctxt,
               void* arg) {
    (void)conn_handle;
    (void)attr_handle;
    const bool is_up = (arg != nullptr);
    if (is_up) {
        // UP 只做 notify，不允许读写
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    uint8_t buf[272];
    uint16_t out_len = 0;
    const uint16_t pkt_len = OS_MBUF_PKTLEN(ctxt->om);
    if (pkt_len > sizeof(buf)) {
        AtomicAdd(&s_rx_drop, 1);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &out_len) != 0) {
        AtomicAdd(&s_rx_drop, 1);
        return BLE_ATT_ERR_UNLIKELY;
    }
    OnWriteFrame(buf, out_len);
    return 0;
}

// ---------------------------------------------------------------- GAP
void StartAdvInternal();

// 从 MAC 末两字节生成广播名（§3：Jingjing-XXXX，便于人眼识别）
void MakeName(const char* hint) {
    if (hint && hint[0]) {
        CopyStr(s_name, sizeof(s_name), hint);
        return;
    }
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_BT) == ESP_OK) {
        std::snprintf(s_name, sizeof(s_name), "Jingjing-%02X%02X", mac[4], mac[5]);
    } else {
        CopyStr(s_name, sizeof(s_name), "Jingjing-0000");
    }
}

void RestartAdvIfNeeded() {
    if (!s_inited || s_connected) return;
    if (!s_advertising) StartAdvInternal();
}

void OnConnect(uint16_t conn_handle) {
    s_conn_handle = conn_handle;
    s_connected = true;
    s_advertising = false;
    s_mtu = ble_att_mtu(conn_handle);
    if (s_mtu == 0) s_mtu = kDefaultMtu;
    AtomicAdd(&s_connects, 1);

    // 请求连接参数（interval 12–24 ms / latency 0 / timeout 4 s）
    struct ble_gap_upd_params upd = {};
    upd.itvl_min = kConnItvlMin;
    upd.itvl_max = kConnItvlMax;
    upd.latency = 0;
    upd.supervision_timeout = kConnTimeout;
    const int rc = ble_gap_update_params(conn_handle, &upd);
    if (rc != 0) ESP_LOGW(TAG, "连接参数更新失败 rc=%d（继续用 Android 给的参数）", rc);

    // 试一下 2M PHY（失败不报错，§3）。NimBLE 5.5 签名是 4 参：
    // (conn_handle, tx_phys_mask, rx_phys_mask, phy_options)。
    const int prc = ble_gap_set_prefered_le_phy(conn_handle, BLE_GAP_LE_PHY_2M_MASK,
                                                BLE_GAP_LE_PHY_2M_MASK, 0);
    if (prc != 0) ESP_LOGI(TAG, "2M PHY 请求失败 rc=%d（继续 1M）", prc);

    ESP_LOGW(TAG, "BLE 已连接：handle=%u mtu=%u", unsigned(conn_handle), unsigned(s_mtu));
}

void OnDisconnect(int reason) {
    s_connected = false;
    s_conn_handle = 0;
    s_mtu = kDefaultMtu;
    // 清 TX 环（未发的消息算丢弃，计 tx_drop）+ 清重组状态
    if (s_tx_lock) {
        xSemaphoreTake(s_tx_lock, portMAX_DELAY);
        const int dropped = FlushTxLocked();
        xSemaphoreGive(s_tx_lock);
        if (dropped > 0) AtomicAdd(&s_tx_drop, dropped);
    }
    portENTER_CRITICAL(&s_rx_mux);
    s_rx_text.active = false;
    s_rx_text.done = false;
    s_rx_text.off = 0;
    s_rx_bin.active = false;
    s_rx_bin.done = false;
    s_rx_bin.off = 0;
    portEXIT_CRITICAL(&s_rx_mux);
    ESP_LOGW(TAG, "BLE 断开（reason=%d），恢复广播", reason);
    RestartAdvIfNeeded();
}

int GapEvent(struct ble_gap_event* event, void* arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                OnConnect(event->connect.conn_handle);
            } else {
                ESP_LOGW(TAG, "连接失败 status=%d，继续广播", event->connect.status);
                s_advertising = false;
                RestartAdvIfNeeded();
            }
            return 0;
        case BLE_GAP_EVENT_DISCONNECT:
            OnDisconnect(event->disconnect.reason);
            return 0;
        case BLE_GAP_EVENT_MTU:
            if (event->mtu.channel_id == BLE_L2CAP_CID_ATT) {
                s_mtu = event->mtu.value;
                ESP_LOGW(TAG, "MTU 协商：%u（payload=%u）", unsigned(s_mtu), unsigned(s_mtu) > 10 ? unsigned(s_mtu) - 3 - 7 : 0);
            }
            return 0;
        case BLE_GAP_EVENT_ADV_COMPLETE:
            s_advertising = false;
            ESP_LOGW(TAG, "广播结束 reason=%d", event->adv_complete.reason);
            RestartAdvIfNeeded();
            return 0;
        case BLE_GAP_EVENT_CONN_UPDATE:
            ESP_LOGI(TAG, "连接参数更新 status=%d", event->conn_update.status);
            return 0;
        case BLE_GAP_EVENT_PHY_UPDATE_COMPLETE:
            ESP_LOGI(TAG, "PHY 更新 status=%d tx=%u rx=%u", event->phy_updated.status,
                     event->phy_updated.tx_phy, event->phy_updated.rx_phy);
            return 0;
        case BLE_GAP_EVENT_SUBSCRIBE:
            ESP_LOGW(TAG, "CCCD 订阅：conn=%u attr=%u notify=%d", unsigned(event->subscribe.conn_handle),
                     unsigned(event->subscribe.attr_handle), (int)event->subscribe.cur_notify);
            if (event->subscribe.cur_notify && s_on_subscribed) s_on_subscribed();
            return 0;
        default:
            return 0;
    }
}

void StartAdvInternal() {
    if (!s_inited || s_connected) return;
    if (ble_gap_adv_active()) {
        s_advertising = true;
        return;
    }
    // 广播数据：flags + 128-bit Service UUID；设备名放 scan response（§3）
    struct ble_hs_adv_fields fields = {};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = &s_svc_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "广播数据设置失败 rc=%d", rc);
        return;
    }
    struct ble_hs_adv_fields rsp = {};
    rsp.name = reinterpret_cast<uint8_t*>(s_name);
    rsp.name_len = uint8_t(std::strlen(s_name));
    rsp.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGW(TAG, "scan response 设置失败 rc=%d（名字仍可通过 GAP 读）", rc);
    }

    struct ble_gap_adv_params adv = {};
    adv.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv.disc_mode = BLE_GAP_DISC_MODE_GEN;
    adv.itvl_min = BLE_GAP_ADV_ITVL_MS(100);
    adv.itvl_max = BLE_GAP_ADV_ITVL_MS(100);
    rc = ble_gap_adv_start(s_own_addr_type, nullptr, BLE_HS_FOREVER, &adv, GapEvent, nullptr);
    if (rc != 0) {
        ESP_LOGE(TAG, "广播启动失败 rc=%d", rc);
        s_advertising = false;
        return;
    }
    s_advertising = true;
    ESP_LOGW(TAG, "广播中：%s（interval 100 ms，等手机连接）", s_name);
}

// ---------------------------------------------------------------- NimBLE 生命周期
void OnReset(int reason) { ESP_LOGE(TAG, "NimBLE reset reason=%d", reason); }

void OnSync() {
    // 地址类型：优先用公开地址，失败退回随机静态地址
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) ESP_LOGW(TAG, "ensure_addr rc=%d", rc);
    rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "own addr 推断失败 rc=%d", rc);
        return;
    }
    StartAdvInternal();
}

void HostTask(void*) {
    ESP_LOGI(TAG, "NimBLE host task 启动");
    nimble_port_run();   // 直到 nimble_port_stop()（v1 不调）
    nimble_port_freertos_deinit();
}

void BuildGattDefs() {
    MakeIdUuid(&s_svc_uuid, kUuidSvcLe);
    MakeIdUuid(&s_down_uuid, kUuidDownLe);
    MakeIdUuid(&s_up_uuid, kUuidUpLe);

    std::memset(s_chr_defs, 0, sizeof(s_chr_defs));
    // DOWN：手机→设备，Write + Write Without Response（吞吐优先，§3）
    s_chr_defs[0].uuid = &s_down_uuid.u;
    s_chr_defs[0].access_cb = GattAccess;
    s_chr_defs[0].arg = nullptr;
    s_chr_defs[0].flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP;
    s_chr_defs[0].val_handle = nullptr;
    // UP：设备→手机，Notify（CCCD 由协议栈自动加）
    s_chr_defs[1].uuid = &s_up_uuid.u;
    s_chr_defs[1].access_cb = GattAccess;
    s_chr_defs[1].arg = reinterpret_cast<void*>(1);
    s_chr_defs[1].flags = BLE_GATT_CHR_F_NOTIFY;
    s_chr_defs[1].val_handle = &s_up_handle;
    // 结束哨兵：uuid=nullptr
    s_chr_defs[2].uuid = nullptr;

    std::memset(s_svc_defs, 0, sizeof(s_svc_defs));
    s_svc_defs[0].type = BLE_GATT_SVC_TYPE_PRIMARY;
    s_svc_defs[0].uuid = &s_svc_uuid.u;
    s_svc_defs[0].characteristics = s_chr_defs;
    s_svc_defs[0].includes = nullptr;
    s_svc_defs[1].type = 0;   // 结束
}

}  // namespace

// ============================ 对外 API ============================
bool Init(const char* name_hint) {
    if (s_inited) return true;
    if (!s_tx_ring) {
        s_tx_ring = static_cast<uint8_t*>(heap_caps_malloc(kTxRingBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        s_rx_text.buf = static_cast<uint8_t*>(heap_caps_malloc(kMaxTextBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        s_rx_text.cap = kMaxTextBytes;
        s_rx_bin.buf = static_cast<uint8_t*>(heap_caps_malloc(kMaxBinaryBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        s_rx_bin.cap = kMaxBinaryBytes;
        if (!s_tx_ring || !s_rx_text.buf || !s_rx_bin.buf) {
            ESP_LOGE(TAG, "缓冲分配失败：txRing=%p text=%p bin=%p（内部 free=%u）", (void*)s_tx_ring,
                     (void*)s_rx_text.buf, (void*)s_rx_bin.buf,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
            return false;
        }
        s_tx_lock = xSemaphoreCreateMutex();
        s_tx_wake = xSemaphoreCreateBinary();
        s_rx_wake = xSemaphoreCreateBinary();
        if (!s_tx_lock || !s_tx_wake || !s_rx_wake) {
            ESP_LOGE(TAG, "信号量创建失败");
            return false;
        }
        if (xTaskCreate(TxTask, "bletx", kTxTaskStack, nullptr, kTxTaskPrio, nullptr) != pdPASS) {
            ESP_LOGE(TAG, "bletx 任务创建失败");
            return false;
        }
        if (xTaskCreate(RxTask, "blerx", kRxTaskStack, nullptr, kRxTaskPrio, nullptr) != pdPASS) {
            ESP_LOGE(TAG, "blerx 任务创建失败");
            return false;
        }
    }

    MakeName(name_hint);
    BuildGattDefs();

    const esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init 失败：%s（BLE 不可用；link 会每 3 s 重试）", esp_err_to_name(err));
        return false;
    }

    ble_hs_cfg.reset_cb = OnReset;
    ble_hs_cfg.sync_cb = OnSync;
    ble_hs_cfg.gatts_register_cb = nullptr;
    ble_hs_cfg.store_status_cb = nullptr;

#if CONFIG_BT_NIMBLE_GAP_SERVICE
    ble_svc_gap_init();
    const int nrc = ble_svc_gap_device_name_set(s_name);
    if (nrc != 0) ESP_LOGW(TAG, "设备名设置失败 rc=%d", nrc);
#endif
    ble_svc_gatt_init();

    const int crc = ble_gatts_count_cfg(s_svc_defs);
    if (crc != 0) {
        ESP_LOGE(TAG, "GATT 计数失败 rc=%d", crc);
        return false;
    }
    const int arc = ble_gatts_add_svcs(s_svc_defs);
    if (arc != 0) {
        ESP_LOGE(TAG, "GATT 注册失败 rc=%d", arc);
        return false;
    }

#if CONFIG_BT_NIMBLE_NVS_PERSIST
    // 绑定信息落 NVS（v1 不配对，但保留持久化能力）。
    // 声明来自 store/config/ble_store_config.h（C linkage，不能在 ble_link 命名空间里手写 extern）。
    ble_store_config_init();
#endif

    nimble_port_freertos_init(HostTask);
    s_inited = true;
    ESP_LOGW(TAG, "NimBLE 就绪：name=%s（内部 free=%u largest=%u，PSRAM free=%u）", s_name,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    return true;
}

void SetOnMessage(OnMessage cb) { s_on_message = cb; }
void SetOnSubscribed(void (*cb)()) { s_on_subscribed = cb; }

void StartAdv() {
    if (!s_inited) return;
    StartAdvInternal();
}

void StopAdv() {
    if (!s_inited) return;
    if (ble_gap_adv_active()) {
        ble_gap_adv_stop();
    }
    s_advertising = false;
}

void Disconnect() {
    if (!s_inited) return;
    if (s_connected) {
        ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
    }
}

void Stop() {
    StopAdv();
    Disconnect();
}

bool Send(bool is_text, const uint8_t* data, size_t len) {
    if (!data || len == 0 || !s_connected || !s_tx_ring) return false;
    if (is_text && len > size_t(kMaxTextBytes)) return false;
    if (!is_text && len > size_t(kMaxBinaryBytes)) return false;
    xSemaphoreTake(s_tx_lock, portMAX_DELAY);
    const bool ok = EnqueueLocked(is_text, data, len);
    if (!ok) AtomicAdd(&s_tx_drop, int(len));
    xSemaphoreGive(s_tx_lock);
    if (ok) xSemaphoreGive(s_tx_wake);
    return ok;
}

int TxQueuedBytes() {
    if (!s_tx_lock) return 0;
    xSemaphoreTake(s_tx_lock, portMAX_DELAY);
    const int used = int(s_tx_used);
    xSemaphoreGive(s_tx_lock);
    return used;
}

Status GetStatus() {
    Status st;
    st.inited = s_inited;
    st.advertising = s_advertising;
    st.connected = s_connected;
    st.mtu = s_mtu;
    st.tx_frames = AtomicGet(&s_tx_frames);
    st.rx_frames = AtomicGet(&s_rx_frames);
    st.tx_drop = AtomicGet(&s_tx_drop);
    st.rx_drop = AtomicGet(&s_rx_drop);
    st.connects = AtomicGet(&s_connects);
    CopyStr(st.name, sizeof(st.name), s_name);
    if (s_connected) {
        int8_t rssi = 0;
        if (ble_gap_conn_rssi(s_conn_handle, &rssi) == 0) st.rssi = rssi;
    }
    return st;
}

}  // namespace ble_link
