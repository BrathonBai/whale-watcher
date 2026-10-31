// render.cc —— 见 render.h。
#include "render.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

#include "board_watcher.h"
#include "clip_player.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "text_draw.h"

namespace render {
namespace {

constexpr const char* TAG = "ui";

// ---- 颜色（RGB565，函数名带 BE 表示已换成面板要的大端字节序）
constexpr uint16_t kBg = 0x0861;
constexpr uint16_t kHair = 0x10E5;
constexpr uint16_t kDial = 0x18C7;
constexpr uint16_t kTeal = 0x3ED8;
constexpr uint16_t kWhite = 0xEF7D;
constexpr uint16_t kError = 0xF800;   // 纯红，error 字幕用
// 字幕气泡（255,255,255 的 8% 亮底 + 20% 边，屏幕是黑的，够看清又不抢角色）
constexpr uint16_t kBubble = 0x10C4;
constexpr uint16_t kBubbleEdge = 0x2148;
constexpr uint16_t kSel = 0x2C6F;   // 菜单高亮条（暗青）

constexpr uint16_t be(uint16_t c) { return (uint16_t)((c >> 8) | (c << 8)); }
constexpr uint16_t kBgBE = be(kBg), kHairBE = be(kHair), kDialBE = be(kDial);
constexpr uint16_t kWhiteBE = be(kWhite), kErrorBE = be(kError), kTealBE = be(kTeal);
constexpr uint16_t kBubbleBE = be(kBubble), kBubbleEdgeBE = be(kBubbleEdge);
constexpr uint16_t kSelBE = be(kSel);

// 面板要求：起始列 4 的倍数、列数 4 的倍数（SPD2010 的窗口约束，v0.4 踩过）
inline int Align4(int v) { return v & ~3; }
inline int Align4Up(int v) { return (v + 3) & ~3; }

esp_lcd_panel_handle_t s_panel = nullptr;
uint16_t* s_fb = nullptr;          // 整帧（PSRAM 优先）
uint16_t* s_strip = nullptr;       // DMA 中转条（内部 RAM）
// chrome（背景 + 圆环 + 刻度）的一份副本。角色区每帧先从它恢复再叠角色 ——
// 没有这一步，clip 里"透明"的像素不会写，上一帧的人影就留在屏幕上（重影）。
uint16_t* s_bg = nullptr;
int s_strip_rows = 24;

volatile proto::Mood s_mood = proto::Mood::Idle;
bool s_face_dirty = true;
bool s_text_dirty = true;
bool s_full_dirty = true;

// 字幕状态
char s_text[proto::Downlink::kTextCap] = {0};
int s_line_start[16];
int s_line_end[16];
int s_line_count = 0;
int s_page = 0;
int s_page_count = 0;
int64_t s_page_next_us = 0;

// 菜单（占用字幕区）：app 层决定什么时候开、选中谁
bool s_menu_on = false;
int s_menu_sel = 0;
const char* const* s_menu_items = nullptr;
int s_menu_n = 0;

// 动画
int64_t s_last_face_us = 0;
float s_t = 0.0f;
int s_last_frame = -1;
Stats s_stats;
int64_t s_fps_t0 = 0;

// 桌宠 clip（shenshen）：mood → 一个动作 clip
bool s_pet_mode = false;
int64_t s_pet_us = 0;
int s_override_id = -1;        // 交互动作覆盖（PlayClip）
int64_t s_override_until = 0;
int64_t s_roam_next_us = 0;    // 下一次"自己溜达"
int64_t s_roam_until = 0;
clip_player::Id s_pet_id = clip_player::kIdle;
constexpr int kPetTopY = 96;   // 角色区顶部；180 高 → 底 276，给字幕 312 留空
uint16_t s_pal_be[clip_player::kCount][16];
bool s_pal_done = false;

// ---- 光栅原语（写进整帧）
inline void Put(int x, int y, uint16_t c) {
    if (x < 0 || x >= kScreenW || y < 0 || y >= kScreenH) return;
    s_fb[y * kScreenW + x] = c;
}
void HLine(int xa, int xb, int y, uint16_t c) {
    if (y < 0 || y >= kScreenH) return;
    if (xa > xb) { const int t = xa; xa = xb; xb = t; }
    if (xb < 0 || xa >= kScreenW) return;
    if (xa < 0) xa = 0;
    if (xb >= kScreenW) xb = kScreenW - 1;
    uint16_t* row = s_fb + y * kScreenW;
    for (int x = xa; x <= xb; ++x) row[x] = c;
}
void FillRect(int x0, int y0, int x1, int y1, uint16_t c) {
    for (int y = y0; y <= y1; ++y) HLine(x0, x1, y, c);
}
// 圆角矩形：先填四条边带/中间带，再用逐行弦长补四角
void FillRoundRect(int x0, int y0, int x1, int y1, int r, uint16_t c) {
    if (x1 <= x0 || y1 <= y0) return;
    if (r * 2 > (x1 - x0)) r = (x1 - x0) / 2;
    if (r * 2 > (y1 - y0)) r = (y1 - y0) / 2;
    FillRect(x0 + r, y0, x1 - r, y1, c);
    FillRect(x0, y0 + r, x0 + r, y1 - r, c);
    FillRect(x1 - r, y0 + r, x1, y1 - r, c);
    for (int dy = 0; dy < r; ++dy) {
        const int d = r - dy;
        const int inset = r - (int)lroundf(sqrtf((float)(r * r - d * d)));
        HLine(x0 + inset, x0 + r, y0 + dy, c);
        HLine(x1 - r, x1 - inset, y0 + dy, c);
        HLine(x0 + inset, x0 + r, y1 - dy, c);
        HLine(x1 - r, x1 - inset, y1 - dy, c);
    }
}
void Circle(int cx, int cy, int r, uint16_t c) {
    int x = r, y = 0, err = 1 - r;
    while (x >= y) {
        Put(cx + x, cy + y, c); Put(cx + y, cy + x, c);
        Put(cx - y, cy + x, c); Put(cx - x, cy + y, c);
        Put(cx - x, cy - y, c); Put(cx - y, cy - x, c);
        Put(cx + y, cy - x, c); Put(cx + x, cy - y, c);
        ++y;
        if (err < 0) err += 2 * y + 1;
        else { --x; err += 2 * (y - x + 1); }
    }
}
void Line(int x0, int y0, int x1, int y1, uint16_t c) {
    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        Put(x0, y0, c);
        if (x0 == x1 && y0 == y1) break;
        const int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

// ---- 静态底图：背景 + 外圈 + 60 条刻度（v0.5 的"仪器感"）
void DrawChrome() {
    for (int y = 0; y < kScreenH; ++y) HLine(0, kScreenW - 1, y, kBgBE);
    const int cx = kScreenW / 2, cy = kScreenH / 2;
    Circle(cx, cy, 178, kHairBE);
    for (int m = 0; m < 60; ++m) {
        const float a = (m * 6.0f - 90.0f) * 3.14159265f / 180.0f;
        Line(cx + (int)lroundf(161.0f * cosf(a)), cy + (int)lroundf(161.0f * sinf(a)),
             cx + (int)lroundf(167.0f * cosf(a)), cy + (int)lroundf(167.0f * sinf(a)), kDialBE);
    }
}

// ---- 推送：整帧里的一块矩形 → 面板（经 DMA 条中转，按行切片）
bool Flush(int x0, int y0, int x1, int y1) {
    if (!s_panel || !s_fb || !s_strip) return false;
    x0 = Align4(x0);
    x1 = Align4Up(x1);
    if (x0 < 0) x0 = 0;
    if (x1 > kScreenW) x1 = kScreenW;
    if (y0 < 0) y0 = 0;
    if (y1 > kScreenH) y1 = kScreenH;
    if (x1 <= x0 || y1 <= y0) return false;
    const int w = x1 - x0;

    for (int y = y0; y < y1; y += s_strip_rows) {
        int rows = y1 - y;
        if (rows > s_strip_rows) rows = s_strip_rows;
        for (int r = 0; r < rows; ++r) {
            std::memcpy(s_strip + (size_t)r * w, s_fb + (size_t)(y + r) * kScreenW + x0,
                        (size_t)w * sizeof(uint16_t));
        }
        if (watcher::LcdDrawBand(s_panel, x0, y, x1, y + rows, s_strip) != ESP_OK) return false;
    }
    ++s_stats.flushes;
    s_stats.last_face_px = w * (y1 - y0);
    return true;
}

// 把矩形恢复成"没有角色"的样子（逐行 memcpy，区域小、纯带宽操作）
void RestoreBg(int x, int y, int w, int h) {
    if (!s_bg) return;
    for (int row = 0; row < h; ++row) {
        std::memcpy(s_fb + (size_t)(y + row) * kScreenW + x,
                    s_bg + (size_t)(y + row) * kScreenW + x,
                    (size_t)w * sizeof(uint16_t));
    }
}

// ---- 字幕：折行 + 分页
void LayoutText() {
    s_line_count = 0;
    s_page = 0;
    s_page_count = 0;
    if (!s_text[0]) return;

    int starts[64], ends[64];
    const int total = text_draw::WrapLines(s_text, (int)std::strlen(s_text), kTextW, starts, ends, 64);
    s_line_count = total;
    if (total <= 0) return;

    // 一页 kTextLines 行，剩余按页轮播
    s_page_count = (total + kTextLines - 1) / kTextLines;
    for (int i = 0; i < total && i < kTextLines; ++i) {
        s_line_start[i] = starts[i];
        s_line_end[i] = ends[i];
    }
    s_page_next_us = esp_timer_get_time() + 3500000;
}

void DrawMenu() {
    const int bx0 = kTextX - 10, by0 = kTextY - 8;
    const int bx1 = kTextX + kTextW + 9, by1 = kTextY + kTextLines * kTextLineH + 6;
    FillRoundRect(bx0, by0, bx1, by1, 12, kBubbleEdgeBE);
    FillRoundRect(bx0 + 1, by0 + 1, bx1 - 1, by1 - 1, 11, kBubbleBE);

    for (int i = 0; i < s_menu_n && i < kTextLines; ++i) {
        const int y = kTextY + i * kTextLineH;
        const bool sel = (i == s_menu_sel);
        const uint16_t bg = sel ? kSelBE : kBubbleBE;
        if (sel) FillRect(kTextX - 2, y - 1, kTextX + kTextW + 1, y + kTextLineH - 2, kSelBE);
        const char* item = s_menu_items ? s_menu_items[i] : "";
        const int len = item ? (int)std::strlen(item) : 0;
        text_draw::DrawRun(s_fb, kScreenW, kScreenH, kTextX, y, item, 0, len,
                           sel ? kBgBE : kWhiteBE, bg);
    }
    s_stats.text_px = kTextW * kTextLineH * (s_menu_n > 0 ? s_menu_n : 0);
}

void DrawTextPage() {
    s_stats.text_px = 0;
    if (s_menu_on) { DrawMenu(); return; }
    if (s_line_count <= 0) return;

    const uint16_t fg = (s_mood == proto::Mood::Error) ? kErrorBE : kWhiteBE;
    // 气泡：外框 1px + 内底，圆角 12；没有文字时也画（视觉上"她说话的位置"一直在）
    const int bx0 = kTextX - 10, by0 = kTextY - 8;
    const int bx1 = kTextX + kTextW + 9, by1 = kTextY + kTextLines * kTextLineH + 6;
    FillRoundRect(bx0, by0, bx1, by1, 12, kBubbleEdgeBE);
    FillRoundRect(bx0 + 1, by0 + 1, bx1 - 1, by1 - 1, 11, kBubbleBE);

    // 取出当前页的行
    int starts[kTextLines], ends[kTextLines], n = 0;
    const int first = s_page * kTextLines;
    // 重新折一次拿到全量行边界（行数不多，成本可忽略；避免存 64 行状态）
    int all_s[64], all_e[64];
    const int total = text_draw::WrapLines(s_text, (int)std::strlen(s_text), kTextW, all_s, all_e, 64);
    for (int i = first; i < total && n < kTextLines; ++i, ++n) {
        starts[n] = all_s[i];
        ends[n] = all_e[i];
    }

    for (int i = 0; i < n; ++i) {
        text_draw::DrawRun(s_fb, kScreenW, kScreenH, kTextX, kTextY + i * kTextLineH, s_text,
                           starts[i], ends[i], fg, kBgBE);
        s_stats.text_px += (ends[i] - starts[i]) > 0 ? kTextW * kTextLineH : 0;
    }
}

// ---- 桌宠 clip：mood → 一个动作。没打包进来的动作自动落回像素脸。
clip_player::Id PetClipFor(proto::Mood m) {
    // 只有三段素材：待机 / 倾听 / 讲述。其余 mood 归并到最接近的一段。
    switch (m) {
        case proto::Mood::Idle:
        case proto::Mood::Blink:
        case proto::Mood::Sad:     return clip_player::kIdle;   // 低落时安静待着
        case proto::Mood::Listen:
        case proto::Mood::Think:
        case proto::Mood::Error:   return clip_player::kLook;   // 倾听 / 张望
        case proto::Mood::Speak:
        case proto::Mood::Happy:   return clip_player::kWave;   // 讲述 / 兴奋
    }
    return clip_player::kIdle;
}

// 返回 true 表示本帧已由 clip 处理，Tick 可以提前返回。
bool TickPet(int64_t now_us) {
    clip_player::Id want_id = PetClipFor(s_mood);

    // 交互覆盖优先（按键/旋钮触发，几秒后自己回落）
    if (s_override_id >= 0) {
        if (now_us < s_override_until) {
            want_id = (clip_player::Id)s_override_id;
        } else {
            s_override_id = -1;
        }
    } else if (want_id == clip_player::kIdle) {
    }
    if (!clip_player::Ready(want_id)) {
        // 缺素材时**不许**退回像素脸——那是历史遗留形象，用户看到的就是"动画动不动闪回去"。
        // 依次退：idle → 保持当前动作 → 真的一个 clip 都没有就不画角色（像素脸已删除）。
        if (clip_player::Ready(clip_player::kIdle)) {
            want_id = clip_player::kIdle;
        } else if (clip_player::Ready(s_pet_id)) {
            want_id = s_pet_id;
        } else {
            if (s_pet_mode) s_full_dirty = true;
            s_pet_mode = false;
            static bool s_warned = false;
            if (!s_warned) {
                s_warned = true;
                ESP_LOGW(TAG, "没有任何 clip 可用：屏幕不画角色（像素脸已删除）");
            }
            return false;
        }
    }
    s_pet_mode = true;

    if (!s_pal_done) {
        for (int k = 0; k < clip_player::kCount; ++k) {
            const uint16_t* p = clip_player::Palette((clip_player::Id)k);
            for (int i = 0; i < 16; ++i) s_pal_be[k][i] = p ? be(p[i]) : 0;
        }
        s_pal_done = true;
    }

    if (want_id != s_pet_id) {
        s_pet_id = want_id;
        clip_player::Rewind(s_pet_id);
        s_full_dirty = true;          // 换动作：清掉上一条的残影
    }

    const int pw = clip_player::Width(s_pet_id);
    const int ph = clip_player::Height(s_pet_id);
    const int fps = clip_player::Fps(s_pet_id) > 0 ? clip_player::Fps(s_pet_id) : 10;
    const int period_us = 1000000 / fps;
    const int px = (kScreenW - pw) / 2;
    const int py = kPetTopY;

    if (!s_full_dirty && now_us - s_pet_us < period_us) return true;

    if (s_full_dirty) {
        DrawChrome();
        DrawTextPage();
    } else if (s_text_dirty) {
        DrawTextPage();
        if (Flush(kTextX - 10, kTextY - 8, kTextX + kTextW + 10,
                  kTextY + kTextLines * kTextLineH + 7)) {
            s_text_dirty = false;
        }
    }
    s_pet_us = now_us;
    RestoreBg(px, py, pw, ph);
    int f = clip_player::Next(s_pet_id, s_fb, kScreenW, px, py, s_pal_be[s_pet_id]);
    if (f < 0) {
        // 取帧失败**不能**把渲染循环丢进"什么都不画"的空分支（v0.8 定屏就是这么来的）。
        // 先回落到 idle 重试一次；还不行就保持上一帧，但**仍然返回 true**让循环继续跑。
        if (s_pet_id != clip_player::kIdle && clip_player::Ready(clip_player::kIdle)) {
            s_pet_id = clip_player::kIdle;
            clip_player::Rewind(s_pet_id);
            const int ipx = (kScreenW - clip_player::Width(s_pet_id)) / 2;
            f = clip_player::Next(s_pet_id, s_fb, kScreenW, ipx, py, s_pal_be[s_pet_id]);
            s_full_dirty = true;
        }
        if (f < 0) {
            static unsigned s_fail = 0;
            if ((s_fail++ % 100u) == 0u) {
                ESP_LOGW(TAG, "取帧失败 clip#%d（累计 %u 次），保持上一帧", (int)s_pet_id, s_fail);
            }
            if (s_full_dirty && Flush(0, 0, kScreenW, kScreenH)) {
                s_full_dirty = false;
                s_text_dirty = false;
            }
            s_pet_us = now_us;
            return true;   // 关键：循环不断
        }
    }

    if (s_full_dirty) {
        if (Flush(0, 0, kScreenW, kScreenH)) {
            s_full_dirty = false;
            s_text_dirty = false;
            s_face_dirty = false;
        }
    } else {
        Flush(px, py, px + pw, py + ph);
    }
    ++s_stats.frames;
    if (now_us - s_fps_t0 > 1000000) {
        s_stats.fps = s_stats.frames;
        s_stats.frames = 0;
        s_fps_t0 = now_us;
        ESP_LOGI(TAG, "fps=%d clip#%d %d/%d %dx%d", s_stats.fps, (int)s_pet_id, f + 1,
                 clip_player::Frames(s_pet_id), pw, ph);
    }
    return true;
}

}  // namespace

bool Ready() { return s_fb != nullptr && s_panel != nullptr; }
proto::Mood Mood() { return s_mood; }
Stats Get() { return s_stats; }

bool Init(esp_lcd_panel_handle_t panel) {
    s_panel = panel;

    s_fb = static_cast<uint16_t*>(
        heap_caps_malloc((size_t)kScreenW * kScreenH * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    bool psram = true;
    if (!s_fb) {
        psram = false;
        // 没有 PSRAM 时退回内部 RAM 的整帧（340KB，很可能失败 —— 但让它显式失败，
        // 而不是悄悄少画半屏）
        s_fb = static_cast<uint16_t*>(
            heap_caps_malloc((size_t)kScreenW * kScreenH * 2, MALLOC_CAP_8BIT));
    }
    s_strip_rows = 24;
    s_strip = static_cast<uint16_t*>(
        heap_caps_malloc((size_t)kScreenW * s_strip_rows * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
    if (!s_fb) {
        ESP_LOGE(TAG, "整帧缓冲 %d KB 分配失败", (kScreenW * kScreenH * 2) / 1024);
        return false;
    }
    if (!s_strip) {
        ESP_LOGE(TAG, "DMA 条 %d KB 分配失败", (kScreenW * s_strip_rows * 2) / 1024);
        return false;
    }
    ESP_LOGI(TAG, "整帧缓冲 %s  条=%d 行", psram ? "PSRAM" : "内部 RAM", s_strip_rows);

    DrawChrome();
    s_bg = static_cast<uint16_t*>(
        heap_caps_malloc((size_t)kScreenW * kScreenH * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (s_bg) {
        std::memcpy(s_bg, s_fb, (size_t)kScreenW * kScreenH * 2);
    } else {
        ESP_LOGW(TAG, "背景副本分配失败：角色移动会留拖影");
    }
    s_full_dirty = true;
    s_face_dirty = true;
    s_text_dirty = true;
    s_fps_t0 = esp_timer_get_time();
    // 桌宠 clip：有内嵌 pet_clip.bin 就启用（没有就一直是像素脸，行为与 v0.6 一致）
    if (!clip_player::Init()) ESP_LOGI(TAG, "没有桌宠 clip，继续用像素脸");
    return true;
}

void SetMood(proto::Mood m) {
    if (s_mood == m) return;
    s_mood = m;
    s_face_dirty = true;
    if (m == proto::Mood::Error) s_text_dirty = true;   // 字幕颜色跟着变
}

void SetText(const char* utf8) {
    if (!utf8) return;
    std::strncpy(s_text, utf8, sizeof(s_text) - 1);
    s_text[sizeof(s_text) - 1] = '\0';
    LayoutText();
    s_text_dirty = true;
}

void PlayClip(int id, int ms) {
    if (id < 0 || id >= clip_player::kCount) return;
    s_override_id = id;
    s_override_until = esp_timer_get_time() + (int64_t)ms * 1000;
    s_full_dirty = true;   // 换动作要清掉上一条的残影
}

void SetMenu(bool on, int sel, const char* const* items, int n) {
    if (on == s_menu_on && sel == s_menu_sel && items == s_menu_items && n == s_menu_n) return;
    s_menu_on = on;
    s_menu_sel = sel;
    s_menu_items = items;
    s_menu_n = n < 0 ? 0 : (n > kTextLines ? kTextLines : n);
    s_text_dirty = true;
}

void QueueFullRefresh() {
    s_full_dirty = true;
    s_face_dirty = true;
    s_text_dirty = true;
}

void Tick(int64_t now_us) {
    if (!Ready()) return;
    // 看门狗：UI 任务若被阻塞过，恢复时留一条记录（v0.8 定屏时一条日志都没有，很难判）
    static int64_t s_last_tick_us = 0;
    if (s_last_tick_us && now_us - s_last_tick_us > 3000000) {
        ESP_LOGW(TAG, "UI 停摆 %lld ms 后恢复", (long long)((now_us - s_last_tick_us) / 1000));
    }
    s_last_tick_us = now_us;
    if (TickPet(now_us)) return;

    // ---- 1) 全屏重推（启动 / 恢复）
    if (s_full_dirty) {
        DrawChrome();
        DrawTextPage();
        if (Flush(0, 0, kScreenW, kScreenH)) {
            s_full_dirty = false;
            s_face_dirty = false;
            s_text_dirty = false;
            ++s_stats.frames;
        }
        s_last_face_us = now_us;
        return;
    }

    // ---- 2) 字幕区
    if (s_text_dirty) {
        DrawTextPage();
        // 文字区固定矩形；即使没有文字也要刷一次（清掉上一句）
        if (Flush(kTextX - 10, kTextY - 8, kTextX + kTextW + 10,
                  kTextY + kTextLines * kTextLineH + 7)) {
            s_text_dirty = false;
        }
    }

    // ---- 3) 字幕分页（多页时每 3.5s 翻一页）
    if (s_page_count > 1 && now_us >= s_page_next_us) {
        s_page = (s_page + 1) % s_page_count;
        s_page_next_us = now_us + 3500000;
        s_text_dirty = true;
    }

    // ---- 5) 每秒报一次 fps
    if (now_us - s_fps_t0 > 1000000) {
        s_stats.fps = s_stats.frames;
        s_stats.frames = 0;
        s_fps_t0 = now_us;
        ESP_LOGI(TAG, "fps=%d 字幕 %d 行/%d 页 上次推送 %d px", s_stats.fps, s_line_count, s_page_count,
                 s_stats.last_face_px);
    }
}

}  // namespace render
