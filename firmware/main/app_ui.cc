#include "app_ui.h"

#include <cstdio>
#include <cstring>

#include "audio.h"
#include "clip_player.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "input.h"
#include "proto.h"
#include "render.h"
#include "sensecap-watcher.h"
#include "ws_client.h"
#include "led.h"
#include "camera.h"

namespace app_ui {
namespace {

constexpr const char* TAG = "ui2";
constexpr int kRate = 24000;
constexpr int kMaxSec = 10;
constexpr int kMenuCount = 4;
const char* kMenu[kMenuCount] = {"音量", "配网", "电量", "关机"};

enum State { kIdle, kRec, kSend };
State s_state = kIdle;
int s_volume = 70;
bool s_menu = false;
int s_menu_sel = 0;
int64_t s_menu_t = 0;
int64_t s_rec_t = 0;
int16_t* s_buf = nullptr;
int s_cap = 0;          // 采样容量
int s_got = 0;          // 已录采样
int s_seq = 0;
int64_t s_speak_until = 0;   // >0 表示说话态，到点回待机
int64_t s_text_until = 0;
// 下行 TTS 累积缓冲：Breeze 是流式（几十~几千字节的小帧），必须攒到 audio_end 再放

int s_rx_got = 0;
bool s_drain_wait = false;
// 首尾静音垫：PA 唤醒约需 60~100 ms，收尾 DMA 尾部也会被切 —— 两头各垫一点
constexpr int kPadHead = 24000 * 120 / 1000;   // 120 ms
constexpr int kPadTail = 24000 * 180 / 1000;   // 180 ms
int16_t* s_pad = nullptr;   // 音频已收完，等环形缓冲播空
int s_rx_declared = 0;   // 头里声明的总字节数（对账用）
int s_rx_total = 0;      // 本次实际收到的字节数    // >0 表示屏幕有小对话框，到点自动消失
constexpr int64_t kTextMs = 5000;   // 小对话框显示时长

void ShowText(const char* a, const char* b = nullptr) {
    static char s[768];   // 静态：ws 回调栈只有 5 KB，这里不能再占 768
    if (b) { if (std::strlen(b) > 200) return; }
    if (b) std::snprintf(s, sizeof(s), "%s %s", a, b);
    else std::snprintf(s, sizeof(s), "%s", a);
    render::SetText(s);
    s_text_until = esp_timer_get_time() + kTextMs * 1000;   // 5 秒后自动消失
}

void DrawMenu() {
    char s[64];
    std::snprintf(s, sizeof(s), "> %s", kMenu[s_menu_sel]);
    render::SetText(s);
    s_menu_t = esp_timer_get_time();
}

void RecTask(void*) {
    for (;;) {
        if (s_state == kRec) {
            const int room = s_cap - s_got;
            const int chunk = room > 2400 ? 2400 : room;
            if (chunk <= 0) {
                ESP_LOGW(TAG, "录满 %d 采样，自动停止", s_got);
                // 交给主逻辑停：置状态，由 TickTask 处理上行
                s_state = kSend;
            } else {
                const int n = audio::Record(s_buf + s_got, chunk);
                if (n > 0) s_got += n;
                if (esp_timer_get_time() - s_rec_t > (int64_t)kMaxSec * 1000000) {
                    ESP_LOGW(TAG, "到 %d 秒上限，自动停止", kMaxSec);
                    s_state = kSend;
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void StopRecAndSend() {
    s_state = kSend;
}

void TickTask(void*) {
    for (;;) {
        const int64_t now = esp_timer_get_time();
        if (s_menu && now - s_menu_t > 8000000) {   // 菜单 8 秒超时
            s_menu = false;
            ShowText("待机");
            render::SetMood(proto::Mood::Idle);
        }
        if (s_text_until && now > s_text_until) {
            s_text_until = 0;
            if (s_state == kIdle && !s_menu) render::SetText("");   // 录音中/菜单里不清
        }
        if (s_drain_wait) {
            if (audio::StreamBuffered() < 480) {          // 播完了
                s_drain_wait = false;
                s_speak_until = now + 5000000;            // 从这一刻起 5 秒后关窗熄灯
            }
        }
        if (s_speak_until && now > s_speak_until) {
            s_speak_until = 0;
            led::Set(led::kIdle);            // 熄灯
            render::SetMood(proto::Mood::Idle);
            render::SetText("");             // 关窗（不写"待机"，保持纯净）
            s_text_until = 0;
        }
        {
            // hello 必须"每次连上都发"：它的 fw/ver/cam 是桥认身份、建会话的依据。
            // v2 早期用 `static bool hello_sent` 只发一次 → 桥一重启，设备重连却不再报身份，
            // 表现为 online=true 但 fw/ver 全空、大脑会话没建（2026-10-31 实测）。
            static bool was_connected = false;
            const bool now_connected = ws::Connected();
            if (now_connected && !was_connected) {
                const char* h = "{\"t\":\"hello\",\"fw\":\"hub_v2\",\"board\":\"watcher\",\"ver\":\"0.2\",\"cam\":1,\"w\":240,\"h\":240}";
                ws::SendText(h, std::strlen(h));
                ESP_LOGW(TAG, "已发 hello");
            }
            was_connected = now_connected;
        }
        if (s_state == kSend) {
            ESP_LOGW(TAG, "录音结束：%d 采样（%.2f 秒）→ 上行（WS 待接，先本地回放验证）",
                     s_got, s_got / (double)kRate);
            ShowText("上报中");
            led::Set(led::kThink);
            render::SetMood(proto::Mood::Think);
            if (s_got > 0) {
                const size_t bytes = (size_t)s_got * 2;
                if (ws::Connected()) {
                    char h[160];
                    const size_t hn = proto::BuildVoice(h, sizeof(h), (int)bytes, ++s_seq);
                    bool ok = ws::SendText(h, hn);
                    const uint8_t* p = (const uint8_t*)s_buf;
                    size_t off = 0;
                    while (ok && off < bytes) {
                        const size_t n = (bytes - off) > 16384 ? 16384 : (bytes - off);
                        ok = ws::SendBinary(p + off, n);
                        off += n;
                    }
                    ESP_LOGW(TAG, "上行 %u 字节（seq=%d）%s", (unsigned)bytes, s_seq, ok ? "成功" : "中断");
                } else {
                    ESP_LOGW(TAG, "桥未连接，本地回放代替");
                    audio::Play(s_buf, s_got);
                }
            }
            // 注意：这里**不**回到待机灯 —— 停在"思考(蓝)"，等下行音频回来再变绿/待机
            if (!ws::Connected()) led::Set(led::kError);
            render::SetMood(proto::Mood::Think);
            s_got = 0;
            s_state = kIdle;
        }
        vTaskDelay(pdMS_TO_TICKS(30));
    }
}

void OnClick() {
    if (s_menu) {                                  // 菜单里：执行
        const int sel = s_menu_sel;
        s_menu = false;
        switch (sel) {
            case 0: ShowText("音量"); break;
            case 1: ShowText("配网稍后"); break;
            case 2: {
                char b[48];
                std::snprintf(b, sizeof(b), "电量 %d%%", (int)bsp_battery_get_percent());
                ShowText(b);
                break;
            }
            case 3: ESP_LOGW(TAG, "关机"); bsp_system_shutdown(); break;
        }
        render::SetMood(proto::Mood::Idle);
        return;
    }
    if (s_state == kIdle) {                        // 开始录音
        s_got = 0;
        s_rec_t = esp_timer_get_time();
        s_state = kRec;
        // 2026-10-31：取消"说话时顺带拍一张"。它会在每次对话时产生一张图，
        // 既占空间又没人清理；视觉上下文改成需要时由桥显式 shot。
        led::Set(led::kListen);
        render::SetMood(proto::Mood::Listen);
        ShowText("录音中");
        ESP_LOGW(TAG, "开始录音");
    } else if (s_state == kRec) {                  // 停止并上报
        StopRecAndSend();
        ESP_LOGW(TAG, "停止录音");
    }
}

void OnLong() {
    if (s_state == kRec) {                         // 录音中长按 = 取消
        s_state = kIdle;
        s_got = 0;
        render::SetMood(proto::Mood::Idle);
        ShowText("已取消");
        ESP_LOGW(TAG, "录音取消");
        return;
    }
    if (s_menu) {                                  // 菜单里长按 = 退出
        s_menu = false;
        render::SetMood(proto::Mood::Idle);
        ShowText("待机");
        return;
    }
    s_menu = true;                                 // 打开菜单
    s_menu_sel = 0;
    DrawMenu();
    render::SetMood(proto::Mood::Think);
    ESP_LOGW(TAG, "打开菜单");
}

void OnTurn(int d) {
    if (s_menu) {                                  // 菜单选择
        s_menu_sel = (s_menu_sel + d + kMenuCount) % kMenuCount;
        DrawMenu();
        return;
    }
    if (s_state != kIdle) return;                  // 录音中忽略
    s_volume += d * 5;                             // 音量
    if (s_volume < 0) s_volume = 0;
    if (s_volume > 100) s_volume = 100;
    audio::Volume(s_volume);
    char b[32];
    std::snprintf(b, sizeof(b), "音量 %d%%", s_volume);
    ShowText(b);
    ESP_LOGI(TAG, "音量 %d%%", s_volume);
}

}  // namespace

void Init() {
    s_cap = kRate * kMaxSec;
    s_buf = (int16_t*)heap_caps_malloc((size_t)s_cap * 2, MALLOC_CAP_SPIRAM);
    if (!s_buf) { ESP_LOGE(TAG, "录音缓冲申请失败"); s_cap = 0; }
    ws::SetTextHandler([](const char* t, size_t n) {
        // 栈预算：ws 任务只有 5 KB，Downlink(~1.1KB) + buf 必须静态
        static char buf[560];
        static proto::Downlink dl;
        const size_t k = n < sizeof(buf) - 1 ? n : sizeof(buf) - 1;
        std::memcpy(buf, t, k);
        buf[k] = 0;
        ESP_LOGI(TAG, "下行文本(%u): %.60s", (unsigned)n, buf);

        if (std::strstr(buf, "\"welcome\"")) { ESP_LOGI(TAG, "welcome（忽略）"); return; }
        if (std::strstr(buf, "\"shot\"")) { camera::Shoot(); ESP_LOGW(TAG, "下行要求拍照"); return; }
        if (std::strstr(buf, "\"ping\"")) { ws::SendText("{\"t\":\"pong\"}", 12); return; }

        if (!proto::Parse(buf, k, &dl)) { ESP_LOGW(TAG, "解析失败"); return; }
        if (dl.kind == proto::Downlink::Say && dl.text[0]) {
            ShowText(dl.text);
            render::SetMood(dl.mood);
            led::Set(led::kSpeak);
            s_speak_until = 0;   // 等音频播完再计时
        } else if (dl.kind == proto::Downlink::Face) {
            render::SetMood(dl.mood);
        } else if (dl.kind == proto::Downlink::Audio) {
            s_rx_declared = dl.audio_bytes;
            s_rx_total = 0;
            ESP_LOGI(TAG, "音频头：声明 %d 字节", s_rx_declared);
            if (s_pad) audio::StreamWrite(s_pad, kPadHead);   // 垫字头
        } else if (dl.kind == proto::Downlink::AudioEnd) {
            ESP_LOGW(TAG, "音频收尾：实收 %d / 声明 %d 字节%s", s_rx_total, s_rx_declared,
                     (s_rx_declared > 0 && s_rx_total < s_rx_declared) ? "（丢帧！）" : "");
            ESP_LOGW(TAG, "音频结束，缓冲积压 %d 采样", audio::StreamBuffered());
            if (s_pad) audio::StreamWrite(s_pad, kPadTail);   // 垫字尾
            s_drain_wait = true;
            ESP_LOGW(TAG, "TTS 一段播放完毕");
            // 熄灯/表情交给 TickTask 的排空门禁
            // 熄灯/表情交给 TickTask 的排空门禁
        } else {
            ESP_LOGI(TAG, "其它下行 kind=%d", (int)dl.kind);
        }
    });
    ws::SetBinaryHandler([](const uint8_t* p, size_t n) {
        static int s_frames = 0;
        ++s_frames;
        // 防御：桥只应发偶数字节（int16 采样）。奇数帧会让后续所有采样错位一个字节，
        // 听感是满耳噪声（2026-10-31 实测：Breeze 流式 121 块里 72 块是奇数）。
        // 桥已修（makeEvenSink），这里再兜一层：丢掉尾字节，只告警一次。
        static bool s_warned_odd = false;
        if (n & 1) {
            if (!s_warned_odd) {
                s_warned_odd = true;
                ESP_LOGW(TAG, "收到奇数字节帧 %u B（已丢弃尾字节，避免整段错位）", (unsigned)n);
            }
            --n;
        }
        s_rx_total += (int)n;
        // 入环形缓冲（非阻塞）：WS 任务必须继续收包，否则溢出断连。
        // HUB_AUDIO_PROBE=1 时逐帧打日志（帧间隔/入队耗时/缓冲余量），用来分辨
        // "包到得慢"还是"设备处理慢"；量产默认关闭，避免串口被刷屏（2026-10-31）。
        {
#if defined(HUB_AUDIO_PROBE) && HUB_AUDIO_PROBE
            static int64_t s_prev = 0;
            static int64_t s_sum = 0;
            const int64_t t0 = esp_timer_get_time();
            const int put = audio::StreamWrite((const int16_t*)p, (int)(n / 2));
            const int64_t took = esp_timer_get_time() - t0;
            s_sum += took;
            const int64_t gap = s_prev ? (t0 - s_prev) / 1000 : 0;
            s_prev = esp_timer_get_time();
            if (put < (int)(n / 2)) {
                ESP_LOGW(TAG, "环形缓冲满：入队 %d/%u 字节（帧 #%d）", put * 2, (unsigned)n, s_frames);
            }
            ESP_LOGW(TAG, "帧#%d %u B 间隔 %lld ms 入队 %lld us 累积 %lld ms 缓冲 %d 采样",
                     s_frames, (unsigned)n, (long long)gap, (long long)(took / 1000),
                     (long long)(s_sum / 1000), audio::StreamBuffered());
#else
            const int put = audio::StreamWrite((const int16_t*)p, (int)(n / 2));
            if (put < (int)(n / 2)) {
                ESP_LOGW(TAG, "环形缓冲满：入队 %d/%u 字节（帧 #%d）", put * 2, (unsigned)n, s_frames);
            }
#endif
            if (s_frames == 1) led::Set(led::kSpeak);
        }
    });
    // 相机取到 JPEG 后立刻上行：{"t":"image",...} + 二进制分块
    camera::SetImageHandler([](const uint8_t* jpg, int len) {
        static int s_img_seq = 0;
        if (!ws::Connected()) { ESP_LOGW(TAG, "图像 %d 字节：桥未连接，丢弃", len); return; }
        char h[160];
        std::snprintf(h, sizeof(h),
                      "{\"t\":\"image\",\"bytes\":%d,\"w\":240,\"h\":240,\"seq\":%d}",
                      len, ++s_img_seq);
        bool ok = ws::SendText(h, std::strlen(h));
        int off = 0;
        while (ok && off < len) {
            const int n = (len - off) > 16384 ? 16384 : (len - off);
            ok = ws::SendBinary(jpg + off, (size_t)n);
            off += n;
        }
        ESP_LOGW(TAG, "图像上行 %d 字节（seq=%d）%s", len, s_img_seq, ok ? "成功" : "中断");
    });
    input::OnPress(OnClick);
    input::OnLongPress(OnLong);
    input::OnTurn(OnTurn);
    xTaskCreate(RecTask, "rec", 4096, nullptr, 5, nullptr);
    s_pad = (int16_t*)heap_caps_calloc(1, (size_t)kPadHead * 2, MALLOC_CAP_SPIRAM);
    audio::StreamInit();
    led::Init();
    xTaskCreate(TickTask, "uist", 3072, nullptr, 3, nullptr);
    ShowText("待机");
    ESP_LOGW(TAG, "交互就绪：单击=录音开关 长按=菜单 旋钮=音量/选择");
}

}  // namespace app_ui