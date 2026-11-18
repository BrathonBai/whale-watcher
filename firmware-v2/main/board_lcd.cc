// v2 的 LCD：沿用 v1 验证过的 QSPI 面板初始化 + **等 DMA 完成**的分带刷屏
// （BSP 负责电源门/总线/旋钮/RGB；BSP 的 LVGL 端口会和我们抢面板，所以不用它）
#include "board_watcher.h"

#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_spd2010.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace watcher {
namespace {

constexpr const char* TAG = "lcd";
constexpr int kW = 412, kH = 412;
SemaphoreHandle_t s_done = nullptr;

bool IRAM_ATTR OnColorDone(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void*) {
    BaseType_t hp = pdFALSE;
    if (s_done) xSemaphoreGiveFromISR(s_done, &hp);
    return hp == pdTRUE;
}

}  // namespace

esp_err_t BacklightInit() {
    ledc_timer_config_t t = {};
    t.speed_mode = LEDC_LOW_SPEED_MODE;
    t.duty_resolution = LEDC_TIMER_10_BIT;
    t.timer_num = LEDC_TIMER_1;
    t.freq_hz = 5000;
    t.clk_cfg = LEDC_AUTO_CLK;
    if (ledc_timer_config(&t) != ESP_OK) return ESP_FAIL;
    ledc_channel_config_t c = {};
    c.gpio_num = 8;
    c.speed_mode = LEDC_LOW_SPEED_MODE;
    c.channel = LEDC_CHANNEL_1;
    c.intr_type = LEDC_INTR_DISABLE;
    c.timer_sel = LEDC_TIMER_1;
    c.duty = 0;
    c.hpoint = 0;
    if (ledc_channel_config(&c) != ESP_OK) return ESP_FAIL;
    return BacklightSet(80);
}

esp_err_t BacklightSet(int percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, (1024u * percent) / 100u);
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1);
}

esp_err_t LcdInit(esp_lcd_panel_handle_t* out_panel) {
    spi_bus_config_t bus = {};
    bus.sclk_io_num = 7;
    bus.data0_io_num = 9;
    bus.data1_io_num = 1;
    bus.data2_io_num = 14;
    bus.data3_io_num = 13;
    bus.data4_io_num = -1;
    bus.data5_io_num = -1;
    bus.data6_io_num = -1;
    bus.data7_io_num = -1;
    bus.max_transfer_sz = kW * kH * 2;
    bus.flags = SPICOMMON_BUSFLAG_MASTER | SPICOMMON_BUSFLAG_QUAD;
    esp_err_t e = spi_bus_initialize(SPI3_HOST, &bus, SPI_DMA_CH_AUTO);
    if (e != ESP_OK && e != ESP_ERR_INVALID_STATE) return e;

    esp_lcd_panel_io_spi_config_t io = {};
    io.cs_gpio_num = 45;
    io.dc_gpio_num = -1;
    io.spi_mode = 3;
    io.pclk_hz = 40 * 1000 * 1000;
    io.trans_queue_depth = 10;
    io.lcd_cmd_bits = 32;
    io.lcd_param_bits = 8;
    io.flags.quad_mode = true;

    esp_lcd_panel_io_handle_t io_handle = nullptr;
    e = esp_lcd_new_panel_io_spi(SPI3_HOST, &io, &io_handle);
    if (e != ESP_OK) return e;

    s_done = xSemaphoreCreateBinary();
    esp_lcd_panel_io_callbacks_t cbs = {};
    cbs.on_color_trans_done = OnColorDone;
    esp_lcd_panel_io_register_event_callbacks(io_handle, &cbs, nullptr);

    spd2010_vendor_config_t vendor = {};
    vendor.flags.use_qspi_interface = 1;
    esp_lcd_panel_dev_config_t dev = {};
    dev.reset_gpio_num = -1;
    dev.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
    dev.bits_per_pixel = 16;
    dev.vendor_config = &vendor;

    e = esp_lcd_new_panel_spd2010(io_handle, &dev, out_panel);
    if (e != ESP_OK) return e;
    esp_lcd_panel_reset(*out_panel);
    e = esp_lcd_panel_init(*out_panel);
    if (e != ESP_OK) return e;
    esp_lcd_panel_mirror(*out_panel, false, false);
    esp_lcd_panel_disp_on_off(*out_panel, true);
    ESP_LOGI(TAG, "面板就绪 %dx%d", kW, kH);
    return ESP_OK;
}

esp_err_t LcdDrawBand(esp_lcd_panel_handle_t panel, int x0, int y0, int x1, int y1, const void* data) {
    if (!panel || !data) return ESP_ERR_INVALID_ARG;
    if (s_done) xSemaphoreTake(s_done, 0);          // 清残留
    esp_err_t e = esp_lcd_panel_draw_bitmap(panel, x0, y0, x1, y1, data);
    if (e != ESP_OK) return e;
    if (s_done) return xSemaphoreTake(s_done, pdMS_TO_TICKS(2000)) == pdTRUE ? ESP_OK : ESP_ERR_TIMEOUT;
    return ESP_OK;
}

}  // namespace watcher