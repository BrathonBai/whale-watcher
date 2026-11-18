#include "audio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "sensecap-watcher.h"

namespace audio {
namespace {
constexpr const char* TAG = "audio";
constexpr int kRate = 24000;
bool s_ok = false;
}  // namespace

bool Init() {
    // 只调 bsp_codec_init()：它内部会完成 bsp_i2c_bus_init + bsp_audio_init(默认 cfg) + codec 控制句柄。
    // 我们**不能**先自己调 bsp_i2c_bus_init()，否则内部那次会返回"已初始化"→ ctrl_if 为 NULL → assert。
    esp_err_t e = bsp_codec_init();
    ESP_LOGI(TAG, "bsp_codec_init: %s", esp_err_to_name(e));
    if (e != ESP_OK) return false;
    e = bsp_codec_set_fs(kRate, 16, I2S_SLOT_MODE_MONO);
    ESP_LOGI(TAG, "bsp_codec_set_fs: %s", esp_err_to_name(e));
    if (e != ESP_OK) return false;
    int got = 0;
    bsp_codec_volume_set(70, &got);
    s_ok = true;
    ESP_LOGW(TAG, "音频就绪 %d Hz / 音量 %d", kRate, got);
    return true;
}

int Record(int16_t* buf, int samples) {
    if (!s_ok || !buf) return 0;
    size_t got = 0;
    if (bsp_i2s_read(buf, (size_t)samples * 2, &got, 2000) != ESP_OK) return 0;
    return (int)(got / 2);
}

int Play(const int16_t* buf, int samples) {
    if (!s_ok || !buf) return 0;
    const size_t total = (size_t)samples * 2;
    // 计时探针：实时播放 1 秒音频应该耗时约 1000 ms；远小于此说明 DMA 丢数据
    const int64_t t0 = esp_timer_get_time();
    size_t off = 0;
    int rounds = 0;
    while (off < total) {
        size_t wrote = 0;
        const esp_err_t e = bsp_i2s_write((void*)((const uint8_t*)buf + off), total - off, &wrote, 1000);
        ++rounds;
        if (wrote) off += wrote;
        if (e != ESP_OK && wrote == 0) {
            ESP_LOGW("audio", "write 失败 %s（已写 %u/%u）", esp_err_to_name(e), (unsigned)off, (unsigned)total);
            break;
        }
    }
    const int64_t ms = (esp_timer_get_time() - t0) / 1000;
    ESP_LOGW("audio", "Play %d 采样 / %d 轮 / 耗时 %lld ms（应约 %lld ms）%s",
             samples, rounds, (long long)ms, (long long)(samples * 1000 / 24000),
             (ms * 2 < samples * 1000 / 24000) ? " ← 太快，数据被丢！" : "");
    return (int)(off / 2);
}

namespace {
// 环形缓冲：24 kHz × 16 bit × 2.5 s = 120 KB PSRAM。
// 原来按 12 s 开（576 KB）；实测 12 s 只会把"打断/停播"的延迟拖到十秒级，对话里没有收益。
// 2.5 s 足够吸收链路抖动 + 桥侧预缓冲（~300 ms），同时给 Opus 伪栈（120 KB）/状态
// （~50 KB）/包队列（80 KB）腾出 PSRAM。改动这里要同步 docs/迭代-2026-11-03-设备Opus.md。
constexpr int kStreamBufferMs = 2500;
constexpr int kRingSamples = kRate * kStreamBufferMs / 1000;          // 60000 采样
constexpr size_t kRingBytes = (size_t)kRingSamples * sizeof(int16_t);  // 120000 B
int16_t* s_ring = nullptr;
size_t s_head = 0, s_tail = 0;
SemaphoreHandle_t s_mx = nullptr;
// 欠载统计：只由 AudioTask 写；volatile 供 pong（WS 任务）读取。
volatile bool s_stream_expected = false;
volatile int s_underruns = 0;

void AudioTask(void*) {
    int16_t tmp[480];   // 20 ms
    bool was_dry = true;  // 上一轮环是否已空：只在"非空 → 空"的沿上记一次欠载
    for (;;) {
        size_t n = 0;
        if (s_mx && xSemaphoreTake(s_mx, pdMS_TO_TICKS(50)) == pdTRUE) {
            while (n < sizeof(tmp) / sizeof(tmp[0]) && s_tail != s_head) {
                tmp[n++] = s_ring[s_tail];
                s_tail = (s_tail + 1) % kRingSamples;
            }
            xSemaphoreGive(s_mx);
        }
        if (n) {
            was_dry = false;
            size_t wrote = 0;
            bsp_i2s_write((void*)tmp, n * 2, &wrote, 1000);
        } else {
            // 期望播放中却没数据 = 一次欠载（对话里听感是"卡一下"）。空闲时环空不算。
            if (s_stream_expected && !was_dry) {
                s_underruns = s_underruns + 1;   // 不用 ++：C++20 对 volatile 自增已弃用
                was_dry = true;
            }
            vTaskDelay(pdMS_TO_TICKS(5));
        }
    }
}
}  // namespace

void StreamInit() {
    if (s_ring) return;
    s_ring = (int16_t*)heap_caps_malloc(kRingBytes, MALLOC_CAP_SPIRAM);
    s_mx = xSemaphoreCreateMutex();
    if (!s_ring || !s_mx) { ESP_LOGE("audio", "流式缓冲申请失败（%u KB PSRAM）", (unsigned)(kRingBytes / 1024)); return; }
    s_head = s_tail = 0;
    // 音频必须高于渲染：一次 20 ms 的 I2S 供给被 UI 抢走就会断音（听感是"卡顿"）。
    xTaskCreate(AudioTask, "aud", 4096, nullptr, 7, nullptr);
    ESP_LOGW("audio", "流式播放就绪：%d ms 缓冲 = %d 采样 = %.1f KB PSRAM（配 %d Hz/16bit/mono）",
             kStreamBufferMs, kRingSamples, (double)kRingBytes / 1024.0, kRate);
}

int StreamWrite(const int16_t* buf, int samples) {
    if (!s_ring || !s_mx) {
        // FW-12：原来退化成 Play()（阻塞播），而调用方是 WS 收包任务 —— 会堵住收包。
        // 宁可丢这段音频并把错误喊出来，也不能阻塞实时任务。
        static bool warned = false;
        if (!warned) {
            warned = true;
            ESP_LOGE("audio", "流式缓冲未就绪，丢弃 %d 采样（不阻塞收包；检查 PSRAM 分配）", samples);
        }
        return 0;
    }
    if (xSemaphoreTake(s_mx, pdMS_TO_TICKS(200)) != pdTRUE) return 0;
    int put = 0;
    for (int i = 0; i < samples; ++i) {
        const size_t next = (s_head + 1) % kRingSamples;
        if (next == s_tail) break;                     // 满则丢
        s_ring[s_head] = buf[i];
        s_head = next;
        ++put;
    }
    xSemaphoreGive(s_mx);
    return put;
}

int StreamBuffered() {
    if (!s_ring || !s_mx) return 0;
    if (xSemaphoreTake(s_mx, pdMS_TO_TICKS(20)) != pdTRUE) return 0;
    const int n = (int)((s_head + kRingSamples - s_tail) % kRingSamples);
    xSemaphoreGive(s_mx);
    return n;
}

void StreamFlush() {
    // 等缓冲排空（最多 8 秒）
    for (int i = 0; i < 800; ++i) {
        if (StreamBuffered() < 240) break;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void StreamClear() {
    // 只丢"还没播"的部分；正在写 I2S 的那 20 ms 会播完，听感上就是立刻停。
    if (!s_ring || !s_mx) return;
    if (xSemaphoreTake(s_mx, pdMS_TO_TICKS(50)) != pdTRUE) return;
    s_tail = s_head;
    xSemaphoreGive(s_mx);
}

void StreamSetExpected(bool on) { s_stream_expected = on; }

int StreamUnderruns() { return s_underruns; }

void Volume(int percent) { int g = 0; bsp_codec_volume_set(percent, &g); }

}  // namespace audio