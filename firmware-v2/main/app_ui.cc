#include "app_ui.h"

#include <cstdio>
#include <cstring>

#include "adpcm.h"
#include "audio.h"
#include "audio_dec.h"
#include "clip_player.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "input.h"
#include "link.h"
#include "proto.h"
#include "render.h"
#include "sensecap-watcher.h"
#include "led.h"
#include "camera.h"
#include "mp3_player.h"
#include "pet_voice.h"
#include "touch_input.h"

namespace app_ui {
namespace {

constexpr const char* TAG = "ui2";
constexpr int kRate = 24000;
constexpr int kMaxSec = 10;
constexpr int kMenuCount = 4;
const char* kMenu[kMenuCount] = {"音量", "蓝牙", "电量", "关机"};

enum State { kIdle, kRec, kSend };
State s_state = kIdle;
int s_volume = 70;
bool s_menu = false;
int s_menu_sel = 0;
int64_t s_menu_t = 0;

// ---- 音量模式（2026-11-03：旋钮让位给"摸摸头"，音量改从菜单进入）----
bool s_volume_mode = false;
int64_t s_volume_t = 0;

// ---- 摸摸头（2026-11-03）：菜单关闭时旋钮滚动 = 抚摸；随机挑一段互动动画 ----
// 手势：方向反转（来回搓）累计 ≥2 格，或连续单向 ≥8 格（快速搓）触发；
// 冷却 2.2s，避免每个格都触发；一次反应播 2.4–3.6s。
constexpr int64_t kPetGestureGapUs = 900000;   // 两格间隔超过 0.9s 就重新计手势
constexpr int kPetTurnsReversal = 2;           // 反向 + 累计 2 格
constexpr int kPetTurnsSpin = 8;               // 连续单向 8 格
constexpr int64_t kPetCooldownUs = 2200000;    // 反应冷却
constexpr int kPetMinMs = 2400;
constexpr int kPetMaxMs = 3600;
// 2026-11-05：原台词（好舒服/再摸摸/唔痒/最喜欢啦）带出门会被侧目；换公共场合安全的短句
const char* kPetLines[] = {"嘿嘿", "在呢", "嗯？", "好耶", "谢谢"};
constexpr int kPetLineCount = sizeof(kPetLines) / sizeof(kPetLines[0]);
int s_pet_turns = 0;
int s_pet_dir = 0;
int s_pet_reversals = 0;
int64_t s_pet_last_us = 0;
int64_t s_pet_next_us = 0;
int64_t s_pet_until = 0;
int s_pet_last = -1;      // clip_player::Id，避免连续抽到同一条
int s_pet_count = 0;      // 累计触发次数（日志/调试）
bool s_pet_text = false;  // 当前字幕是否是"摸摸头"反应；后续其他文字会把它清掉

// ---- 触摸手势（2026-11-04）：触摸任务只置事件，UI 任务统一处理 ----
// 1=单击(摸摸头) 2=双击(再来一次) 3=长按(菜单) 4=滑动(音量，dy>0 减)
volatile int s_touch_evt = 0;
volatile int s_touch_x = 0, s_touch_y = 0, s_touch_dx = 0, s_touch_dy = 0;
void HandleTouch(int evt, int x, int y, int dx, int dy);
void CyclePet(int dir, int64_t now);
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
constexpr int kPadSamples = kPadHead > kPadTail ? kPadHead : kPadTail;
int16_t* s_pad = nullptr;   // 音频已收完，等环形缓冲播空
int s_rx_declared = 0;   // 头里声明的总字节数（对账用）
int s_rx_total = 0;      // 本次实际收到的字节数    // >0 表示屏幕有小对话框，到点自动消失
constexpr int64_t kTextMs = 5000;   // 小对话框显示时长
// 2026-11-02 审计 FW-09：桥只发 say 不发 audio（tts 关闭 / 合成失败）时，
// 之前 LED 与表情会永久停在"说话"；这里给一个兜底复位窗口。
constexpr int64_t kSayNoAudioMs = 10000;
int64_t s_say_at = 0;          // 最近一次 say 的时刻（0 = 没有待配对的 say）
int s_audio_seq = -1;          // 当前音频会话 seq（FW-08：配对/对账用）
bool s_audio_active = false;   // 本段音频是否已暂停 mp3（FW-07：保证 Pause/Resume 1:1）
// 下行音频编码（由 audio 头决定；无 codec 字段 = pcm）。二进制帧按它分流。
proto::Codec s_codec = proto::Codec::Pcm;
bool s_opus_ok = false;        // 解码器是否可用（audio_dec::Init 结果；hello 据此上报能力）
int s_opus_pkts = 0;           // 本段已收到的 Opus 包数（日志/对账用）
// ADPCM（BLE 链路 §6）：上行编码缓冲放 PSRAM（10 s ≈ 120 KB）；下行由 audio_dec 解。
uint8_t* s_adpcm_buf = nullptr;   // 上行 ADPCM 编码输出（PSRAM）
size_t s_adpcm_cap = 0;
int s_adpcm_rx_bytes = 0;         // 本段下行 ADPCM 字节数（对账/日志）
volatile bool s_welcome_seen = false;      // 本次链路是否收到 welcome（hello 重发门禁用）
// 手机刚订阅上 UP 通知：上一轮 hello 很可能发在订阅之前（丢包），置位后 UI 任务立刻重发。
volatile bool s_force_hello = false;
volatile bool s_uploading = false;  // 语音上行任务是否在跑（FW-04：UI 任务不阻塞）

void ShowText(const char* a, const char* b = nullptr) {
    static char s[768];   // 静态：ws 回调栈只有 5 KB，这里不能再占 768
    if (b) { if (std::strlen(b) > 200) return; }
    if (b) std::snprintf(s, sizeof(s), "%s %s", a, b);
    else std::snprintf(s, sizeof(s), "%s", a);
    render::SetText(s);
    s_text_until = esp_timer_get_time() + kTextMs * 1000;   // 5 秒后自动消失
    s_pet_text = false;   // 任何新文字都接管字幕；摸摸头收尾时不再清它
}

void DrawMenu() {
    char s[64];
    std::snprintf(s, sizeof(s), "> %s", kMenu[s_menu_sel]);
    render::SetText(s);
    s_menu_t = esp_timer_get_time();
}

// ---- 摸摸头：判定 + 随机反应 ------------------------------------------------
// 只在"真待机"时允许：不在录音/上行/菜单/音量模式/放系统语音/说话态。
bool PettingAllowed(int64_t now) {
    if (s_state != kIdle || s_menu || s_volume_mode || s_uploading) return false;
    if (s_audio_active || s_drain_wait) return false;
    if (s_speak_until && now < s_speak_until) return false;
    return true;
}

void TriggerPet(int64_t now) {
    if (now < s_pet_next_us) return;

    // 候选：固件里已有的互动动画。避免连续同一条；都不可用就放弃（不画错帧）。
    static const clip_player::Id kCand[] = {clip_player::kHappy, clip_player::kTickle,
                                            clip_player::kShy, clip_player::kWave};
    clip_player::Id pool[4];
    int n = 0;
    for (clip_player::Id id : kCand) {
        if (clip_player::Ready(id) && (int)id != s_pet_last) pool[n++] = id;
    }
    if (n == 0) {
        for (clip_player::Id id : kCand) {
            if (clip_player::Ready(id)) pool[n++] = id;
        }
    }
    if (n == 0) return;

    const clip_player::Id id = pool[esp_random() % (uint32_t)n];
    const int ms = kPetMinMs + (int)(esp_random() % (uint32_t)(kPetMaxMs - kPetMinMs));
    render::PlayClip((int)id, ms);                 // 覆盖角色动作，到点自动回 mood
    pet_voice::PlayForClip((int)id);               // 本地短音效（不阻塞 UI）
    render::SetMood(proto::Mood::Happy);           // 灯/表情偏"开心"
    led::Set(led::kSpeak);
    ShowText(kPetLines[esp_random() % (uint32_t)kPetLineCount]);
    s_pet_text = true;   // ShowText 会清标志，这里再置回：本句属于摸摸头

    s_pet_until = now + (int64_t)ms * 1000;
    s_pet_last = (int)id;
    s_pet_next_us = now + kPetCooldownUs;
    ++s_pet_count;
    ESP_LOGW(TAG, "摸摸头 #%d：clip=%d %dms（%d 段可选）", s_pet_count, (int)id, ms, n);
}

// 一格的旋钮增量 → 手势累积。普通慢慢转不会触发（避免误触）。
void PetFeed(int d, int64_t now) {
    if (d == 0 || !PettingAllowed(now)) return;
    if (s_pet_last_us && now - s_pet_last_us > kPetGestureGapUs) {
        s_pet_turns = 0;
        s_pet_reversals = 0;
        s_pet_dir = 0;
    }
    const int dir = d > 0 ? 1 : -1;
    if (s_pet_dir != 0 && dir != s_pet_dir) ++s_pet_reversals;
    s_pet_dir = dir;
    s_pet_turns += d > 0 ? d : -d;
    s_pet_last_us = now;

    const bool gesture =
        (s_pet_reversals >= 1 && s_pet_turns >= kPetTurnsReversal) || s_pet_turns >= kPetTurnsSpin;
    if (!gesture) return;
    s_pet_turns = 0;
    s_pet_reversals = 0;
    s_pet_dir = 0;
    TriggerPet(now);
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

// ---- 语音上行：独立一次性任务（FW-04）----
// 原实现直接在 TickTask 里同步发 480 KB：按实测链路 21–59 KB/s 要 8–23 s，
// 期间菜单/字幕超时/按键全停摆，状态还卡在 kSend（看起来像死机）。
// 现在 UI 只投递：s_state 保持 kSend 直到任务结束，s_buf/s_got 不会被复用。
void UploadTask(void*) {
    const int samples = s_got;
    bool ok = false;
    const char* codec = link::UplinkCodec();
    const bool use_adpcm = (std::strcmp(codec, "adpcm") == 0);
    if (samples > 0 && use_adpcm) {
        // BLE 链路：IMA ADPCM（12 KB/s，替代 48 KB/s 裸 PCM）
        const size_t cap = adpcm::EncodedSizeForSamples(samples);
        if (!s_adpcm_buf || cap == 0 || cap > s_adpcm_cap || cap > size_t(adpcm::kVoiceMaxBytes)) {
            ESP_LOGE(TAG, "ADPCM 上行缓冲不足（需要 %u，已备 %u）→ 本段放弃", unsigned(cap),
                     unsigned(s_adpcm_cap));
        } else {
            const size_t enc = adpcm::EncodePcm(s_buf, samples, s_adpcm_buf, s_adpcm_cap);
            if (enc == 0) {
                ESP_LOGE(TAG, "ADPCM 编码失败（%d 采样）", samples);
            } else {
                char h[192];
                const size_t hn =
                    proto::BuildVoice(h, sizeof(h), (int)enc, ++s_seq, "adpcm", samples);
                ok = link::Connected() && link::SendText(h, hn);
                size_t off = 0;
                while (ok && off < enc) {
                    const size_t n = (enc - off) > 16384 ? 16384 : (enc - off);
                    if (link::Active() == link::Kind::Ble) {
                        // 背压：BLE TX 环 32 KB，等降到半空再入队 —— 否则队列满会"丢最旧"，
                        // 10 s 语音（~120 KB）就会丢掉中间几段，变成断续噪音。
                        for (int i = 0; i < 800 && link::Connected() && link::TxQueuedBytes() > 16384; ++i) {
                            vTaskDelay(pdMS_TO_TICKS(5));
                        }
                    }
                    ok = link::SendBinary(s_adpcm_buf + off, n);
                    off += n;
                }
                ESP_LOGW(TAG, "上行 ADPCM：%d 采样 → %u 字节（seq=%d）%s", samples, unsigned(enc), s_seq,
                         ok ? "成功" : "中断");
            }
        }
    } else if (samples > 0) {
        // 旧 PCM 路径（兼容保留；BLE 上默认 AD PCM）
        const size_t bytes = (size_t)samples * 2;
        char h[160];
        const size_t hn = proto::BuildVoice(h, sizeof(h), (int)bytes, ++s_seq, "pcm", samples);
        ok = link::Connected() && link::SendText(h, hn);
        const uint8_t* p = (const uint8_t*)s_buf;
        size_t off = 0;
        while (ok && off < bytes) {
            const size_t n = (bytes - off) > 16384 ? 16384 : (bytes - off);
            ok = link::SendBinary(p + off, n);
            off += n;
        }
        ESP_LOGW(TAG, "上行 %u 字节（seq=%d）%s", (unsigned)bytes, s_seq, ok ? "成功" : "中断");
    }
    s_got = 0;
    s_uploading = false;
    s_state = kIdle;
    if (!link::Connected()) led::Set(led::kError);
    render::SetMood(proto::Mood::Think);
    mp3::Resume();                                 // 录完把音乐放回来（TTS 会再让一次路）
    vTaskDelete(nullptr);
}

// ---- 按需拍照：WS 收包任务里 vTaskDelay(1500) 会堵住收包（FW-03）----
void ShotTask(void*) {
    camera::Shoot();
    vTaskDelete(nullptr);
}
void RequestShot() {
    if (xTaskCreate(ShotTask, "shot", 5120, nullptr, 4, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "拍照任务创建失败（内部堆不足？）");
    }
}

void TickTask(void*) {
    for (;;) {
        const int64_t now = esp_timer_get_time();
        // 触摸手势事件（触摸任务置标志，这里统一处理，避免跨任务改 UI 状态）
        {
            const int evt = s_touch_evt;
            if (evt) {
                s_touch_evt = 0;
                HandleTouch(evt, s_touch_x, s_touch_y, s_touch_dx, s_touch_dy);
            }
        }
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
            // hello 必须"每次（重新）连上都发"：它的 fw/ver/cam 是桥认身份、建会话的依据。
            // v2 早期用 `static bool hello_sent` 只发一次 → 桥一重启，设备重连却不再报身份，
            // 表现为 online=true 但 fw/ver 全空、大脑会话没建（2026-10-31 实测）。
            // 2026-11-13（BLE）：链路（重新）建立都发 hello；10 s 没收到 welcome → 重发
            // （最多 3 次），仍没有 → 主动断开重连。
            static link::Kind last_kind = link::Kind::None;
            static int hello_tries = 0;
            static int64_t last_hello_us = 0;
            const link::Kind kind = link::Active();
            // 手机刚订阅上通知（此前 hello 丢了）：清零重发计数，让下面的 first 分支立刻补发。
            if (s_force_hello) {
                s_force_hello = false;
                hello_tries = 0;
                last_hello_us = 0;
            }
            if (kind != last_kind) {
                last_kind = kind;
                hello_tries = 0;
                last_hello_us = 0;
                s_welcome_seen = false;
                if (kind == link::Kind::Ble) {
                    const link::Stats lk = link::Get();
                    ESP_LOGW(TAG, "蓝牙链路已建立：name=%s mtu=%d", lk.name, lk.mtu);
                    char b[48];
                    std::snprintf(b, sizeof(b), "蓝牙已连接 mtu %d", lk.mtu);
                    ShowText(b);
                    led::Set(led::kIdle);
                    render::SetMood(proto::Mood::Idle);
                } else {
                    ESP_LOGW(TAG, "链路断开（等待重连）");
                    ShowText("蓝牙已断开", "重新打开手机 App 的鲸鲸蓝牙");
                }
            }
            if (kind != link::Kind::None) {
                const bool first = (hello_tries == 0);
                const bool retry = (!s_welcome_seen && hello_tries > 0 && hello_tries < 3 &&
                                    now - last_hello_us > 10000000);
                if (first || retry) {
                    const link::Stats lk = link::Get();
                    proto::HelloInfo hi;
                    hi.opus_available = s_opus_ok;
                    hi.transport = proto::Transport::Ble;
                    hi.uplink = link::UplinkCodec();
                    hi.mtu = lk.mtu;
                    hi.name = lk.name;
                    char h[320];
                    const size_t hn = proto::BuildHello(h, sizeof(h), hi);
                    if (hn == 0) {
                        ESP_LOGE(TAG, "hello 组帧失败（缓冲 %u B 不够？）", (unsigned)sizeof(h));
                    } else if (!link::SendText(h, hn)) {
                        ESP_LOGW(TAG, "hello 发送失败（连接刚断？下次连上再发）");
                    } else {
                        ++hello_tries;
                        last_hello_us = now;
                        ESP_LOGW(TAG, "已发 hello #%d（transport=%s uplink=%s mtu=%d codecs=%s）",
                                 hello_tries, proto::TransportName(hi.transport), hi.uplink, hi.mtu,
                                 s_opus_ok ? "pcm+adpcm+opus" : "pcm+adpcm");
                    }
                } else if (!s_welcome_seen && hello_tries >= 3 && now - last_hello_us > 2000000) {
                    ESP_LOGE(TAG, "hello 发了 %d 次仍没收到 welcome：断开重连", hello_tries);
                    hello_tries = 0;
                    last_hello_us = 0;
                    s_welcome_seen = false;
                    link::Reconnect();
                }
            }
        }
        // say 之后迟迟没有 audio（桥 tts 关闭 / 合成失败）：兜底复位，别让灯和表情卡死（FW-09）
        if (s_say_at && !s_audio_active && !s_drain_wait && now - s_say_at > kSayNoAudioMs * 1000) {
            ESP_LOGW(TAG, "say 后 %lld ms 没有音频，复位待机", (long long)((now - s_say_at) / 1000));
            s_say_at = 0;
            led::Set(led::kIdle);
            render::SetMood(proto::Mood::Idle);
        }
        // 音量模式 8s 无操作自动退出（2026-11-03：旋钮让位给摸摸头后新增的模式）
        if (s_volume_mode && now - s_volume_t > 8000000) {
            s_volume_mode = false;
            char b[32];
            std::snprintf(b, sizeof(b), "音量 %d%%", s_volume);
            ShowText(b);
            render::SetMood(proto::Mood::Idle);
        }
        // 摸摸头反应结束：熄灯、回待机；只清"摸摸头自己的字幕"，别误删新对话
        if (s_pet_until && now > s_pet_until) {
            s_pet_until = 0;
            led::Set(led::kIdle);
            render::SetMood(proto::Mood::Idle);
            if (s_pet_text) {
                render::SetText("");
                s_text_until = 0;
                s_pet_text = false;
            }
        }
        if (s_state == kSend) {
            if (!s_uploading) {
                ESP_LOGW(TAG, "录音结束：%d 采样（%.2f 秒）→ 上行", s_got, s_got / (double)kRate);
                ShowText("上报中");
                led::Set(led::kThink);
                render::SetMood(proto::Mood::Think);
                if (s_got > 0 && link::Connected()) {
                    s_uploading = true;
                    if (xTaskCreate(UploadTask, "upl", 5120, nullptr, 4, nullptr) != pdPASS) {
                        s_uploading = false;
                        ESP_LOGE(TAG, "上行任务创建失败，丢弃本段语音");
                        s_got = 0;
                        s_state = kIdle;
                        led::Set(led::kError);
                    }
                } else {
                    if (s_got > 0) {
                        ESP_LOGW(TAG, "桥未连接，本地回放代替");
                        audio::Play(s_buf, s_got);
                    }
                    if (!link::Connected()) led::Set(led::kError);
                    render::SetMood(proto::Mood::Think);
                    s_got = 0;
                    s_state = kIdle;
                    mp3::Resume();
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(30));
    }
}

void OnClick() {
    if (s_volume_mode) {                           // 音量模式：按键 = 确认退出
        s_volume_mode = false;
        char b[48];
        std::snprintf(b, sizeof(b), "音量 %d%%", s_volume);
        ShowText(b);
        render::SetMood(proto::Mood::Idle);
        ESP_LOGW(TAG, "音量模式退出：%d%%", s_volume);
        return;
    }
    if (s_menu) {                                  // 菜单里：执行
        const int sel = s_menu_sel;
        s_menu = false;
        switch (sel) {
            case 0: {
                // 2026-11-03：旋钮让位给"摸摸头"，音量改成进入模式后旋转调节
                s_volume_mode = true;
                s_volume_t = esp_timer_get_time();
                char b[48];
                std::snprintf(b, sizeof(b), "音量 %d%%  旋转调节，按键确认", s_volume);
                ShowText(b);
                break;
            }
            case 1: {
                // 2026-11-13 v0.4：配网向导改成"蓝牙配对"（设备不再有 WiFi/桥地址）。
                const link::Stats lk = link::Get();
                if (lk.active == link::Kind::Ble) {
                    char b[64];
                    std::snprintf(b, sizeof(b), "蓝牙已连接 mtu %d", lk.mtu);
                    ShowText(b, "手机 App 的鲸鲸蓝牙已连上");
                } else {
                    ShowText("蓝牙配对: 手机 App → 鲸鲸蓝牙", "本机名 Jingjing-ACB2");
                }
                break;
            }
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
        mp3::Pause();                              // 音乐让路，别被麦克风收进去
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
    if (s_volume_mode) {                           // 音量模式：长按 = 取消
        s_volume_mode = false;
        char b[48];
        std::snprintf(b, sizeof(b), "音量 %d%%", s_volume);
        ShowText(b);
        render::SetMood(proto::Mood::Idle);
        return;
    }
    if (s_state == kRec) {                         // 录音中长按 = 取消
        s_state = kIdle;
        s_got = 0;
        render::SetMood(proto::Mood::Idle);
        ShowText("已取消");
        ESP_LOGW(TAG, "录音取消");
        mp3::Resume();
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

// 触摸手势 → 具体动作（UI 任务上下文）
// 左右滑：按固定顺序换动作（比随机更像"翻页"，适合触摸）
void CyclePet(int dir, int64_t now) {
    if (!PettingAllowed(now)) return;
    static const clip_player::Id kIds[] = {clip_player::kHappy, clip_player::kWave,
                                           clip_player::kTickle, clip_player::kShy};
    static int idx = 0;
    idx = (idx + (dir >= 0 ? 1 : 3)) % 4;
    clip_player::Id id = kIds[idx];
    if (!clip_player::Ready(id)) id = clip_player::kHappy;
    render::PlayClip((int)id, 3000);
    pet_voice::PlayForClip((int)id);
    render::SetMood(proto::Mood::Happy);
    led::Set(led::kSpeak);
    ShowText("换一个动作");
    s_pet_text = true;
    s_pet_until = now + 3000000;
    s_pet_next_us = now + kPetCooldownUs;
    ESP_LOGI(TAG, "cycle clip=%d dir=%d", (int)id, dir);
}

void HandleTouch(int evt, int x, int y, int dx, int dy) {
    const int64_t now = esp_timer_get_time();
    switch (evt) {
        case 1:  // 单击：按区域分派（y<96 顶部 / 96–290 角色 / >290 字幕）
            if (y < 96) {
                char b[96];
                std::snprintf(b, sizeof(b), "在线 %d dBm 电量 %d%% 音量 %d%%",
                              link::Get().rssi, (int)bsp_battery_get_percent(), s_volume);
                ShowText(b);
                ESP_LOGI(TAG, "tap top y=%d", y);
            } else if (y <= 290) {
                if (PettingAllowed(now)) TriggerPet(now);
            } else {
                // 点字幕：有下一页就翻页；只有一页就当"摸摸头"
                if (!render::NextPage() && PettingAllowed(now)) TriggerPet(now);
            }
            break;
        case 2:  // 双击 = 再来一次（跳过冷却）
            if (PettingAllowed(now)) {
                s_pet_next_us = 0;
                TriggerPet(now);
            }
            break;
        case 3:  // 长按 = 菜单（复用按键长按的全部语义）
            OnLong();
            break;
        case 4:  // 滑动：横向换动作，纵向调音量
            if ((dx < 0 ? -dx : dx) > (dy < 0 ? -dy : dy)) {
                CyclePet(dx > 0 ? 1 : -1, now);
            } else {
                if (s_menu || s_volume_mode) break;
                if (s_state != kIdle || s_audio_active || s_drain_wait) break;
                s_volume += dy > 0 ? -5 : 5;   // 下滑减、上滑加
                if (s_volume < 0) s_volume = 0;
                if (s_volume > 100) s_volume = 100;
                audio::Volume(s_volume);
                char b[32];
                std::snprintf(b, sizeof(b), "音量 %d%%", s_volume);
                ShowText(b);
                ESP_LOGI(TAG, "vol=%d dy=%d", s_volume, dy);
            }
            break;
        default:
            break;
    }
}

void OnTurn(int d) {
    const int64_t now = esp_timer_get_time();
    if (s_volume_mode) {                           // 音量模式：旋钮调音量（2026-11-03）
        s_volume_t = now;
        s_volume += d * 5;
        if (s_volume < 0) s_volume = 0;
        if (s_volume > 100) s_volume = 100;
        audio::Volume(s_volume);
        char b[32];
        std::snprintf(b, sizeof(b), "音量 %d%%", s_volume);
        ShowText(b);
        ESP_LOGI(TAG, "音量 %d%%", s_volume);
        return;
    }
    if (s_menu) {                                  // 菜单选择
        s_menu_sel = (s_menu_sel + d + kMenuCount) % kMenuCount;
        DrawMenu();
        return;
    }
    // 2026-11-03：菜单关闭时旋钮 = 摸摸头（不再直接调音量）
    PetFeed(d, now);
}

}  // namespace

void Init() {
    s_cap = kRate * kMaxSec;
    s_buf = (int16_t*)heap_caps_malloc((size_t)s_cap * 2, MALLOC_CAP_SPIRAM);
    if (!s_buf) { ESP_LOGE(TAG, "录音缓冲申请失败"); s_cap = 0; }
    // ADPCM 上行编码缓冲（PSRAM）：10 s/24 kHz 上限 ≈ 120.5 KB（1024 B 块 / 2041 采样）
    s_adpcm_cap = adpcm::EncodedSizeForSamples(kRate * kMaxSec);
    if (s_adpcm_cap > 0) {
        s_adpcm_buf = (uint8_t*)heap_caps_malloc(s_adpcm_cap, MALLOC_CAP_SPIRAM);
        if (!s_adpcm_buf) {
            ESP_LOGE(TAG, "ADPCM 编码缓冲申请失败（%u B）：BLE 语音上行不可用", unsigned(s_adpcm_cap));
            s_adpcm_cap = 0;
        }
    }
    ESP_LOGW(TAG, "ADPCM：%u B 上行缓冲（24 kHz → %d B/s，10 s ≈ %u B）", unsigned(s_adpcm_cap),
             adpcm::kBytesPerSecond, unsigned(adpcm::EncodedSizeForSamples(kRate * kMaxSec)));
    link::SetOnSubscribed([]() { s_force_hello = true; });
    link::SetTextHandler([](const char* t, size_t n) {
        // 栈预算：ws 任务只有 5 KB，Downlink(~1.1KB) + buf 必须静态。
        // buf 2 KB（FW-05）：桥默认 say ≤240 字（≈755 B），原来 560 B 会把 JSON 截断，
        // Parse 失败 → 长回复没字幕。传输层上限同步放到了 2048（link_ble 文本上限 4 KB）。
        static char buf[2048];
        static proto::Downlink dl;
        const size_t k = n < sizeof(buf) - 1 ? n : sizeof(buf) - 1;
        std::memcpy(buf, t, k);
        buf[k] = 0;
        ESP_LOGI(TAG, "下行文本(%u): %.60s", (unsigned)n, buf);

        // 不再用裸 strstr 匹配 shot/ping/welcome（FW-16：say 正文里带这些词会误吞）；
        // 统一先 Parse，再按 kind 分派。
        if (!proto::Parse(buf, k, &dl)) { ESP_LOGW(TAG, "解析失败（%u B）", (unsigned)n); return; }
        switch (dl.kind) {
            case proto::Downlink::Welcome:
                ESP_LOGI(TAG, "welcome（收到回执，hello 重发门禁解除）");
                s_welcome_seen = true;
                break;
            case proto::Downlink::Ping: {
                // pong 带诊断字段（2026-11-03 契约 + 2026-11-13 §7 链路字段）：桥只展示。
                // 在 link 收包任务上下文执行：只读几个计数器 + 发一帧短文本，不阻塞收包。
                const link::Stats lk = link::Get();
                proto::PongInfo info;
                info.buf_ms = audio::StreamBuffered() * 1000 / kRate;
                info.underruns = audio::StreamUnderruns();
                info.reconnects = lk.reconnects;
                info.rssi = lk.rssi;
                info.codec = proto::CodecName(s_codec);
                info.transport = proto::TransportName(
                    lk.active == link::Kind::Ble ? proto::Transport::Ble
                                                 : proto::Transport::None);
                info.mtu = lk.mtu;
                info.tx_drop = lk.tx_drop;
                info.rx_drop = lk.rx_drop;
                char pb[320];
                const size_t pn = proto::BuildPong(pb, sizeof(pb), info);
                if (pn == 0) {
                    ESP_LOGE(TAG, "pong 组帧失败（缓冲 %u B 不够？）", (unsigned)sizeof(pb));
                } else if (!link::SendText(pb, pn)) {
                    ESP_LOGW(TAG, "pong 发送失败（连接刚断？）");
                }
                break;
            }
            case proto::Downlink::Shot:
                ESP_LOGW(TAG, "下行要求拍照（投递到拍照任务）");
                RequestShot();
                break;
            case proto::Downlink::Say:
                if (dl.text[0]) {
                    ShowText(dl.text);
                    render::SetMood(dl.mood);
                    led::Set(led::kSpeak);
                    s_speak_until = 0;               // 等音频播完再计时
                    s_say_at = esp_timer_get_time(); // FW-09：兜底复位窗口起点
                }
                break;
            case proto::Downlink::Face:
                render::SetMood(dl.mood);
                break;
            case proto::Downlink::Audio: {
                if (dl.audio_seq != s_audio_seq) {   // 新的一段：重置对账（FW-08）
                    if (s_audio_seq >= 0) {
                        ESP_LOGW(TAG, "音频 seq %d → %d（上一段没收到 audio_end？）", s_audio_seq, dl.audio_seq);
                        audio_dec::Flush();          // 把上一段残留的 Opus 包解完，别串到新段
                    }
                    s_audio_seq = dl.audio_seq;
                    s_rx_total = 0;
                    s_rx_declared = 0;
                    s_opus_pkts = 0;
                    if (s_pad) audio::StreamWrite(s_pad, kPadHead);   // 垫字头（界内）
                }
                s_codec = dl.codec;   // 本段编码；缺省 pcm（老桥不带 codec 字段）
                if (dl.codec == proto::Codec::Adpcm) {
                    // ADPCM：同步解码（块头自带状态），只需告诉 audio_dec 期望采样数
                    // （末块补齐的 1 个采样靠 samples 裁掉）。
                    s_adpcm_rx_bytes = 0;
                    audio_dec::AdpcmBegin(dl.sample_count);
                }
                // 播放期望置位：只有本段音频"应该还在供数据"时，环空才算 underrun。
                audio::StreamSetExpected(true);
                if (dl.audio_bytes > 0) s_rx_declared = dl.audio_bytes;
                s_say_at = 0;
                if (!s_audio_active) {   // FW-07：多句 TTS 只配对一次 Pause/Resume
                    s_audio_active = true;
                    mp3::Pause();        // 音乐让路，清掉已排队的采样
                }
                if (dl.codec == proto::Codec::Opus && !s_opus_ok) {
                    // 我们 hello 只报了 pcm 时桥不该发 opus；发来只能说明桥侧不是按能力协商。
                    // 不能说"没事"：二进制帧是 opus 裸包，按 PCM 播只会是噪音，所以这段不出声。
                    ESP_LOGE(TAG, "桥下发 opus，但本机解码器不可用（PSRAM/Init 失败）——本段无声；"
                                  "请检查 hello.codecs 与桥侧配置（固件只会回退 pcm）");
                }
                ESP_LOGI(TAG, "音频头：seq=%d codec=%s rate=%d 声明 %d 字节 samples=%d", dl.audio_seq,
                         proto::CodecName(dl.codec), dl.rate, s_rx_declared, dl.sample_count);
                break;
            }
            case proto::Downlink::AudioEnd: {
                if (dl.audio_seq != s_audio_seq) {
                    ESP_LOGW(TAG, "audio_end seq=%d 与当前 %d 不配对，忽略", dl.audio_seq, s_audio_seq);
                    break;
                }
                if (s_codec == proto::Codec::Opus) {
                    // 先把包环里的 Opus 包全部解成 PCM 入环，再写尾垫；顺序反了尾垫会夹在
                    // 最后几包音频中间（听感是多出 180 ms 静音断点）。
                    audio_dec::Flush();
                    const audio_dec::Stats st = audio_dec::GetStats();
                    ESP_LOGW(TAG, "音频收尾（opus）：%d 包，包环残留 %d，丢包 %d，解码失败 %d，写环丢采样 %d",
                             s_opus_pkts, st.queued, st.dropped, st.decode_errors, st.write_drops);
                } else if (s_codec == proto::Codec::Adpcm) {
                    // 先把跨帧剩下的末短块解完（audio_dec 内部打印块数/采样数/错误数）
                    audio_dec::AdpcmFlush();
                    ESP_LOGW(TAG, "音频收尾（adpcm）：实收 %d / 声明 %d 字节", s_adpcm_rx_bytes,
                             s_rx_declared);
                } else {
                    ESP_LOGW(TAG, "音频收尾（pcm）：实收 %d / 声明 %d 字节%s", s_rx_total, s_rx_declared,
                             (s_rx_declared > 0 && s_rx_total < s_rx_declared) ? "（丢帧！）" : "");
                }
                const int buffered = audio::StreamBuffered();
                ESP_LOGW(TAG, "音频结束，PCM 缓冲积压 %d 采样（%d ms）", buffered, buffered * 1000 / kRate);
                if (s_pad) audio::StreamWrite(s_pad, kPadTail);   // 垫字尾（kPadSamples 内）
                // 数据已全部入环：之后的排空是正常收尾，不算欠载。
                audio::StreamSetExpected(false);
                s_drain_wait = true;
                s_audio_seq = -1;
                if (s_audio_active) {
                    s_audio_active = false;
                    mp3::Resume();                   // 等 TTS 尾巴播完再续音乐
                }
                ESP_LOGW(TAG, "TTS 一段播放完毕");
                // 熄灯/表情交给 TickTask 的排空门禁
                break;
            }
            case proto::Downlink::Play:
                // 契约还没收录 play（桥发不出）；固件先只允许 /sdcard/ 下的路径，避免任意文件读
                if (std::strncmp(dl.file, "/sdcard/", 8) != 0) {
                    ShowText("路径不允许");
                    ESP_LOGW(TAG, "拒绝播放非 /sdcard/ 路径：%s", dl.file);
                } else if (mp3::Play(dl.file, dl.loop)) {
                    ShowText("♪ 播放");
                    ESP_LOGW(TAG, "播放 %s（loop=%d）", dl.file, (int)dl.loop);
                } else {
                    ShowText("找不到音频");
                    ESP_LOGW(TAG, "播放失败 %s", dl.file);
                }
                break;
            case proto::Downlink::Stop:
                mp3::Stop();
                ShowText("停止");
                ESP_LOGW(TAG, "停止播放");
                break;
            default:
                ESP_LOGI(TAG, "其它下行 kind=%d", (int)dl.kind);
                break;
        }
    });
    link::SetBinaryHandler([](const uint8_t* p, size_t n) {
        static int s_frames = 0;
        ++s_frames;
        // 二进制帧的含义由 audio 头的 codec 决定（缺省 pcm，向后兼容）。
        if (s_codec == proto::Codec::Opus) {
            // opus：每帧 = 一个裸 Opus 包（20 ms / 16 kHz mono，无长度前缀；长度可奇可偶，
            // 所以**不能**套下面 PCM 的"偶数字节"兜底）。这里只做入队，解码在 "adec" 任务。
            const bool first = (s_opus_pkts == 0);
            ++s_opus_pkts;
            if (!audio_dec::PushPacket(p, n)) {
                // 原因（未就绪/包环满/长度非法）由 audio_dec 计数并限频打 ERROR；不重复刷屏，
                // 但也绝不静默：audio_end 的统计行会带累计丢包/解码失败数。
            }
            if (first) led::Set(led::kSpeak);
            return;
        }
        if (s_codec == proto::Codec::Adpcm) {
            // ADPCM 块流：audio_dec 内部按 1024 B 块切分/跨帧攒，同步解码进 PCM 环。
            // BLE 二进制帧 ≤16 KB（约 16 块），10 s 语音 ~120 KB ≈ 8 帧。
            const bool first = (s_adpcm_rx_bytes == 0);
            s_adpcm_rx_bytes += (int)n;
            audio_dec::PushAdpcm(p, n);
            if (first) led::Set(led::kSpeak);
            return;
        }
        // ---- 以下为 PCM 原路径（24 kHz/16 bit/mono 裸采样）----
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
        const bool first_frame_of_utterance = (s_rx_total == 0);
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
            if (first_frame_of_utterance) led::Set(led::kSpeak);
        }
    });
    // 相机取到 JPEG 后立刻上行：{"t":"image",...} + 二进制分块
    camera::SetImageHandler([](const uint8_t* jpg, int len) {
        static int s_img_seq = 0;
        if (!link::Connected()) { ESP_LOGW(TAG, "图像 %d 字节：桥未连接，丢弃", len); return; }
        char h[160];
        std::snprintf(h, sizeof(h),
                      "{\"t\":\"image\",\"bytes\":%d,\"w\":240,\"h\":240,\"seq\":%d}",
                      len, ++s_img_seq);
        bool ok = link::SendText(h, std::strlen(h));
        int off = 0;
        while (ok && off < len) {
            const int n = (len - off) > 16384 ? 16384 : (len - off);
            ok = link::SendBinary(jpg + off, (size_t)n);
            off += n;
        }
        ESP_LOGW(TAG, "图像上行 %d 字节（seq=%d）%s", len, s_img_seq, ok ? "成功" : "中断");
    });
    input::OnPress(OnClick);
    input::OnLongPress(OnLong);
    input::OnTurn(OnTurn);

    // 2026-11-04：触摸屏（SPD2010，I2C1）。回调只置事件，动作在 TickTask 里统一处理。
    // 先注册再 Init，避免触摸任务起步时丢事件。
    touch_input::OnTap([](int x, int y) {
        s_touch_x = x;
        s_touch_y = y;
        s_touch_evt = 1;
    });
    touch_input::OnDouble([](int x, int y) {
        s_touch_x = x;
        s_touch_y = y;
        s_touch_evt = 2;
    });
    touch_input::OnLong([] { s_touch_evt = 3; });
    touch_input::OnSwipe([](int dx, int dy) {
        s_touch_dx = dx;
        s_touch_dy = dy;
        s_touch_evt = 4;
    });
    (void)touch_input::Init();

    xTaskCreate(RecTask, "rec", 4096, nullptr, 5, nullptr);
    // FW-01：缓冲要按**较大的**尾垫分配（原来只按头垫 120 ms 申请，尾垫 180 ms 越界读 2880 B）
    s_pad = (int16_t*)heap_caps_calloc(1, (size_t)kPadSamples * 2, MALLOC_CAP_SPIRAM);
    if (!s_pad) ESP_LOGE(TAG, "静音垫申请失败（%d 采样）", kPadSamples);
    audio::StreamInit();
    // Opus 解码器必须在 audio::StreamInit() 之后（它往 PCM 环写）。初始化失败不 fatal：
    // s_opus_ok=false → hello 只报 pcm、audio 头若仍来 opus 会打 ERROR（回退 PCM 路径）。
    s_opus_ok = audio_dec::Init();
    led::Init();
    xTaskCreate(TickTask, "uist", 3072, nullptr, 3, nullptr);
    // 2026-11-13 v0.4：开机第一屏就是蓝牙配对向导（原 WiFi 配网已随 WiFi 移除）。
    ShowText("蓝牙配对: 打开手机 App 的鲸鲸蓝牙", "本机名 Jingjing-ACB2");
    ESP_LOGW(TAG, "交互就绪：单击=录音开关 长按=菜单 旋钮=音量/选择；下行编码=%s",
             s_opus_ok ? "pcm/opus（能力协商）" : "pcm（Opus 已回退）");
}

}  // namespace app_ui