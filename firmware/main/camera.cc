#include "camera.h"

#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sensecap-watcher.h"
#include "sscma_client.h"

#include "esp_heap_caps.h"

namespace camera {
namespace {

// 标准 base64 解码（返回解码字节数）
int B64Decode(const char* in, int in_len, uint8_t* out, int out_cap) {
    static int8_t map[256];
    static bool init = false;
    if (!init) {
        for (int i = 0; i < 256; ++i) map[i] = -1;
        const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int i = 0; i < 64; ++i) map[(unsigned char)tbl[i]] = (int8_t)i;
        init = true;
    }
    int out_len = 0, val = 0, bits = 0;
    for (int i = 0; i < in_len; ++i) {
        if (in[i] == '=') break;   // padding：停止，避免多解出 0 字节
        const int8_t d = map[(unsigned char)in[i]];
        if (d < 0) continue;
        val = (val << 6) | d;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (out_len < out_cap) out[out_len++] = (uint8_t)((val >> bits) & 0xFF);
        }
    }
    return out_len;
}

// 一次采样后的回调钩子（由 app 侧设置）
void (*s_on_image)(const uint8_t* jpg, int len) = nullptr;
constexpr const char* TAG = "cam";
sscma_client_handle_t s_client = nullptr;
uint8_t* s_jpeg = nullptr;
int s_jpeg_len = 0;
volatile bool s_busy = false;   // 采样进行中（周期采集与按需拍照互斥）

void OnEvent(sscma_client_handle_t, const sscma_client_reply_t* r, void*) {
    if (!r || !r->data) return;
    // 打印前 40 字节，判断是 JSON 还是二进制（JPEG 头 FF D8）
    char head[41] = {0};
    const size_t n = r->len < 40 ? r->len : 40;
    for (size_t i = 0; i < n; ++i) {
        const unsigned char c = (unsigned char)r->data[i];
        head[i] = (c >= 0x20 && c < 0x7f) ? (char)c : '.';
    }
    bool jpeg = r->len > 2 && (unsigned char)r->data[0] == 0xFF && (unsigned char)r->data[1] == 0xD8;
    ESP_LOGW(TAG, "事件 %u 字节%s | %s", (unsigned)r->len, jpeg ? "（JPEG！）" : "", head);
    // 负载前可能有 1 字节前缀，从第一个 '{' 开始找结构
    int st = -1;
    for (int i = 0; i < 8 && i < (int)r->len; ++i) {
        if (r->data[i] == '{') { st = i; break; }
    }
    if (st >= 0) {
        const char* json = r->data + st;
        const int jlen = (int)r->len - st;
        const char* key = strstr(json, "\"image\": \"");
        if (!key) key = strstr(json, "\"image\":\"");
        if (key) {
            const char* b = strchr(key, ':');
            b = b ? strchr(b, '"') : nullptr;
            if (b) {
                ++b;
                const char* e = strchr(b, '"');
                if (e && e > b) {
                    const int blen = (int)(e - b);
                    if (!s_jpeg) s_jpeg = (uint8_t*)heap_caps_malloc(blen, MALLOC_CAP_SPIRAM);
                    if (s_jpeg) {
                        s_jpeg_len = B64Decode(b, blen, s_jpeg, blen);
                        ESP_LOGW(TAG, "JPEG 解码 %d 字节（base64 %d）%s", s_jpeg_len, blen,
                                 (s_jpeg_len > 3 && s_jpeg[0] == 0xFF && s_jpeg[1] == 0xD8) ? "✓FFD8" : "✗魔数");
                        if (s_on_image && s_jpeg_len > 0) s_on_image(s_jpeg, s_jpeg_len);
                    }
                }
            }
        }
    }
    if (0) {
        char more[241] = {0};
        const int n2 = (r->len - st) < 240 ? (r->len - st) : 240;
        for (int i = 0; i < n2; ++i) {
            const unsigned char c = (unsigned char)r->data[st + i];
            more[i] = (c >= 0x20 && c < 0x7f) ? (char)c : '.';
        }
        ESP_LOGW(TAG, "JSON 前 240：%s", more);
    }
    if (jpeg) {
        s_jpeg_len = (int)r->len;
        if (!s_jpeg) s_jpeg = (uint8_t*)heap_caps_malloc((size_t)r->len, MALLOC_CAP_SPIRAM);
        if (s_jpeg && (size_t)s_jpeg_len <= r->len) {
            std::memcpy(s_jpeg, r->data, r->len);
            ESP_LOGW(TAG, "已缓存 JPEG %d 字节", s_jpeg_len);
        }
    }
}
}  // namespace

bool Init() {
    s_client = bsp_sscma_client_init();
    if (!s_client) {
        ESP_LOGE(TAG, "bsp_sscma_client_init 失败（SPI2/CS21/扩展器 P0.6 P0.7）");
        return false;
    }
    ESP_LOGW(TAG, "客户端句柄 %p", (void*)s_client);

    sscma_client_callback_t cb = {};
    cb.on_event = OnEvent;
    sscma_client_register_callback(s_client, &cb, nullptr);

    ESP_LOGI(TAG, "init: %s", esp_err_to_name(sscma_client_init(s_client)));

    sscma_client_info_t* info = nullptr;
    if (sscma_client_get_info(s_client, &info, false) == ESP_OK && info) {
        ESP_LOGW(TAG, "模块 id=%s name=%s hw=%s sw=%s fw=%s", info->id ? info->id : "?",
                 info->name ? info->name : "?", info->hw_ver ? info->hw_ver : "?",
                 info->sw_ver ? info->sw_ver : "?", info->fw_ver ? info->fw_ver : "?");
    } else {
        ESP_LOGE(TAG, "读模块信息失败");
    }

    sscma_client_model_t* model = nullptr;
    if (sscma_client_get_model(s_client, &model, false) == ESP_OK && model) {
        ESP_LOGW(TAG, "模型 id=%d name=%s ver=%s", model->id, model->name ? model->name : "?",
                 model->ver ? model->ver : "?");
    } else {
        ESP_LOGW(TAG, "读模型信息失败（可能没装模型，不影响取图）");
    }
    return true;
}

void SetImageHandler(void (*cb)(const uint8_t*, int)) { s_on_image = cb; }

// 唯一入口：按需拍一张。周期采样（原 ProbeTask，8 秒一次）已删除：
// ESP32-S3 上做视频流不现实，且每张都要落盘、没人清理（2026-10-31 用户决定）。
void Shoot() {
    if (!s_client || s_busy) return;
    s_busy = true;
    sscma_client_sample(s_client, 1);
    vTaskDelay(pdMS_TO_TICKS(1500));   // 等事件回来
    s_busy = false;
}
}  // namespace camera
