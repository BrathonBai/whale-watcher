// hub v2：BSP 提供电源/总线/RGB/电量/音频，我们自己管面板、动画、输入
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_ops.h"
#include "sensecap-watcher.h"
#include "board_watcher.h"
#include "render.h"
#include "clip_player.h"
#include "input.h"
#include "audio.h"
#include "app_ui.h"
#include "camera.h"
#include "net_wifi.h"
#include "ws_client.h"
#include "nvs_flash.h"
#include <cstring>

// 本机凭据/桥地址（不进仓库；模板见 main/wifi_local.h.example）
#if __has_include("wifi_local.h")
#include "wifi_local.h"
#endif
#ifndef HUB_BRIDGE_URL_LOCAL
#define HUB_BRIDGE_URL_LOCAL ""   // 没配就不连，靠串口提示（见下面 Start 的告警）
#endif

static const char* TAG = "v2";

static void UiTask(void*) {
    for (;;) {
        render::Tick(esp_timer_get_time());
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

extern "C" void app_main(void) {
    nvs_flash_init();
    ESP_LOGI(TAG, "==== hub v2（BSP + 自绘 + 三段动画）====");

    // 音频必须最先：bsp_codec_init() 内部会自己初始化 I2C/PA，
    // 我们抢先调 bsp_i2c_bus_init() 会让它内部那次失败 → ctrl_if NULL → assert。
    const bool audio_ok = audio::Init();   // 音频暂缓：esp_codec_dev 的 i2c_ctrl_if 建不起来（见 docs）
    ESP_LOGI(TAG, "扩展器: %p", (void*)bsp_io_expander_init());   // 必须先建，否则读键恒为 0
    ESP_LOGI(TAG, "i2c:%s spi:%s", esp_err_to_name(bsp_i2c_bus_init()),
             esp_err_to_name(bsp_spi_bus_init()));

    esp_lcd_panel_handle_t panel = nullptr;
    if (watcher::LcdInit(&panel) == ESP_OK) {
        watcher::BacklightInit();
        if (!render::Init(panel)) ESP_LOGE(TAG, "render init 失败");
        clip_player::Init();
        ESP_LOGI(TAG, "clip 就绪 %d 段", clip_player::Loaded());
        render::SetMood(proto::Mood::Idle);
    } else {
        ESP_LOGE(TAG, "面板起不来");
    }

    const bool cam_ok = camera::Init();   // 只初始化，不启动周期采样
    ESP_LOGW(TAG, "camera: %s（按需拍照；不做周期采集）", cam_ok ? "就绪" : "未就绪");
    input::Init();
    // 只有显式给了编译期凭据才覆盖 NVS —— 否则空字符串会把设备上已配好的网络抹掉。
    if (std::strlen(CONFIG_HUB_WIFI_SSID) > 0) {
        net::SaveCredentials(CONFIG_HUB_WIFI_SSID, CONFIG_HUB_WIFI_PASS);
    }
    net::WifiStart();
    if (std::strlen(HUB_BRIDGE_URL_LOCAL) > 0) {
        ws::Start(HUB_BRIDGE_URL_LOCAL);
    } else {
        ESP_LOGE(TAG, "没有配置桥地址：请在 main/wifi_local.h 里写 HUB_BRIDGE_URL_LOCAL"
                      "（模板见 wifi_local.h.example），重新编译刷入");
    }
    app_ui::Init();

    (void)audio_ok;   // 音频由 app_ui 驱动

    // 渲染必须是**最低**的实时任务：412×412 满帧 9 fps 会长时间占 CPU/PSRAM，
    // 优先级高于音频/网络时会把 I2S 和 WS 接收一起饿死（2026-10-31 实测：下行只剩
    // ~20 KB/s、播放断音）。优先级顺序见 main/README 的"任务优先级"。
    xTaskCreate(UiTask, "ui", 6144, nullptr, 4, nullptr);
    for (;;) vTaskDelay(pdMS_TO_TICKS(5000));
}