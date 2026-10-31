// net_wifi.cc —— 见 net_wifi.h。
#include "net_wifi.h"

#include <cstdio>
#include <cstring>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs_creds.h"
#include "nvs.h"
#include "sdkconfig.h"

// 本机凭据头：由 build.ps1 从 %LOCALAPPDATA%\hubdev\wifi.env 生成到**构建副本**里，
// 仓库源码中不存在这个文件。有就用，没有就继续走 NVS / Kconfig。
#if defined(__has_include)
#if __has_include("wifi_local.h")
#include "wifi_local.h"
#define HUB_HAS_LOCAL_WIFI 1
#endif
#endif

namespace net {
namespace {

constexpr const char* TAG = "wifi";
constexpr int kGotIpBit = BIT0;

EventGroupHandle_t s_evt = nullptr;
volatile bool s_connected = false;
volatile int s_rssi = 0;
char s_ssid[33] = {0};
char s_ip[16] = {0};
Source s_source = Source::None;
bool s_inited = false;

const char* kNsApp = "wifi";

void OnWifiEvent(void*, esp_event_base_t base, int32_t id, void* data) {
    if (base == WIFI_EVENT) {
        switch (id) {
            case WIFI_EVENT_STA_START:
                ESP_LOGI(TAG, "STA 已启动，发起连接");
                esp_wifi_connect();
                break;
            case WIFI_EVENT_STA_CONNECTED: {
                auto* e = static_cast<wifi_event_sta_connected_t*>(data);
                std::snprintf(s_ssid, sizeof(s_ssid), "%.*s", (int)e->ssid_len, (const char*)e->ssid);
                ESP_LOGI(TAG, "已关联 AP \"%s\" (channel %d)", s_ssid, e->channel);
                break;
            }
            case WIFI_EVENT_STA_DISCONNECTED: {
                auto* e = static_cast<wifi_event_sta_disconnected_t*>(data);
                s_connected = false;
                s_ip[0] = '\0';
                if (s_evt) xEventGroupClearBits(s_evt, kGotIpBit);
                ESP_LOGW(TAG, "断开 (reason %d)，1s 后重连", (int)e->reason);
                vTaskDelay(pdMS_TO_TICKS(1000));
                esp_wifi_connect();
                break;
            }
            default: break;
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto* e = static_cast<ip_event_got_ip_t*>(data);
        std::snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));
        s_connected = true;
        s_rssi = 0;
        wifi_ap_record_t ap{};
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) s_rssi = ap.rssi;
        ESP_LOGI(TAG, "拿到 IP %s  RSSI %d dBm", s_ip, s_rssi);
        if (s_evt) xEventGroupSetBits(s_evt, kGotIpBit);
    }
}


}  // namespace

Source WifiSource() { return s_source; }
const char* SourceName(Source s) {
    switch (s) {
        case Source::DriverNvs: return "驱动 NVS(nvs.net80211)";
        case Source::LocalHeader: return "本机 wifi_local.h（不进仓库）";
        case Source::AppNvs: return "应用 NVS(wifi/ssid)";
        case Source::Kconfig: return "编译期 Kconfig";
        default: return "(无)";
    }
}
const char* WifiSsid() { return s_ssid; }
const char* WifiIp() { return s_ip; }
bool WifiConnected() { return s_connected; }
int WifiRssi() { return s_rssi; }

void WifiStart() {
    if (s_evt) return;   // 只启动一次
    s_evt = xEventGroupCreate();
    xTaskCreate(
        [](void*) {
            if (!s_inited) {
                ESP_ERROR_CHECK(esp_netif_init());
                ESP_ERROR_CHECK(esp_event_loop_create_default());
                esp_netif_create_default_wifi_sta();

                wifi_init_config_t ic = WIFI_INIT_CONFIG_DEFAULT();
                // 关键：**不让 WiFi 驱动碰 NVS**。
                // 这台设备的 NVS 已经满了（NO_FREE_PAGES 0x1101），nvs_enable=1 时
                // esp_wifi_init 会直接 abort → 被 bootloader 判成"起不来的 app"换个槽启动。
                // 凭据由 nvs_creds 以只读方式从原始分区捞。
                ic.nvs_enable = 0;
                const esp_err_t ierr = esp_wifi_init(&ic);
                if (ierr != ESP_OK) {
                    ESP_LOGE(TAG, "esp_wifi_init 失败 0x%x（网络不可用，UI 照常跑）", (unsigned)ierr);
                    vTaskDelete(nullptr);
                    return;
                }
                s_inited = true;

                esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &OnWifiEvent, nullptr,
                                                    nullptr);
                esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &OnWifiEvent, nullptr,
                                                    nullptr);
            }

            wifi_config_t wc{};
            std::memset(&wc, 0, sizeof(wc));
            char ssid[33] = {0}, pass[65] = {0};

            // ① 应用 NVS（串口 >wifi 配的）—— 优先级最高，否则换网络必须重新烧固件
            bool got = false;
            {
                nvs_handle_t h;
                if (nvs_open("wifi", NVS_READONLY, &h) == ESP_OK) {
                    size_t l1 = sizeof(ssid), l2 = sizeof(pass);
                    if (nvs_get_str(h, "ssid", ssid, &l1) == ESP_OK && ssid[0]) {
                        nvs_get_str(h, "pass", pass, &l2);   // 密码可空（开放网络）
                        s_source = Source::AppNvs;
                        got = true;
                    }
                    nvs_close(h);
                }
            }
            // ② 裸 NVS 里那份（小智当年写的 nvs.net80211）—— 只读，不经 nvs_open
            if (got) {
            } else if (nvs_creds::ReadStaCreds(ssid, sizeof(ssid), pass, sizeof(pass))) {
                s_source = Source::DriverNvs;
#ifdef HUB_HAS_LOCAL_WIFI
            } else if (std::strlen(HUB_WIFI_LOCAL_SSID) > 0) {
                // ② 本机构建副本里的 wifi_local.h（不进仓库）
                std::snprintf(ssid, sizeof(ssid), "%s", HUB_WIFI_LOCAL_SSID);
                std::snprintf(pass, sizeof(pass), "%s", HUB_WIFI_LOCAL_PASS);
                s_source = Source::LocalHeader;
#endif
            } else if (std::strlen(CONFIG_HUB_WIFI_SSID) > 0) {
                // ③ Kconfig（换网络时用）
                std::snprintf(ssid, sizeof(ssid), "%s", CONFIG_HUB_WIFI_SSID);
                std::snprintf(pass, sizeof(pass), "%s", CONFIG_HUB_WIFI_PASS);
                s_source = Source::Kconfig;
            } else {
                s_source = Source::None;
            }

            if (s_source == Source::None) {
                ESP_LOGE(TAG, "没有任何 WiFi 凭据：裸 NVS 没读到、wifi_local.h 没有、Kconfig 也空");
                vTaskDelete(nullptr);
                return;
            }

            const size_t sl = std::strlen(ssid);
            const size_t pl = std::strlen(pass);
            std::memcpy(wc.sta.ssid, ssid, sl < 32 ? sl : 32);
            std::memcpy(wc.sta.password, pass, pl < 64 ? pl : 64);
            ESP_LOGI(TAG, "凭据来源：%s  SSID=\"%s\"", SourceName(s_source), ssid);

            wc.sta.threshold.authmode = WIFI_AUTH_OPEN;   // 不限制加密方式，老路由器也能连
            wc.sta.pmf_cfg.capable = true;
            wc.sta.pmf_cfg.required = false;

            // 下面三步任何一步失败都不 abort：屏和按键必须继续能用
            const esp_err_t e1 = esp_wifi_set_mode(WIFI_MODE_STA);
            const esp_err_t e2 = esp_wifi_set_config(WIFI_IF_STA, &wc);
    const esp_err_t e3 = esp_wifi_start();
    // 关掉 WiFi 省电：WIFI_PS_MIN_MODEM 会把上行攒到下一个 DTIM 信标，
    // 语音上传 4 KB 一帧就要等 ~1.5 s（实测 25 帧 43 秒）。必须在 start() **之后**设。
    ESP_LOGW(TAG, "WiFi 省电 → 关 (WIFI_PS_NONE): %s", esp_err_to_name(esp_wifi_set_ps(WIFI_PS_NONE)));
            if (e1 != ESP_OK || e2 != ESP_OK || e3 != ESP_OK) {
                ESP_LOGE(TAG, "WiFi 启动失败 mode=0x%x cfg=0x%x start=0x%x", (unsigned)e1,
                         (unsigned)e2, (unsigned)e3);
                vTaskDelete(nullptr);
                return;
            }

            // 首次连接最多等 30s，之后交给事件回调里的重连
            const EventBits_t bits = xEventGroupWaitBits(s_evt, kGotIpBit, pdFALSE, pdTRUE,
                                                         pdMS_TO_TICKS(30000));
            if (bits & kGotIpBit) ESP_LOGI(TAG, "网络就绪");
            else ESP_LOGW(TAG, "30s 内没拿到 IP，继续在后台重试");

            // 周期性刷新 RSSI，别的任务读 GetRssi 就能拿到新鲜值
            for (;;) {
                if (s_connected) {
                    wifi_ap_record_t ap{};
                    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) s_rssi = ap.rssi;
                }
                vTaskDelay(pdMS_TO_TICKS(5000));
            }
        },
        "net_wifi", 8192, nullptr, 4, nullptr);
}

bool SaveCredentials(const char* ssid, const char* pass) {
    if (!ssid || !ssid[0]) return false;
    nvs_handle_t h;
    if (nvs_open("wifi", NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_str(h, "ssid", ssid) == ESP_OK;
    ok = (nvs_set_str(h, "pass", pass ? pass : "") == ESP_OK) && ok;
    ok = (nvs_commit(h) == ESP_OK) && ok;
    nvs_close(h);
    ESP_LOGW(TAG, "已保存 WiFi 凭据 ssid=\"%s\"（%s），重启生效", ssid, ok ? "成功" : "失败");
    return ok;
}

}  // namespace net
