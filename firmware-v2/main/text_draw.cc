// text_draw.cc —— 16x16 位图文字排版与绘制（纯 C++17，零 esp_* 依赖）
//
// 数据来源：font16.h（tools/gen_font.py 生成）。这里只做三件事：
//   1) 码点 → 字形指针（二分查找，3882 项约 12 次比较）
//   2) UTF-8 解码（严格校验，烂字节退化成 U+FFFD，绝不越界读）
//   3) 折行 + 逐像素上色（RGB565 大端，调用方传进来的 fg/bg 已经是 BE）
// 所有函数都对 fb 做边界裁剪，越界静默丢弃——固件里挂一次比漏画一像素贵得多。
#include "text_draw.h"

#include <cstddef>   // std::size_t：<cstdint> 不保证带入，gcc 会在这里报错（MSVC 不会）

#include "font16.h"

namespace text_draw {
namespace {

// 替代字形：空心方框。码点不在字库里时用它，保证行高一致、不跳行。
// 与 font16.h 里的字形同格式：16 个 uint16 行掩码。
constexpr uint16_t kFallback[16] = {
    0xFFFF, 0x8001, 0x8001, 0x8001, 0x8001, 0x8001, 0x8001, 0x8001,
    0x8001, 0x8001, 0x8001, 0x8001, 0x8001, 0x8001, 0x8001, 0xFFFF,
};

// 行首禁则：不能出现在行首的标点（断行时往前挪一个字形）
constexpr const char kNoLineStart[] = "，。！？：；、）》”’』】…—·,.!?:;)]}％";

// 行尾禁则：不能留在行尾的开括号/开引号
constexpr const char kNoLineEnd[] = "（《“‘【〈「『([{";

// 码点表里查色，命中返回下标，否则 -1
inline int FindIndex(uint32_t cp) {
    int lo = 0, hi = font16::kGlyphCount - 1;
    while (lo <= hi) {
        const int mid = lo + (hi - lo) / 2;
        const uint32_t v = font16::kCps[mid];
        if (v == cp) return mid;
        if (v < cp) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}

// 码点是否出现在某个 UTF-8 字符串里（这些集合都很短，线性扫足够快）
inline bool InSet(const char* set, uint32_t cp) {
    if (cp > 0x7F) return false;   // 两个禁则表都只含 ASCII 标点，全角由码点单独判
    for (const char* s = set; *s; ++s) {
        if (static_cast<uint32_t>(static_cast<unsigned char>(*s)) == cp) return true;
    }
    return false;
}

// 全角标点也要参与禁则（中文正文主要是它们）。用码点显式列，省得依赖 UTF-8 扫表。
inline bool IsNoLineStart(uint32_t cp) {
    switch (cp) {
        case 0xFF0C: case 0x3002: case 0xFF01: case 0xFF1F: case 0xFF1A: case 0xFF1B:
        case 0x3001: case 0xFF09: case 0x300B: case 0x300D: case 0x201D: case 0x2019:
        case 0x3011: case 0x300F: case 0x3009: case 0x2026: case 0x2014: case 0x00B7:
        case 0xFF05: case 0xFF3D:
            return true;
        default:
            return InSet(kNoLineStart, cp);
    }
}

inline bool IsNoLineEnd(uint32_t cp) {
    switch (cp) {
        case 0xFF08: case 0x300A: case 0x201C: case 0x2018: case 0x3010: case 0x300E:
        case 0x300C: case 0x3008:
            return true;
        default:
            return InSet(kNoLineEnd, cp);
    }
}

// 带长度上限的 UTF-8 解码：绝不越过 end 读。非法序列返回 0xFFFD 并只前进 1 字节。
// 校验：续字节形态、超长编码（2/3/4 字节各自的下界）、UTF-16 代理区、> U+10FFFF。
inline uint32_t DecodeUtf8(const char** p, const char* end) {
    const char* q = *p;
    if (q >= end) return 0;
    const uint8_t b0 = static_cast<uint8_t>(*q);
    if (b0 < 0x80) {
        *p = q + 1;
        return b0;
    }

    int need;                    // 续字节个数
    uint32_t cp;                 // 边解边拼
    if (b0 >= 0xC2 && b0 <= 0xDF) {          // 0xC0/0xC1 一律非法（必超长）
        need = 1;
        cp = b0 & 0x1Fu;
    } else if (b0 >= 0xE0 && b0 <= 0xEF) {
        need = 2;
        cp = b0 & 0x0Fu;
    } else if (b0 >= 0xF0 && b0 <= 0xF4) {
        need = 3;
        cp = b0 & 0x07u;
    } else {
        *p = q + 1;
        return 0xFFFD;
    }

    if (q + need >= end) {                   // 串被截断
        *p = q + 1;
        return 0xFFFD;
    }
    for (int i = 1; i <= need; ++i) {
        const uint8_t bi = static_cast<uint8_t>(q[i]);
        if ((bi & 0xC0u) != 0x80u) {
            *p = q + 1;
            return 0xFFFD;
        }
        cp = (cp << 6) | (bi & 0x3Fu);
    }
    if ((need == 2 && cp < 0x800u) || (need == 3 && cp < 0x10000u) || cp > 0x10FFFFu ||
        (cp >= 0xD800u && cp <= 0xDFFFu)) {
        *p = q + 1;
        return 0xFFFD;
    }
    *p = q + need + 1;
    return cp;
}

// 把一格字形贴到缓冲上（裁边）
inline void BlitGlyph(uint16_t* fb, int fb_w, int fb_h, int x, int y, uint32_t cp,
                      uint16_t fg_be, uint16_t bg_be) {
    if (x >= fb_w || y >= fb_h || x + kCellW <= 0 || y + kCellH <= 0) return;
    const uint16_t* rows = reinterpret_cast<const uint16_t*>(Glyph(cp));
    const int gx0 = x < 0 ? -x : 0;
    const int gx1 = (x + kCellW > fb_w) ? fb_w - x : kCellW;
    for (int gy = 0; gy < kCellH; ++gy) {
        const int py = y + gy;
        if (py < 0 || py >= fb_h) continue;
        const uint16_t bits = rows[gy];
        uint16_t* row = fb + std::size_t(py) * std::size_t(fb_w);
        if (bits == 0x0000) {
            for (int gx = gx0; gx < gx1; ++gx) row[x + gx] = bg_be;
        } else if (bits == 0xFFFF) {
            for (int gx = gx0; gx < gx1; ++gx) row[x + gx] = fg_be;
        } else {
            for (int gx = gx0; gx < gx1; ++gx) {
                row[x + gx] = (bits & (0x8000u >> gx)) ? fg_be : bg_be;
            }
        }
    }
}

}  // namespace

const uint8_t* Glyph(uint32_t cp, bool* known) {
    const int i = FindIndex(cp);
    if (i < 0) {
        if (known) *known = false;
        return reinterpret_cast<const uint8_t*>(kFallback);
    }
    if (known) *known = true;
    return reinterpret_cast<const uint8_t*>(font16::kGlyphs[i]);
}

uint32_t NextCodepoint(const char** p) {
    if (!p || !*p) return 0;
    if (**p == '\0') return 0;              // 串尾：不前进
    // 无长度上限：靠 NUL 兜底。截断的多字节序列会碰到 NUL(0x00) 而判非法。
    const char* q = *p;
    uint32_t cp = DecodeUtf8(&q, q + 4);
    *p = q;
    return cp;
}

int Width(const char* utf8, int byte_len) {
    if (!utf8 || byte_len <= 0) return 0;
    const char* end = utf8 + byte_len;
    const char* p = utf8;
    int w = 0;
    while (p < end) {
        const uint32_t cp = DecodeUtf8(&p, end);
        if (cp == '\n' || cp == '\r') continue;
        w += kCellW;
    }
    return w;
}

int WrapLines(const char* utf8, int byte_len, int max_px, int* line_start, int* line_end,
              int max_lines) {
    if (!utf8 || byte_len <= 0 || !line_start || !line_end || max_lines <= 0) return 0;
    if (max_px < kCellW) max_px = kCellW;   // 至少放一格，否则永远排不下
    const char* const base = utf8;
    const char* const end = utf8 + byte_len;

    int n = 0;
    const char* p = base;
    while (p < end && n < max_lines) {
        while (p < end && *p == ' ') ++p;    // 行首空格折叠掉
        if (p >= end) break;

        if (*p == '\n') {                    // 空行：写一对相同的偏移
            const int at = static_cast<int>(p - base);
            line_start[n] = at;
            line_end[n] = at;
            ++n;
            ++p;
            continue;
        }

        const char* ls = p;
        int w = 0;
        const char* fits = ls;               // 最后一个放得下的位置
        const char* legal = nullptr;         // 最后一个"断开后下一行不以禁则标点开头"的位置
        const char* stop = ls;               // 扫描停止处（遇到 '\n' 或宽度溢出）
        const char* resume = ls;             // 下一行起点
        bool hard = false;

        while (p < end) {
            const char* q = p;
            const uint32_t cp = DecodeUtf8(&q, end);
            if (cp == '\n') {                // 硬换行
                hard = true;
                stop = p;
                resume = q;
                break;
            }
            if (w + kCellW > max_px && w > 0) {   // 放不下，回退到已记录的断点
                stop = p;
                resume = p;
                break;
            }
            w += kCellW;
            fits = q;
            stop = q;
            resume = q;
            // 在 q 处断行是否合法：末字不是开括号，且下一字不是禁则行首标点
            const char* q2 = q;
            const uint32_t next_cp = (q < end) ? DecodeUtf8(&q2, end) : 0;
            const bool tail_ok = (q == end) || next_cp == '\n' || !IsNoLineStart(next_cp);
            if (!IsNoLineEnd(cp) && tail_ok) legal = q;
            p = q;
        }

        const char* le;
        if (hard || p >= end) {
            le = stop;
        } else {
            le = (legal && legal > ls) ? legal : fits;
            if (le <= ls) le = fits;         // 兜底：至少放已经放下的那一格
        }
        while (le > ls && (le[-1] == ' ' || le[-1] == '\r')) --le;   // 去掉行尾空格/CR
        if (le <= ls) le = ls + 1;           // 绝不允许零宽行（会死循环）

        line_start[n] = static_cast<int>(ls - base);
        line_end[n] = static_cast<int>(le - base);
        ++n;
        p = hard ? resume : le;
        if (p <= ls) p = ls + 1;             // 保底前进
    }
    return n;
}

void DrawRun(uint16_t* fb, int fb_w, int fb_h, int x, int y, const char* utf8, int byte_start,
             int byte_end, uint16_t fg_be, uint16_t bg_be) {
    if (!fb || !utf8 || fb_w <= 0 || fb_h <= 0) return;
    if (byte_start < 0) byte_start = 0;
    if (byte_end <= byte_start) return;
    const char* p = utf8 + byte_start;
    const char* end = utf8 + byte_end;
    int cx = x;
    while (p < end) {
        const uint32_t cp = DecodeUtf8(&p, end);
        if (cp == '\n' || cp == '\r') continue;   // 换行由调用方按 WrapLines 排版
        BlitGlyph(fb, fb_w, fb_h, cx, y, cp, fg_be, bg_be);
        cx += kCellW;
    }
}

}  // namespace text_draw
