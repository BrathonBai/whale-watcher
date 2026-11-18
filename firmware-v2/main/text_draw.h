// text_draw.h —— 16x16 位图文字排版与绘制（纯 C++17，零 esp_* 依赖）
//
// 为什么没有 esp 依赖：这套代码要在 Windows 上用 cl.exe 直接编译做主机测试
// （firmware/host/test_text.cc），再原样编进固件。任何 esp_lcd / FreeRTOS 的引用
// 都会让主机测试没法跑，所以这里只碰 <cstdint> 和裸指针。
//
// 坐标系：屏幕原点左上，x 向右、y 向下。每个字形占 kCellW x kCellH 的固定格子，
// 中英文同宽（等距），这样折行只需数格子，不必做字宽表。
// 基线在第 13 行（font16::kBaselineRow），由字形位图本身保证，绘制端不参与对齐。
#pragma once
#include <cstdint>

namespace text_draw {

constexpr int kCellW = 16;
constexpr int kCellH = 16;
constexpr int kCellBytes = 32;          // 16 行 × 2 字节

// 取码点的字形位图；不支持时返回替代字形（空心方框）并 *known=false。
// 返回的是 16 个 uint16 行掩码（bit15=最左像素），即 kCellBytes 字节。
const uint8_t* Glyph(uint32_t cp, bool* known = nullptr);

// UTF-8 解码：返回码点，*p 前进；非法序列返回 0xFFFD 并前进 1 字节。
// 约定 *p 指向 NUL 结尾的串；*p 本身为 '\0' 时返回 0 且不前进。
uint32_t NextCodepoint(const char** p);

// 文本像素宽（每个字形 kCellW；'\n' 与 '\r' 不计宽）。
int Width(const char* utf8, int byte_len);

// 按 max_px 折行（ASCII 可在词内断，中文可任意断；避开行首标点）。
// 把每行在原串里的 [start,end) 字节偏移写入 out，返回行数。
// 最多写 max_lines 行；超出部分不再处理（返回 max_lines，调用方看最后一行是否到串尾）。
int WrapLines(const char* utf8, int byte_len, int max_px, int* line_start, int* line_end,
              int max_lines);

// 把 [byte_start,byte_end) 这段画到 RGB565 **大端**缓冲：fb 是 fb_w×fb_h 的整帧或子帧，
// 颜色 fg/bg 已是 BE 值。每格都填 bg（不透明文字区）；'\n'/'\r' 跳过不占宽，
// 换行由调用方按 WrapLines 的结果自己算 y。越界像素自动裁掉。
void DrawRun(uint16_t* fb, int fb_w, int fb_h, int x, int y, const char* utf8, int byte_start,
             int byte_end, uint16_t fg_be, uint16_t bg_be);

}  // namespace text_draw
