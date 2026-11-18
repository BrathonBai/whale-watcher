#include "mp3_player.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>

#include "audio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "minimp3.h"
#include "storage.h"

namespace mp3 {
namespace {

constexpr const char* TAG = "mp3";
constexpr int kOutRate = 24000;
constexpr size_t kReadBuf = 32 * 1024;     // 码流缓冲（PSRAM）
constexpr int kMaxFiles = 32;
constexpr size_t kPathCap = 160;
constexpr size_t kOutCap = 4096;           // 8 kHz 上采样到 24 kHz 也够（1152 × 3）
constexpr int kTaskStack = 8192;
constexpr int kTaskPrio = 5;               // 低于音频 7 / WS 6，高于渲染 4

SemaphoreHandle_t s_wake = nullptr;
SemaphoreHandle_t s_mx = nullptr;

volatile bool s_stop = false;      // 打断当前曲目
volatile bool s_paused = false;    // TTS / 录音让路（由 s_pause_depth 推导）
volatile bool s_wait_drain = false;// 等 TTS 尾巴播完再续
volatile bool s_playing = false;
volatile bool s_autoplay = false;
int s_pause_depth = 0;             // 允许嵌套：TTS 与录音可能同时让路

char s_req[kPathCap] = {0};
bool s_req_loop = false;
volatile bool s_pending = false;

char s_files[kMaxFiles][kPathCap];
int s_count = 0;

uint8_t* s_buf = nullptr;          // 码流
int16_t* s_pcm = nullptr;          // 解码输出（交错）
int16_t* s_mono = nullptr;         // 下混后
int16_t* s_out = nullptr;          // 重采样后
mp3dec_t s_dec;                    // 约 5–6 KB，放 .bss

double s_phase = 0.0;              // 重采样相位（相对当前帧起点）
int16_t s_prev = 0;                // 上一帧最后一个样点
int s_last_hz = 0;

void* Alloc(size_t bytes, bool spiram) {
    void* p = spiram ? heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM)
                     : heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL);
    if (!p) p = heap_caps_malloc(bytes, MALLOC_CAP_8BIT);   // 兜底
    return p;
}

bool EndsWithMp3(const char* n) {
    const size_t l = std::strlen(n);
    if (l < 4) return false;
    return n[l - 4] == '.' &&
           std::tolower((unsigned char)n[l - 3]) == 'm' &&
           std::tolower((unsigned char)n[l - 2]) == 'p' &&
           std::tolower((unsigned char)n[l - 1]) == '3';
}

void AddFile(const char* path) {
    if (s_count >= kMaxFiles) return;
    std::strncpy(s_files[s_count], path, kPathCap - 1);
    s_files[s_count][kPathCap - 1] = '\0';
    ++s_count;
}

int CmpName(const void* a, const void* b) {
    return std::strcmp(static_cast<const char*>(a), static_cast<const char*>(b));
}

void BuildList() {
    s_count = 0;

    // 1) PLAYLIST.TXT：一行一个文件（8.3 短名；FATFS 没开长文件名）
    FILE* pl = std::fopen("/sdcard/mp3/PLAYLIST.TXT", "r");
    if (pl) {
        char line[kPathCap];
        while (std::fgets(line, sizeof(line), pl)) {
            char* p = line;
            while (*p == ' ' || *p == '\t') ++p;
            char* e = p + std::strlen(p);
            while (e > p && (e[-1] == '\n' || e[-1] == '\r' || e[-1] == ' ')) *--e = '\0';
            if (!*p || *p == '#') continue;
            if (*p == '/') {
                AddFile(p);
            } else {
                char full[kPathCap];
                std::snprintf(full, sizeof(full), "/sdcard/mp3/%s", p);
                AddFile(full);
            }
        }
        std::fclose(pl);
    }
    if (s_count) {
        ESP_LOGI(TAG, "播放列表 %d 条（PLAYLIST.TXT）", s_count);
        return;
    }

    // 2) 扫目录
    DIR* d = opendir("/sdcard/mp3");
    if (!d) {
        ESP_LOGW(TAG, "没有 /sdcard/mp3 目录");
        return;
    }
    struct dirent* ent = nullptr;
    while ((ent = readdir(d)) != nullptr) {
        if (ent->d_type == DT_DIR) continue;
        if (!EndsWithMp3(ent->d_name)) continue;
        char full[kPathCap];
        std::snprintf(full, sizeof(full), "/sdcard/mp3/%s", ent->d_name);
        AddFile(full);
    }
    closedir(d);

    if (s_count > 1) {
        qsort(s_files, s_count, kPathCap, CmpName);
    }
    ESP_LOGI(TAG, "目录扫描 %d 条", s_count);
}

bool Emit(const int16_t* pcm, int n) {
    int off = 0;
    while (off < n) {
        if (s_stop) return false;
        if (s_paused) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (s_wait_drain) {
            // TTS 的尾巴还在缓冲里，等它播完再混入音乐
            if (audio::StreamBuffered() > 480) {
                vTaskDelay(pdMS_TO_TICKS(20));
                continue;
            }
            s_wait_drain = false;
        }
        const int put = audio::StreamWrite(pcm + off, n - off);
        off += put;
        if (off < n) vTaskDelay(pdMS_TO_TICKS(5));
    }
    return true;
}

struct Reader {
    FILE* f;
    size_t fill;
    size_t pos;
    bool eof;
};

bool Refill(Reader& r) {
    if (r.pos) {
        std::memmove(s_buf, s_buf + r.pos, r.fill - r.pos);
        r.fill -= r.pos;
        r.pos = 0;
    }
    if (r.fill >= kReadBuf) return false;
    const size_t n = std::fread(s_buf + r.fill, 1, kReadBuf - r.fill, r.f);
    if (n == 0) {
        r.eof = true;
        return false;
    }
    r.fill += n;
    return true;
}

// 解码一个文件（loop 时从头再来），直到 EOF 或 s_stop。
void DecodeOne(const char* path, bool loop) {
    FILE* f = std::fopen(path, "rb");
    if (!f) {
        ESP_LOGW(TAG, "打不开 %s", path);
        return;
    }
    ESP_LOGI(TAG, "play %s%s", path, loop ? "（循环）" : "");
    s_playing = true;

    for (;;) {
        Reader r{f, 0, 0, false};
        mp3dec_init(&s_dec);
        s_phase = 0.0;
        s_prev = 0;
        s_last_hz = 0;

        for (;;) {
            if (s_stop) break;
            if (r.fill - r.pos < 4096 && !r.eof) Refill(r);
            if (r.fill == r.pos) {
                if (r.eof || !Refill(r)) break;
                continue;
            }

            mp3dec_frame_info_t info = {};
            const int samples = mp3dec_decode_frame(
                &s_dec, s_buf + r.pos, static_cast<int>(r.fill - r.pos), s_pcm, &info);

            if (info.frame_bytes > 0) {
                if (static_cast<size_t>(info.frame_bytes) > r.fill - r.pos) {
                    r.pos = r.fill;          // 异常帧，别越过缓冲
                } else {
                    r.pos += static_cast<size_t>(info.frame_bytes);
                }
            }

            if (samples <= 0) {
                if (r.fill == r.pos && r.eof) break;
                if (info.frame_bytes == 0) {
                    // 没有进展：缓冲满了就丢 1 字节重新同步，否则继续补数据
                    if (r.fill - r.pos >= kReadBuf - 1) {
                        ++r.pos;
                    } else if (!Refill(r) && r.eof && r.fill == r.pos) {
                        break;
                    }
                }
                continue;
            }

            const int ch = info.channels > 1 ? 2 : 1;
            for (int i = 0; i < samples; ++i) {
                if (ch == 2) {
                    s_mono[i] = static_cast<int16_t>(
                        (static_cast<int>(s_pcm[2 * i]) + s_pcm[2 * i + 1]) / 2);
                } else {
                    s_mono[i] = s_pcm[i];
                }
            }

            if (info.hz != s_last_hz) {
                s_last_hz = info.hz > 0 ? info.hz : kOutRate;
                s_phase = 0.0;
                s_prev = s_mono[0];
            }
            const double step = static_cast<double>(s_last_hz) / kOutRate;

            int n = 0;
            double pos = s_phase;
            while (pos < samples - 1 && n < static_cast<int>(kOutCap)) {
                const int i = static_cast<int>(pos);
                const double fr = pos - i;
                const int a = (i < 0) ? s_prev : s_mono[i];
                const int b = s_mono[i + 1];
                s_out[n++] = static_cast<int16_t>(a + (b - a) * fr);
                pos += step;
            }
            s_phase = pos - samples;
            s_prev = s_mono[samples - 1];

            if (n > 0 && !Emit(s_out, n)) break;
        }

        if (s_stop || !loop) break;
        if (std::fseek(f, 0, SEEK_SET) != 0) break;
    }

    std::fclose(f);
    s_playing = false;
}

void Task(void*) {
    for (;;) {
        bool have = false;
        char path[kPathCap];
        bool loop = false;

        if (s_mx && xSemaphoreTake(s_mx, portMAX_DELAY) == pdTRUE) {
            if (s_pending) {
                std::memcpy(path, s_req, sizeof(path));
                loop = s_req_loop;
                s_pending = false;
                have = true;
            }
            xSemaphoreGive(s_mx);
        }

        if (!have && s_autoplay && s_count > 0) {
            static int idx = 0;
            std::memcpy(path, s_files[idx], sizeof(path));
            idx = (idx + 1) % s_count;
            have = true;
        }

        if (!have) {
            xSemaphoreTake(s_wake, portMAX_DELAY);
            continue;
        }

        s_stop = false;
        DecodeOne(path, loop);
    }
}

}  // namespace

bool Init() {
    if (s_wake) return true;

    s_buf = static_cast<uint8_t*>(Alloc(kReadBuf, true));
    s_pcm = static_cast<int16_t*>(Alloc(MINIMP3_MAX_SAMPLES_PER_FRAME * sizeof(int16_t), false));
    s_mono = static_cast<int16_t*>(Alloc(1152 * sizeof(int16_t), false));
    s_out = static_cast<int16_t*>(Alloc(kOutCap * sizeof(int16_t), false));

    s_wake = xSemaphoreCreateBinary();
    s_mx = xSemaphoreCreateMutex();
    if (!s_buf || !s_pcm || !s_mono || !s_out || !s_wake || !s_mx) {
        ESP_LOGE(TAG, "播放器缓冲申请失败（buf=%p）", s_buf);
        return false;
    }

    if (xTaskCreate(Task, "mp3", kTaskStack, nullptr, kTaskPrio, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "播放任务创建失败");
        return false;
    }
    ESP_LOGI(TAG, "就绪（minimp3 → 24 kHz mono）");
    return true;
}

bool Play(const char* path, bool loop) {
    if (!path || !path[0] || !s_mx) return false;
    if (!storage::Ready()) {
        ESP_LOGW(TAG, "没有 SD 卡");
        return false;
    }
    if (xSemaphoreTake(s_mx, pdMS_TO_TICKS(100)) != pdTRUE) return false;
    std::strncpy(s_req, path, kPathCap - 1);
    s_req[kPathCap - 1] = '\0';
    s_req_loop = loop;
    s_pending = true;
    s_autoplay = false;
    s_stop = true;
    xSemaphoreGive(s_mx);
    xSemaphoreGive(s_wake);
    return true;
}

void Stop() {
    s_autoplay = false;
    s_pending = false;
    s_stop = true;
}

void Pause() {
    bool first = false;
    if (s_mx && xSemaphoreTake(s_mx, pdMS_TO_TICKS(50)) == pdTRUE) {
        if (s_pause_depth == 0) {
            s_pause_depth = 1;
            first = true;
        } else if (s_pause_depth < 8) {
            ++s_pause_depth;
        }
        s_paused = true;
        xSemaphoreGive(s_mx);
    }
    if (first) {
        s_wait_drain = false;
        audio::StreamClear();      // 音乐已经排队的部分立刻扔掉
    }
}

void Resume() {
    bool last = false;
    if (s_mx && xSemaphoreTake(s_mx, pdMS_TO_TICKS(50)) == pdTRUE) {
        if (s_pause_depth > 0 && --s_pause_depth == 0) {
            s_paused = false;
            last = true;
        }
        xSemaphoreGive(s_mx);
    }
    if (last) s_wait_drain = true; // 等 TTS 尾巴播完
}

bool IsPlaying() { return s_playing; }

void Autoplay() {
    if (!storage::Ready()) {
        ESP_LOGW(TAG, "SD 没挂上，跳过自动播放");
        return;
    }
    BuildList();
    if (s_count == 0) {
        ESP_LOGI(TAG, "/sdcard/mp3 里没有 MP3");
        return;
    }
    ESP_LOGI(TAG, "自动播放 %d 条，循环", s_count);
    s_stop = false;
    s_autoplay = true;
    xSemaphoreGive(s_wake);
}

}  // namespace mp3
