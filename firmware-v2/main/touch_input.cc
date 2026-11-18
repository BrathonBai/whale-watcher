// touch_input.cc —— SPD2010 触摸（I2C1）初始化 + 轮询 + 手势识别
//
// 参数来自 BSP（sensecap-watcher.h）：
//   BSP_TOUCH_I2C_NUM=1, SDA=39, SCL=38, 400kHz, INT 在 PCA9535 P0.5（这里不用）
//   rst_gpio_num = NC（与 LCD reset 共用，显示已初始化完，不能再拉复位）
//   swap_xy/mirror_x/mirror_y = 0（与 v2 面板 mirror(false,false) 一致）
//
// 注意：IDF 5.5 的 esp_lcd_new_panel_io_i2c 会根据 bus 参数类型选择 v1(legacy)/v2(new master)；
// 这里传 i2c_master_bus_handle_t，走新的 i2c_master 驱动。
#include "touch_input.h"

#include <cmath>
#include <cstring>

#include "driver/i2c_master.h"
#include "esp_lcd_io_i2c.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_touch_spd2010.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sensecap-watcher.h"

namespace touch_input {
namespace {

constexpr const char* TAG = "tp";

constexpr int kPollMs = 20;          // 50 Hz 轮询（触摸专用 I2C 总线，开销很小）
constexpr int64_t kTapMaxUs = 350000;
constexpr int kTapMaxMovePx = 30;
constexpr int64_t kDoubleMaxUs = 320000;
constexpr int kDoubleMaxMovePx = 60;
constexpr int64_t kSwipeMaxUs = 600000;
constexpr int kSwipeMinPx = 60;
constexpr int64_t kLongMinUs = 700000;
constexpr int kLongMaxMovePx = 30;

i2c_master_bus_handle_t s_bus = nullptr;
esp_lcd_panel_io_handle_t s_io = nullptr;
esp_lcd_touch_handle_t s_tp = nullptr;
bool s_ready = false;
volatile int s_last_x = -1;
volatile int s_last_y = -1;

void (*s_on_tap)(int, int) = nullptr;
void (*s_on_double)(int, int) = nullptr;
Cb s_on_long = nullptr;
void (*s_on_swipe)(int, int) = nullptr;

struct Gesture {
    bool down = false;
    bool long_fired = false;
    int64_t down_us = 0;
    int down_x = 0, down_y = 0;
    int last_x = 0, last_y = 0;
    int64_t pending_tap_us = 0;   // >0：等双击窗口结束再发单击
    int tap_x = 0, tap_y = 0;
};
Gesture s_g;

inline int iabs(int v) { return v < 0 ? -v : v; }
inline int dist(int x0, int y0, int x1, int y1) {
    const int dx = x1 - x0, dy = y1 - y0;
    return (int)std::sqrt((double)dx * dx + (double)dy * dy);
}

bool ReadTouch() {
    if (!s_tp) return false;
    esp_lcd_touch_point_data_t pt[1] = {};
    uint8_t cnt = 0;
    esp_lcd_touch_read_data(s_tp);
    const esp_err_t e = esp_lcd_touch_get_data(s_tp, pt, &cnt, 1);
    const bool pressed = (e == ESP_OK && cnt > 0);
    if (pressed) {
        int x = pt[0].x;
        int y = pt[0].y;
        // 部分面板坐标可能越界/镜像；先按 BSP 配置直取，日志里可校准
        if (x > DRV_LCD_H_RES - 1) x = DRV_LCD_H_RES - 1;
        if (y > DRV_LCD_V_RES - 1) y = DRV_LCD_V_RES - 1;
        s_last_x = x;
        s_last_y = y;
    }
    return pressed;
}

void RunGesture() {
    static unsigned s_log = 0;
    const int64_t now = esp_timer_get_time();
    const bool pressed = ReadTouch();

    if (pressed) {
        if (!s_g.down) {
            s_g.down = true;
            s_g.long_fired = false;
            s_g.down_us = now;
            s_g.down_x = s_last_x;
            s_g.down_y = s_last_y;
            if (s_log < 12) {
                ESP_LOGI(TAG, "down (%d,%d)", s_last_x, s_last_y);
                ++s_log;
            }
        }
        s_g.last_x = s_last_x;
        s_g.last_y = s_last_y;
        if (!s_g.long_fired && now - s_g.down_us >= kLongMinUs &&
            dist(s_g.down_x, s_g.down_y, s_g.last_x, s_g.last_y) <= kLongMaxMovePx) {
            s_g.long_fired = true;
            if (s_on_long) s_on_long();
        }
    } else if (s_g.down) {
        s_g.down = false;
        const int64_t dt = now - s_g.down_us;
        const int dx = s_g.last_x - s_g.down_x;
        const int dy = s_g.last_y - s_g.down_y;
        const int d = dist(s_g.down_x, s_g.down_y, s_g.last_x, s_g.last_y);
        if (!s_g.long_fired) {
            if (d >= kSwipeMinPx && dt <= kSwipeMaxUs) {
                ESP_LOGI(TAG, "swipe dx=%d dy=%d", dx, dy);
                if (s_on_swipe) s_on_swipe(dx, dy);
            } else if (dt <= kTapMaxUs && d <= kTapMaxMovePx) {
                // 双击判定：两次点击间隔 < 320ms 且位置相近
                if (s_g.pending_tap_us && now - s_g.pending_tap_us <= kDoubleMaxUs &&
                    dist(s_g.tap_x, s_g.tap_y, s_g.last_x, s_g.last_y) <= kDoubleMaxMovePx) {
                    s_g.pending_tap_us = 0;
                    ESP_LOGI(TAG, "double x=%d y=%d", s_g.last_x, s_g.last_y);
                    if (s_on_double) s_on_double(s_g.last_x, s_g.last_y);
                } else {
                    s_g.pending_tap_us = now;
                    s_g.tap_x = s_g.last_x;
                    s_g.tap_y = s_g.last_y;
                }
            }
        }
    }

    // 单击延迟到双击窗口结束再发（避免"单击先触发、双击又触发"）
    if (s_g.pending_tap_us && now - s_g.pending_tap_us > kDoubleMaxUs) {
        s_g.pending_tap_us = 0;
        ESP_LOGI(TAG, "tap x=%d y=%d", s_g.tap_x, s_g.tap_y);
        if (s_on_tap) s_on_tap(s_g.tap_x, s_g.tap_y);
    }
}

void TouchTask(void*) {
    for (;;) {
        RunGesture();
        vTaskDelay(pdMS_TO_TICKS(kPollMs));
    }
}

}  // namespace

void OnTap(void (*cb)(int, int)) { s_on_tap = cb; }
void OnDouble(void (*cb)(int, int)) { s_on_double = cb; }
void OnLong(Cb cb) { s_on_long = cb; }
void OnSwipe(void (*cb)(int, int)) { s_on_swipe = cb; }

bool Ready() { return s_ready; }
int LastX() { return s_last_x; }
int LastY() { return s_last_y; }

bool Init() {
    if (s_ready) return true;

    // 1) 触摸专用 I2C1（与音频/扩展 IO 的 I2C0 分开）
    i2c_master_bus_config_t bus_cfg = {};
    bus_cfg.i2c_port = BSP_TOUCH_I2C_NUM;
    bus_cfg.sda_io_num = BSP_TOUCH_I2C_SDA;
    bus_cfg.scl_io_num = BSP_TOUCH_I2C_SCL;
    bus_cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    bus_cfg.glitch_ignore_cnt = 7;
    bus_cfg.flags.enable_internal_pullup = true;
    esp_err_t e = i2c_new_master_bus(&bus_cfg, &s_bus);
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "I2C1 初始化失败: %s（触摸不可用，旋钮/按键继续工作）", esp_err_to_name(e));
        return false;
    }

    // 2) touch 的 panel IO（地址 0x53；SPD2010 宏的顺序与 IDF5.5 结构体不一致，这里手动填）
    esp_lcd_panel_io_i2c_config_t io_cfg = {};
    io_cfg.dev_addr = ESP_LCD_TOUCH_IO_I2C_SPD2010_ADDRESS;
    io_cfg.control_phase_bytes = 1;
    io_cfg.dc_bit_offset = 0;
    io_cfg.lcd_cmd_bits = 0;
    io_cfg.lcd_param_bits = 0;
    io_cfg.flags.disable_control_phase = 1;
    io_cfg.scl_speed_hz = 100000;   // 与 BSP 的 touch 设备速率一致（总线 400k，设备 100k）
    e = esp_lcd_new_panel_io_i2c(s_bus, &io_cfg, &s_io);
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "触摸 IO 创建失败: %s", esp_err_to_name(e));
        return false;
    }

    // 3) touch 驱动（复位/中断都不接：复位与 LCD 共用，中断在 IO 扩展器上）
    esp_lcd_touch_config_t tp_cfg = {};
    tp_cfg.x_max = DRV_LCD_H_RES;
    tp_cfg.y_max = DRV_LCD_V_RES;
    tp_cfg.rst_gpio_num = GPIO_NUM_NC;
    tp_cfg.int_gpio_num = GPIO_NUM_NC;
    tp_cfg.levels.reset = 0;
    tp_cfg.levels.interrupt = 0;
    tp_cfg.flags.swap_xy = DRV_LCD_SWAP_XY;
    tp_cfg.flags.mirror_x = DRV_LCD_MIRROR_X;
    tp_cfg.flags.mirror_y = DRV_LCD_MIRROR_Y;
    e = esp_lcd_touch_new_i2c_spd2010(s_io, &tp_cfg, &s_tp);
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "SPD2010 触摸驱动初始化失败: %s", esp_err_to_name(e));
        return false;
    }

    // 4) 先读一次让控制器进入正常状态（BSP 也这么做）
    vTaskDelay(pdMS_TO_TICKS(50));
    esp_lcd_touch_read_data(s_tp);
    vTaskDelay(pdMS_TO_TICKS(100));

    if (xTaskCreate(TouchTask, "tp", 3072, nullptr, 3, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "触摸任务创建失败");
        return false;
    }
    s_ready = true;
    ESP_LOGI(TAG, "触摸就绪：SPD2010 @I2C%d（SDA=%d SCL=%d，轮询 %d Hz）", BSP_TOUCH_I2C_NUM,
             BSP_TOUCH_I2C_SDA, BSP_TOUCH_I2C_SCL, 1000 / kPollMs);
    return true;
}

}  // namespace touch_input
