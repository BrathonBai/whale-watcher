#include "led.h"
#include "esp_log.h"
#include "sensecap-watcher.h"

namespace led {
namespace {
constexpr const char* TAG = "led";
Mode s_mode = kOff;
}  // namespace

void Init() {
    const esp_err_t e = bsp_rgb_init();
    ESP_LOGI(TAG, "bsp_rgb_init: %s", esp_err_to_name(e));
    Set(kIdle);
}

void Set(Mode m) {
    s_mode = m;
    switch (m) {
        case kOff:    bsp_rgb_set(0, 0, 0); break;
        case kIdle:   bsp_rgb_set(0, 0, 0); break;       // 待机：不亮灯
        case kListen: bsp_rgb_set(100, 0, 0); break;     // 录音：红
        case kThink:  bsp_rgb_set(0, 0, 100); break;     // 思考（上传后等音频）：蓝
        case kSpeak:  bsp_rgb_set(0, 90, 0); break;      // 说话：绿
        case kError:  bsp_rgb_set(45, 0, 0); break;      // 异常：暗红
    }
    ESP_LOGI(TAG, "灯 → %d", (int)m);
}

}  // namespace led