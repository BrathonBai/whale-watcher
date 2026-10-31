#include "input.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "ws_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sensecap-watcher.h"   // bsp_exp_io_get_level

namespace input {
namespace {

constexpr const char* TAG = "input";
constexpr int kPinA = 41;
constexpr int kPinB = 42;
// BSP 的输入掩码是 0x20ff = P0.0~P0.7 | P1.3，其中 P1.3 是 **bit 13**（0x2000），
// 不是 1<<3（那是 P0.3）。这里直接用 BSP 的宏，避免再算错。
constexpr uint16_t kKeyMaskP1 = BSP_KNOB_BTN;   // = IO_EXPANDER_PIN_NUM_3 = 0x0008（P0.3）
constexpr uint16_t kAltMask = 0x2000;                              // P1.3（对照探针）

volatile int s_turns = 0;
volatile bool s_key_down = false;
volatile int s_pending = 0;   // 待派发的格数（ISR 只写这个）
int s_last_ab = -1;
void (*s_on_turn)(int) = nullptr;
void (*s_on_press)() = nullptr;
void (*s_on_long)() = nullptr;

// 正交解码：只认合法跳变，抖动/非法态直接忽略（和 v1 同一套判定）
void IRAM_ATTR Isr(void*) {
    const int a = gpio_get_level((gpio_num_t)kPinA);
    const int b = gpio_get_level((gpio_num_t)kPinB);
    const int ab = (a << 1) | b;
    const int prev = s_last_ab;
    if (prev < 0) { s_last_ab = ab; return; }
    if (ab == prev) return;
    // 00→01→11→10 顺时针
    static const int kSeq[4] = {0b00, 0b01, 0b11, 0b10};
    int i0 = -1, i1 = -1;
    for (int i = 0; i < 4; ++i) { if (kSeq[i] == prev) i0 = i; if (kSeq[i] == ab) i1 = i; }
    s_last_ab = ab;
    if (i0 < 0 || i1 < 0) return;
    const int d = (i1 - i0 + 4) % 4;
    if (d == 1) { ++s_turns; ++s_pending; }        // 回调不能放 ISR：里面要 I2C/刷屏/打日志
    else if (d == 3) { --s_turns; --s_pending; }
}

void KeyTask(void*) {
    bool down = false;
    ESP_LOGW(TAG, "KeyTask 已运行：heap=%u 最大块=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    int64_t last_dbg = 0;
    int64_t down_at = 0;
    for (;;) {
        // 把中断累积的格数在任务上下文里派发（这是唯一安全的地方）
        const int pend = s_pending;
        if (pend != 0) {
            s_pending = 0;
            int step = pend > 0 ? 1 : -1;
            for (int i = 0; i < (pend > 0 ? pend : -pend) && i < 8; ++i) {
                if (s_on_turn) s_on_turn(step);
            }
        }
        const int lvl = bsp_exp_io_get_level(kKeyMaskP1);   // 0 = 按下
        const bool now = (lvl == 0);
        if (now != down) {
            vTaskDelay(pdMS_TO_TICKS(20));                  // 去抖
            const int lvl2 = bsp_exp_io_get_level(kKeyMaskP1);
            if ((lvl2 == 0) == now) {
                down = now;
                s_key_down = now;
                if (down) {
                    down_at = esp_timer_get_time();
                } else {
                    const int64_t held = esp_timer_get_time() - down_at;
                    if (held >= 1000000) { if (s_on_long) s_on_long(); }
                    else if (s_on_press) s_on_press();
                }
                ESP_LOGI(TAG, "按键 %s（累计 %d 格，raw=%d）", down ? "按下" : "松开", s_turns, lvl2);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(10));
        const int64_t t = esp_timer_get_time();
        if (t - last_dbg > 1000000) {
            last_dbg = t;
            ESP_LOGI(TAG, "探针 P0.3(key)=%d turns=%d ws连=%d", bsp_exp_io_get_level(kKeyMaskP1),
                     s_turns, (int)ws::Connected());
        }
    }
}

}  // namespace

void Init() {
    gpio_config_t cfg = {};
    cfg.pin_bit_mask = (1ULL << kPinA) | (1ULL << kPinB);
    cfg.mode = GPIO_MODE_INPUT;
    cfg.pull_up_en = GPIO_PULLUP_ENABLE;
    cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
    cfg.intr_type = GPIO_INTR_ANYEDGE;
    gpio_config(&cfg);
    gpio_install_isr_service(0);
    gpio_isr_handler_add((gpio_num_t)kPinA, Isr, nullptr);
    gpio_isr_handler_add((gpio_num_t)kPinB, Isr, nullptr);
    const BaseType_t ok = xTaskCreate(KeyTask, "key", 3072, nullptr, 4, nullptr);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "key 任务创建失败！最大块=%u", (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    }
    ESP_LOGW(TAG, "旋钮 A%d/B%d + 按键 P1.3 就绪（不用 LVGL indev）", kPinA, kPinB);
}

int Turns() { return s_turns; }
bool KeyDown() { return s_key_down; }
void OnTurn(void (*cb)(int)) { s_on_turn = cb; }
void OnPress(void (*cb)()) { s_on_press = cb; }
void OnLongPress(void (*cb)()) { s_on_long = cb; }

}  // namespace input