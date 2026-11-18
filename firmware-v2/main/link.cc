// link.cc —— 见 link.h：BLE-only 传输门面（2026-11-13 v0.4 起取消 WiFi / PC 桥）。
//
// 设备只保留 BLE 外设：NimBLE 初始化 + 广播；手机 App 作为 central 连接，桥在手机
// PRoot 引擎里。这样固件不再链接 WiFi/WS 代码，启动路径也只有一条，内存账好算：
//   · 之前 Auto 已是"BLE 优先、WiFi 仅保底"，真机运行期内部 free 约 34.7 KB；
//   · 现在彻底不会初始化 WiFi（也不再有 >link wifi / NVS 模式 / 桥地址）。
// 监控任务 200 ms 轮询 BLE 状态，维护 Active 与 reconnects（app_ui 据此重发 hello）；
// 若第一次 NimBLE 初始化失败（内部内存紧张），每 3 s 重试，直到成功。
#include "link.h"

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "link_ble.h"

namespace link {
namespace {

constexpr const char* TAG = "link";
constexpr int kMonPrio = 5;
constexpr int kMonStack = 2560;
constexpr int64_t kBleRetryUs = 3 * 1000 * 1000;

Kind s_active = Kind::None;
bool s_ble_inited = false;
int s_reconnects = 0;

void (*s_on_text)(const char*, size_t) = nullptr;
void (*s_on_binary)(const uint8_t*, size_t) = nullptr;

void DispatchText(const char* d, size_t n) {
    if (s_on_text) s_on_text(d, n);
}
void DispatchBinary(const uint8_t* d, size_t n) {
    if (s_on_binary) s_on_binary(d, n);
}
void BleOnMessage(bool is_text, const uint8_t* d, size_t n) {
    if (is_text) DispatchText(reinterpret_cast<const char*>(d), n);
    else DispatchBinary(d, n);
}

void EnsureBle() {
    if (s_ble_inited) return;
    if (!ble_link::Init(nullptr)) {
        ESP_LOGE(TAG, "BLE 初始化失败（内部内存不足？）——3 s 后重试");
        return;
    }
    ble_link::SetOnMessage(BleOnMessage);
    s_ble_inited = true;
    ESP_LOGW(TAG, "NimBLE 就绪，开始广播");
}

void MonitorTask(void*) {
    int64_t next_init_us = esp_timer_get_time() + kBleRetryUs;
    for (;;) {
        const int64_t now = esp_timer_get_time();
        if (!s_ble_inited && now >= next_init_us) {
            EnsureBle();
            if (s_ble_inited) {
                ble_link::StartAdv();
            } else {
                next_init_us = now + kBleRetryUs;
            }
        }

        const bool ble_conn = s_ble_inited && ble_link::GetStatus().connected;
        const Kind desired = ble_conn ? Kind::Ble : Kind::None;
        if (desired != s_active) {
            const Kind old = s_active;
            s_active = desired;
            if (desired != Kind::None) ++s_reconnects;
            ESP_LOGW(TAG, "生效链路 %s → %s（mtu=%d）", KindName(old), KindName(desired),
                     ble_conn ? (int)ble_link::GetStatus().mtu : 0);
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

}  // namespace

void Init() {
    if (xTaskCreate(MonitorTask, "linkmon", kMonStack, nullptr, kMonPrio, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "链路监控任务创建失败（内部堆不足？）");
    }
    ESP_LOGW(TAG, "链路门面就绪：BLE only");
}

void Start() {
    EnsureBle();
    if (s_ble_inited) ble_link::StartAdv();
}

Kind Active() { return s_active; }
bool Connected() { return s_active != Kind::None; }

const char* UplinkCodec() { return s_active == Kind::Ble ? "adpcm" : "pcm"; }

bool SendText(const char* data, size_t len) {
    if (!data || len == 0) return false;
    return s_active == Kind::Ble && ble_link::Send(true, reinterpret_cast<const uint8_t*>(data), len);
}

bool SendBinary(const uint8_t* data, size_t len) {
    if (!data || len == 0) return false;
    return s_active == Kind::Ble && ble_link::Send(false, data, len);
}

void SetTextHandler(void (*cb)(const char*, size_t)) { s_on_text = cb; }
void SetBinaryHandler(void (*cb)(const uint8_t*, size_t)) { s_on_binary = cb; }
void SetOnSubscribed(void (*cb)()) { ble_link::SetOnSubscribed(cb); }

Stats Get() {
    Stats st;
    st.active = s_active;
    const ble_link::Status ble = ble_link::GetStatus();
    st.ble_connected = ble.connected;
    st.reconnects = s_reconnects;
    st.tx_frames = ble.tx_frames;
    st.rx_frames = ble.rx_frames;
    st.tx_drop = ble.tx_drop;
    st.rx_drop = ble.rx_drop;
    st.mtu = ble.connected ? int(ble.mtu) : 0;
    st.rssi = ble.connected ? ble.rssi : 0;
    std::snprintf(st.name, sizeof(st.name), "%s", ble.name);
    return st;
}

const char* KindName(Kind k) {
    switch (k) {
        case Kind::None: return "none";
        case Kind::Ble: return "ble";
    }
    return "none";
}

int TxQueuedBytes() { return s_ble_inited ? ble_link::TxQueuedBytes() : 0; }

void Reconnect() {
    ESP_LOGW(TAG, "主动重建链路（当前 %s）", KindName(s_active));
    if (s_ble_inited && ble_link::GetStatus().connected) {
        ble_link::Disconnect();   // 断开后自动恢复广播，app_ui 会重发 hello
        return;
    }
    if (!s_ble_inited) EnsureBle();
    if (s_ble_inited) ble_link::StartAdv();
}

}  // namespace link
