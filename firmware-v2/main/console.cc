// console.cc —— 见 console.h。一个任务轮询 UART0 + USB-Serial-JTAG，按行分发。
//
// 为什么不引 esp_console：它带 linenoise/命令表/help 生成，内部 RAM 只剩 ~85 KB，
// 这点命令不值得。这里只用一个 96 B 行缓冲 + 一个任务（栈 3072 / 优先级 3）。
#include "console.h"

#include <cstdio>
#include <cstring>

#include "driver/uart.h"
#include "driver/usb_serial_jtag.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "adpcm.h"
#include "link.h"

namespace console {
namespace {

constexpr const char* TAG = "cmd";
constexpr int kTaskStack = 3072;
constexpr int kTaskPrio = 3;
constexpr int kLineCap = 96;

bool s_uart_ok = false;
bool s_jtag_ok = false;

void PrintHelp() {
    ESP_LOGI(TAG, "命令：>help | >link | >link reconnect | >stat | >adpcm");
}

void PrintLink() {
    const link::Stats st = link::Get();
    ESP_LOGI(TAG, "link: active=%s bleConn=%d mtu=%d rssi=%d reconnects=%d",
             link::KindName(st.active), (int)st.ble_connected, st.mtu, st.rssi, st.reconnects);
    ESP_LOGI(TAG, "      name=%s uplink=%s", st.name[0] ? st.name : "（未初始化）",
             link::UplinkCodec());
    ESP_LOGI(TAG, "      txFrames=%d rxFrames=%d txDrop=%d rxDrop=%d", st.tx_frames, st.rx_frames,
             st.tx_drop, st.rx_drop);
    ESP_LOGI(TAG, "      heap: internal free=%u largest=%u | psram free=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

void PrintStat() {
    const link::Stats st = link::Get();
    const char* transport = (st.active == link::Kind::Ble) ? "ble" : "none";
    ESP_LOGI(TAG, "stat: transport=%s uplink=%s mtu=%d rssi=%d txDrop=%d rxDrop=%d reconnects=%d",
             transport, link::UplinkCodec(), st.mtu, st.rssi, st.tx_drop, st.rx_drop, st.reconnects);
    ESP_LOGI(TAG, "      heap: internal free=%u | psram free=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

void PrintAdpcm() {
    static char report[768];
    const bool ok = adpcm::SelfTest(report, sizeof(report));
    // report 是多行文本（每条向量一行 + RESULT）。ESP_LOG 单条有长度上限，逐行打，
    // 这样抓串口时不会把一条 PASS/FAIL 截成两半。
    ESP_LOGI(TAG, "adpcm 自检开始（共享向量来自 bridge/test/fixtures）");
    char* p = report;
    while (p && *p) {
        char* nl = std::strchr(p, '\n');
        if (nl) *nl = '\0';
        if (*p) ESP_LOGI(TAG, "%s", p);
        p = nl ? (nl + 1) : nullptr;
    }
    ESP_LOGI(TAG, "adpcm 自检：%s", ok ? "PASS" : "FAIL");
}

// 去掉首尾空白，返回去掉首字符 '>' 后的指针。
char* Trim(char* s) {
    while (*s == ' ' || *s == '\t') ++s;
    char* end = s + std::strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r')) --end;
    *end = '\0';
    return s;
}

void HandleLine(char* line) {
    char* s = Trim(line);
    if (*s == '>') {
        ++s;
        while (*s == ' ') ++s;
    }
    if (*s == '\0') return;

    if (std::strcmp(s, "help") == 0) {
        PrintHelp();
        return;
    }
    if (std::strcmp(s, "link") == 0) {
        PrintLink();
        return;
    }
    if (std::strncmp(s, "link ", 5) == 0) {
        const char* arg = Trim(s + 5);
        if (std::strcmp(arg, "reconnect") == 0) {
            link::Reconnect();
        } else {
            ESP_LOGW(TAG, "用法：>link reconnect（直接 >link 看状态）");
            return;
        }
        PrintLink();
        return;
    }
    if (std::strcmp(s, "stat") == 0) {
        PrintStat();
        return;
    }
    if (std::strcmp(s, "adpcm") == 0) {
        PrintAdpcm();
        return;
    }
    ESP_LOGW(TAG, "未知命令 \"%s\"，>help 看列表", s);
}

void FeedByte(char c, char* line, size_t* n) {
    if (c == '\r' || c == '\n') {
        if (*n > 0) {
            line[*n] = '\0';
            HandleLine(line);
            *n = 0;
        }
        return;
    }
    if (c == 0x7f || c == '\b') {   // 退格
        if (*n > 0) --*n;
        return;
    }
    if (*n + 1 < size_t(kLineCap)) {
        line[(*n)++] = c;
    } else {
        *n = 0;   // 超长行直接丢弃，别撑爆缓冲
    }
}

void CmdTask(void*) {
    char line[kLineCap];
    size_t n = 0;
    uint8_t buf[64];

    // UART0：只装 RX 驱动（TX 走 ROM console，日志输出不受影响）；不重配引脚/波特率。
    uart_config_t cfg = {};
    cfg.baud_rate = 115200;
    cfg.data_bits = UART_DATA_8_BITS;
    cfg.parity = UART_PARITY_DISABLE;
    cfg.stop_bits = UART_STOP_BITS_1;
    cfg.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    cfg.source_clk = UART_SCLK_DEFAULT;
    if (uart_param_config(UART_NUM_0, &cfg) == ESP_OK &&
        uart_driver_install(UART_NUM_0, 1024, 0, 0, nullptr, 0) == ESP_OK) {
        s_uart_ok = true;
    } else {
        ESP_LOGW(TAG, "UART0 行命令不可用（驱动安装失败）");
    }

    // USB-Serial-JTAG：真机通常从 USB-C 进终端，这条也要收。
    usb_serial_jtag_driver_config_t jcfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    if (usb_serial_jtag_driver_install(&jcfg) == ESP_OK) {
        s_jtag_ok = true;
    } else {
        ESP_LOGW(TAG, "USB-Serial-JTAG 行命令不可用（驱动安装失败）");
    }

    ESP_LOGW(TAG, "串口命令就绪：UART0=%d USB-JTAG=%d；>help 看命令", (int)s_uart_ok, (int)s_jtag_ok);

    for (;;) {
        // UART0 与 JTAG 各读一小段，谁有数据就喂给同一个行缓冲。
        if (s_uart_ok) {
            const int r = uart_read_bytes(UART_NUM_0, buf, sizeof(buf), pdMS_TO_TICKS(50));
            for (int i = 0; i < r; ++i) FeedByte(char(buf[i]), line, &n);
        }
        if (s_jtag_ok) {
            const int r = usb_serial_jtag_read_bytes(buf, sizeof(buf), pdMS_TO_TICKS(50));
            for (int i = 0; i < r; ++i) FeedByte(char(buf[i]), line, &n);
        }
        if (!s_uart_ok && !s_jtag_ok) vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

}  // namespace

void Init() {
    if (xTaskCreate(CmdTask, "cmd", kTaskStack, nullptr, kTaskPrio, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "命令任务创建失败（内部堆不足？）");
    }
}

}  // namespace console
