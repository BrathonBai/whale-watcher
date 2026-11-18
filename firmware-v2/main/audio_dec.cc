// audio_dec.cc —— 见 audio_dec.h：裸 Opus 包 → 24 kHz PCM 的独立解码任务。
//
// 数据路径：
//   WS 收包任务: PushPacket()  memcpy 到 PSRAM 包环 (64 包)
//   "adec" 任务: 取包 → opus_decode(24 kHz, mono) → audio::StreamWrite(PCM 环)
//   "aud" 任务:  PCM 环 → I2S（audio.cc，未改其职责）
//
// 失败策略（不静默）：
//   PSRAM 不足 / 缓冲申请失败 / 解码器创建失败 / 任务创建失败 → Init() false + ERROR，
//   上层回退 PCM（hello 只报 pcm）；运行期丢包/解码错/写环丢采样都计数 + 限频打日志。
#include "audio_dec.h"

#include <cstring>

#include "adpcm.h"
#include "audio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "opus.h"

namespace audio_dec {
namespace {

constexpr const char* TAG = "adec";

// 包队列：64 × 20 ms = 1.28 s 抖动容忍。定长槽，最坏 64 × 1275 B ≈ 80 KB PSRAM。
constexpr int kQueueSlots = 64;
constexpr size_t kMaxPacket = 1275;      // RFC 6716：单个 Opus 包上限
constexpr int kMaxDecodeSamples = 2880;  // 120 ms @ 24 kHz：Opus 单包最长 120 ms

// PSRAM 预检：伪栈（默认 120 KB）是**首次解码时**由组件从 PSRAM 懒分配的，
// 分配失败会在 libopus 里 celt_fatal("pseudostack overflow") → abort，回退逻辑拦不住。
// 所以 Init 先把"总账"算出来，不够就直接不上 Opus：伪栈 120 + 状态 ~50 + 包队列 80
// + 解码缓冲 6 + 余量 ≈ 320 KB。
constexpr size_t kMinFreePsram = 320 * 1024;

// 解码任务：栈 8 KB（临时内存走 PSRAM 伪栈，不占任务栈）；优先级与音频任务同为 7。
// 理由：它是 PCM 环的上游生产者，每 20 ms 包只忙 ~1–2 ms（占空 ~5–10%），
// 与 "aud"(7) 同优先级不会互相饿死（两者都会阻塞），也不会挤占 WS(6)/录音(5)。
constexpr int kTaskStack = 8192;
constexpr int kTaskPrio = 7;

OpusDecoder* s_dec = nullptr;
uint8_t* s_pkt = nullptr;      // PSRAM：kQueueSlots 个定长槽
uint16_t s_len[kQueueSlots];   // 128 B 内部静态
int s_head = 0;                // 生产者（WS 收包任务）写下标
int s_tail = 0;                // 消费者（解码任务）读下标
int s_count = 0;
volatile bool s_inflight = false;  // 已出队、正在解码的那一包（Flush 要等它）
int16_t* s_pcm = nullptr;          // PSRAM：单包解码输出
SemaphoreHandle_t s_mx = nullptr;  // 保护包环
SemaphoreHandle_t s_wake = nullptr;  // 包计数信号量：唤醒解码任务
volatile bool s_ok = false;

// 计数：写侧各自任务，读侧取快照（int 在 Xtensa 上读写原子，够诊断用）。
volatile int s_dropped = 0;
volatile int s_decode_errors = 0;
volatile int s_write_drops = 0;
int s_drop_log = 0;        // 丢包日志限频：第 1 次 + 每 50 次
int s_next_write_log = 24000;  // 写环丢采样：累计每满 1 秒量打一行

// 丢包计数 + 限频日志（不静默，也不能 50 包/秒刷屏）。
void CountDrop(const char* why) {
    s_dropped = s_dropped + 1;
    if (++s_drop_log == 1 || (s_drop_log % 50) == 0) {
        ESP_LOGE(TAG, "%s：累计丢包 %d（积压 %d/%d）", why, s_dropped, s_count, kQueueSlots);
    }
}

void DecodeTask(void*) {
    for (;;) {
        // 等一包；200 ms 超时只是防睡死，无包不做忙轮询。
        if (xSemaphoreTake(s_wake, pdMS_TO_TICKS(200)) != pdTRUE) continue;
        for (;;) {
            int idx = -1;
            int len = 0;
            if (xSemaphoreTake(s_mx, portMAX_DELAY) != pdTRUE) break;
            if (s_count == 0) {
                xSemaphoreGive(s_mx);
                break;
            }
            idx = s_tail;
            len = (int)s_len[idx];
            s_inflight = true;   // 先置位再解锁：Flush 在锁内同时看 count/inflight，不会漏
            xSemaphoreGive(s_mx);

            const int samples =
                opus_decode(s_dec, s_pkt + (size_t)idx * kMaxPacket, len, s_pcm, kMaxDecodeSamples, 0);
            if (samples < 0) {
                s_decode_errors = s_decode_errors + 1;
                if (s_decode_errors == 1 || (s_decode_errors % 50) == 0) {
                    ESP_LOGE(TAG, "opus_decode 失败（%d B）：%s；累计 %d 次", len,
                             opus_strerror(samples), s_decode_errors);
                }
            } else if (samples > 0) {
                const int put = audio::StreamWrite(s_pcm, samples);
                if (put < samples) {
                    // PCM 环满（播放跟不上）：丢新采样，别阻塞解码任务。
                    s_write_drops = s_write_drops + (samples - put);
                    if (s_write_drops >= s_next_write_log) {
                        ESP_LOGW(TAG, "PCM 环满：丢 %d/%d 采样（累计丢 %d）", samples - put, samples,
                                 s_write_drops);
                        s_next_write_log += 24000;
                    }
                }
            }

            if (xSemaphoreTake(s_mx, portMAX_DELAY) != pdTRUE) break;
            s_tail = (s_tail + 1) % kQueueSlots;
            if (s_count > 0) --s_count;
            s_inflight = false;
            xSemaphoreGive(s_mx);
        }
    }
}

// 释放 Init 中途申请的资源（解码任务只在最后一步创建，所以这里不用管任务）。
void Release() {
    if (s_dec) {
        opus_decoder_destroy(s_dec);
        s_dec = nullptr;
    }
    if (s_wake) {
        vSemaphoreDelete(s_wake);
        s_wake = nullptr;
    }
    if (s_mx) {
        vSemaphoreDelete(s_mx);
        s_mx = nullptr;
    }
    heap_caps_free(s_pkt);
    s_pkt = nullptr;
    heap_caps_free(s_pcm);
    s_pcm = nullptr;
    s_head = s_tail = s_count = 0;
    s_inflight = false;
    s_ok = false;
}

}  // namespace

bool Init() {
    if (s_ok) return true;

    const size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    if (psram_free < kMinFreePsram) {
        ESP_LOGE(TAG, "PSRAM 可用 %u KB < 预检 %u KB：Opus 解码不启用（回退 PCM，避免伪栈分配失败 abort）",
                 (unsigned)(psram_free / 1024), (unsigned)(kMinFreePsram / 1024));
        return false;
    }

    s_pkt = (uint8_t*)heap_caps_malloc((size_t)kQueueSlots * kMaxPacket, MALLOC_CAP_SPIRAM);
    s_pcm = (int16_t*)heap_caps_malloc((size_t)kMaxDecodeSamples * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    s_mx = xSemaphoreCreateMutex();
    s_wake = xSemaphoreCreateCounting(kQueueSlots, 0);
    if (!s_pkt || !s_pcm || !s_mx || !s_wake) {
        ESP_LOGE(TAG, "PSRAM 缓冲申请失败（pkt=%p pcm=%p mx=%p wake=%p）：回退 PCM", (void*)s_pkt,
                 (void*)s_pcm, (void*)s_mx, (void*)s_wake);
        Release();
        return false;
    }

    int err = OPUS_OK;
    s_dec = opus_decoder_create(kOutRate, 1, &err);
    if (!s_dec || err != OPUS_OK) {
        ESP_LOGE(TAG, "opus_decoder_create(%d Hz, 1ch) 失败：%s：回退 PCM", kOutRate, opus_strerror(err));
        s_dec = nullptr;
        Release();
        return false;
    }

    if (xTaskCreate(DecodeTask, "adec", kTaskStack, nullptr, kTaskPrio, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "解码任务创建失败（内部堆不足？）：回退 PCM");
        Release();
        return false;
    }

    s_ok = true;
    ESP_LOGW(TAG, "Opus 解码就绪：%d Hz 裸包 → %d Hz/16bit/mono；包队列 %d×%u B = %.1f KB，"
                  "解码缓冲 %.1f KB，PSRAM 可用 %.1f KB",
             kEncRate, kOutRate, kQueueSlots, (unsigned)kMaxPacket,
             (double)((size_t)kQueueSlots * kMaxPacket) / 1024.0,
             (double)((size_t)kMaxDecodeSamples * sizeof(int16_t)) / 1024.0,
             (double)psram_free / 1024.0);
    return true;
}

bool PushPacket(const uint8_t* data, size_t len) {
    if (!s_ok) {
        CountDrop("解码器未就绪");
        return false;
    }
    if (!data || len == 0 || len > kMaxPacket) {
        CountDrop(len > kMaxPacket ? "包长度超限" : "空包");
        return false;
    }
    // 收包任务不等锁：最多 5 ms，拿不到就丢这一包（宁可丢一包也不堵收包）。
    if (xSemaphoreTake(s_mx, pdMS_TO_TICKS(5)) != pdTRUE) {
        CountDrop("包环忙");
        return false;
    }
    if (s_count == kQueueSlots) {
        xSemaphoreGive(s_mx);
        CountDrop("包环满");
        return false;
    }
    std::memcpy(s_pkt + (size_t)s_head * kMaxPacket, data, len);
    s_len[s_head] = (uint16_t)len;
    s_head = (s_head + 1) % kQueueSlots;
    ++s_count;
    xSemaphoreGive(s_mx);
    xSemaphoreGive(s_wake);  // 计数满/异常时 give 失败无妨，解码任务有 200 ms 超时兜底
    return true;
}

void Flush() {
    if (!s_ok) return;
    // 等"包环空 + 没有在解的那一包"。解码速度 >> 实时，正常 <150 ms；上限 2 s。
    for (int i = 0; i < 200; ++i) {
        bool done = false;
        if (xSemaphoreTake(s_mx, pdMS_TO_TICKS(20)) == pdTRUE) {
            done = (s_count == 0 && !s_inflight);
            xSemaphoreGive(s_mx);
        }
        if (done) return;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    ESP_LOGE(TAG, "Flush 超时（2 s）：仍有 %d 包未解、in-flight=%d —— PCM 环可能不完整",
             s_count, (int)s_inflight);
}

Stats GetStats() {
    Stats st;
    st.dropped = s_dropped;
    st.decode_errors = s_decode_errors;
    st.write_drops = s_write_drops;
    if (s_mx && xSemaphoreTake(s_mx, pdMS_TO_TICKS(20)) == pdTRUE) {
        st.queued = s_count;
        xSemaphoreGive(s_mx);
    }
    return st;
}

// ============================ ADPCM 下行（§6.3） ============================
// 只在收包任务里调用（与 Opus 的包环不同：块头自带状态，同步解码即可）。
namespace {

int16_t* s_ad_pcm = nullptr;    // PSRAM：单块解码输出（≤ 2041 采样 = 4082 B）
uint8_t* s_ad_carry = nullptr;  // PSRAM：跨帧不足 1024 B 的块缓冲
size_t s_ad_carry_len = 0;
int s_ad_left = -1;             // 头里声明的剩余采样数（-1 = 未知，不裁剪）
int s_ad_written = 0;           // 已写入 PCM 环的采样数
int s_ad_blocks = 0;
int s_ad_errors = 0;

bool EnsureAdpcmBuffers() {
    if (s_ad_pcm && s_ad_carry) return true;
    if (!s_ad_pcm) {
        s_ad_pcm = (int16_t*)heap_caps_malloc((size_t)adpcm::kSamplesPerBlock * sizeof(int16_t),
                                              MALLOC_CAP_SPIRAM);
    }
    if (!s_ad_carry) {
        s_ad_carry = (uint8_t*)heap_caps_malloc((size_t)adpcm::kBlockBytes, MALLOC_CAP_SPIRAM);
    }
    if (!s_ad_pcm || !s_ad_carry) {
        ESP_LOGE(TAG, "ADPCM 缓冲申请失败（pcm=%p carry=%p，PSRAM free=%u）", (void*)s_ad_pcm,
                 (void*)s_ad_carry, (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        heap_caps_free(s_ad_pcm);
        heap_caps_free(s_ad_carry);
        s_ad_pcm = nullptr;
        s_ad_carry = nullptr;
        return false;
    }
    return true;
}

// 解一块并写 PCM 环；s_ad_left 用于裁掉末块补齐的 1 个采样。
void AdpcmDecodeOne(const uint8_t* block, size_t len) {
    if (!s_ad_pcm) return;
    const int n = adpcm::DecodeBlock(block, len, s_ad_pcm, adpcm::kSamplesPerBlock);
    if (n <= 0) {
        ++s_ad_errors;
        if (s_ad_errors == 1 || (s_ad_errors % 50) == 0) {
            ESP_LOGE(TAG, "ADPCM 块解码失败（%u B），累计 %d", unsigned(len), s_ad_errors);
        }
        return;
    }
    ++s_ad_blocks;
    int to_write = n;
    if (s_ad_left >= 0) {
        if (s_ad_left <= 0) {
            to_write = 0;   // 已写满声明的采样数：末块补齐部分直接丢
        } else if (to_write > s_ad_left) {
            to_write = s_ad_left;
        }
        s_ad_left -= to_write;
    }
    if (to_write > 0) {
        const int put = audio::StreamWrite(s_ad_pcm, to_write);
        s_ad_written += put;
        if (put < to_write && (s_ad_written % 24000) < to_write) {
            ESP_LOGW(TAG, "ADPCM PCM 环满：丢 %d/%d 采样（累计写 %d）", to_write - put, to_write,
                     s_ad_written);
        }
    }
}

}  // namespace

void AdpcmBegin(int samples_expected) {
    if (!EnsureAdpcmBuffers()) {
        s_ad_left = -1;
        return;
    }
    s_ad_carry_len = 0;
    s_ad_left = samples_expected > 0 ? samples_expected : -1;
    s_ad_written = 0;
    s_ad_blocks = 0;
    // 已知期望采样数时必须能整除（24 kHz 下按采样对齐），未知时也只能按块边写。
    if (s_ad_left < 0) {
        ESP_LOGW(TAG, "ADPCM 头没带 samples：末块补齐的 1 个采样无法裁剪（可能有 1 采样偏差）");
    }
}

bool PushAdpcm(const uint8_t* data, size_t len) {
    if (!data || len == 0) return false;
    if (!s_ad_pcm && !EnsureAdpcmBuffers()) return false;
    size_t off = 0;
    while (off < len) {
        if (s_ad_carry_len > 0) {
            const size_t room = size_t(adpcm::kBlockBytes) - s_ad_carry_len;
            const size_t take = (len - off) < room ? (len - off) : room;
            std::memcpy(s_ad_carry + s_ad_carry_len, data + off, take);
            s_ad_carry_len += take;
            off += take;
            if (s_ad_carry_len == size_t(adpcm::kBlockBytes)) {
                AdpcmDecodeOne(s_ad_carry, s_ad_carry_len);
                s_ad_carry_len = 0;
            }
        } else if ((len - off) >= size_t(adpcm::kBlockBytes)) {
            AdpcmDecodeOne(data + off, adpcm::kBlockBytes);
            off += adpcm::kBlockBytes;
        } else {
            const size_t take = len - off;
            std::memcpy(s_ad_carry, data + off, take);
            s_ad_carry_len = take;
            off = len;
        }
    }
    return true;
}

void AdpcmFlush() {
    if (s_ad_carry_len >= size_t(adpcm::kHeaderBytes)) {
        AdpcmDecodeOne(s_ad_carry, s_ad_carry_len);   // 末短块
    } else if (s_ad_carry_len > 0) {
        ++s_ad_errors;
        ESP_LOGW(TAG, "ADPCM 尾部残留 %u B（不足块头），丢弃", unsigned(s_ad_carry_len));
    }
    s_ad_carry_len = 0;
    ESP_LOGW(TAG, "音频收尾（adpcm）：%d 块，写入 %d 采样%s，解码失败 %d", s_ad_blocks, s_ad_written,
             s_ad_left > 0 ? "（声明采样数没写满！）" : "", s_ad_errors);
    s_ad_left = -1;
}

int AdpcmSamplesWritten() { return s_ad_written; }

}  // namespace audio_dec
