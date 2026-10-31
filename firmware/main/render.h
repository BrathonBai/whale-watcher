// render.h —— 412×412 合成层：静态底图 + 像素脸 + 中文字幕，全部先画进内存帧，
// 再按矩形推给面板。
//
// 为什么要"内存帧 + 矩形推送"而不是像 v0.5 那样直接画带：
//   v0.5 只有一张脸，改哪刷哪很省事。v0.6 要同时画脸和文字，两个区域重叠时
//   必须合成后一次推，否则会出现"文字被后刷的脸盖掉"这种闪烁。
//   代价是一帧 412×412×2 = 340 KB —— 放 PSRAM，DMA 用小条中转（见 Flush）。
#pragma once

#include <cstdint>

#include "esp_lcd_types.h"
#include "proto.h"

namespace render {

constexpr int kScreenW = 412;
constexpr int kScreenH = 412;

// 布局（圆形屏内切，右上/左下角被外壳挡住，文字区特意收窄）
constexpr int kFaceX = 104, kFaceY = 100, kFaceW = 204, kFaceH = 204;
constexpr int kTextX = 102, kTextY = 312, kTextW = 208;
constexpr int kTextLineH = 16;
constexpr int kTextLines = 4;

bool Init(esp_lcd_panel_handle_t panel);
bool Ready();

void SetMood(proto::Mood m);
proto::Mood Mood();

// 设置字幕（UTF-8）。会重新折行；超过一页时按页轮播（Tick 里推进）。
void SetText(const char* utf8);

// 菜单：占用字幕区（4 行），sel 行亮底深字，其余白字。
// items 由调用方持有（app 层静态数组），这里只存指针。
void SetMenu(bool on, int sel, const char* const* items, int n);

// 临时播一个动作（交互反馈）：优先于 mood 映射，ms 毫秒后自动回落到 mood。
// id 用 clip_player::Id 的整数值，避免头文件互相包含。
void PlayClip(int id, int ms);

// 每帧调用：推进动画（眨眼/呼吸）、必要时推矩形。now_us 用 esp_timer_get_time()。
void Tick(int64_t now_us);

// 立刻重推整屏（用于启动/恢复）
void QueueFullRefresh();

// 统计（串口日志）
struct Stats {
    int frames = 0;
    int flushes = 0;          // 推了多少次矩形
    int last_face_px = 0;     // 上次推的像素数
    int fps = 0;
    int lines = 0;            // 当前字幕行数
    int pages = 0;            // 字幕页数
    int text_px = 0;
};
Stats Get();

}  // namespace render
