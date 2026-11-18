// clip_player.cc —— 播放**内嵌在固件里**的桌宠 clip（PCLP 容器，6 段：idle/look/happy/wave/tickle/shy）。
//
// 2026-11-02：删掉 v1 时代的"SD 卡优先"路径，只读内嵌 DROM（零拷贝）。
// 2026-11-03：① 接入摸摸头互动动画（happy/tickle/shy，来自 v1 归档同格式素材）；
//             ② **解码缓冲改为全模块共享一份**（原来每段一份，6 段 ≈ 84 KB → 一份 ≈ 14 KB），
//                只可能有一段在播，共享是安全的；同时减少 PSRAM 碎片。
//
// 内存：每段只需 w*h/2 字节的 4bpp 打包帧（154×180 ≈ 13.5 KB），共享一份按最大段分配。
// 素材：换 pet_*.bin 重新编译；不再有"卡上版本 vs 内嵌版本"两套真源。
#include "clip_player.h"

#include <cstring>

#include "esp_heap_caps.h"
#include "esp_log.h"

namespace clip_player {
namespace {

constexpr const char* TAG = "clip";

struct Clip {
    const char* name = "";
    bool ok = false;
    const uint8_t* blob = nullptr;   // 指向 DROM 内的 PCLP 文件，不参与 free
    size_t len = 0;
    const uint8_t* offsets = nullptr;
    uint8_t* packed = nullptr;       // 指向共享解码缓冲
    size_t packed_bytes = 0;
    int w = 0, h = 0, fps = 0, frames = 0, cur = -1;
    uint16_t pal[16] = {0};
};

Clip s_clips[kCount];
bool s_inited = false;
int s_loaded = 0;
uint8_t* s_packed = nullptr;       // 全模块共享
size_t s_packed_cap = 0;

inline uint16_t rd16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
inline uint32_t rd32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

struct Blob { Id id; const char* name; const char* label; const uint8_t* begin; const uint8_t* end; };

extern "C" const uint8_t _binary_pet_idle_bin_start[];
extern "C" const uint8_t _binary_pet_idle_bin_end[];
extern "C" const uint8_t _binary_pet_look_bin_start[];
extern "C" const uint8_t _binary_pet_look_bin_end[];
extern "C" const uint8_t _binary_pet_happy_bin_start[];
extern "C" const uint8_t _binary_pet_happy_bin_end[];
extern "C" const uint8_t _binary_pet_wave_bin_start[];
extern "C" const uint8_t _binary_pet_wave_bin_end[];
extern "C" const uint8_t _binary_pet_tickle_bin_start[];
extern "C" const uint8_t _binary_pet_tickle_bin_end[];
extern "C" const uint8_t _binary_pet_shy_bin_start[];
extern "C" const uint8_t _binary_pet_shy_bin_end[];

const Blob kBlobs[] = {
    {kIdle, "idle", "待机", _binary_pet_idle_bin_start, _binary_pet_idle_bin_end},
    {kLook, "look", "倾听", _binary_pet_look_bin_start, _binary_pet_look_bin_end},
    {kHappy, "happy", "开心", _binary_pet_happy_bin_start, _binary_pet_happy_bin_end},
    {kWave, "wave", "讲述", _binary_pet_wave_bin_start, _binary_pet_wave_bin_end},
    {kTickle, "tickle", "痒痒", _binary_pet_tickle_bin_start, _binary_pet_tickle_bin_end},
    {kShy, "shy", "害羞", _binary_pet_shy_bin_start, _binary_pet_shy_bin_end},
};
constexpr int kBlobCount = sizeof(kBlobs) / sizeof(kBlobs[0]);

/** 只解析头部/调色板/帧偏移；解码缓冲在 Init 里统一分配（共享一份）。 */
bool ParseEmbedded(Clip& c, const Blob& b) {
    const uint8_t* begin = b.begin;
    const size_t len = (size_t)(b.end - b.begin);
    if (!begin || len < 48 || std::memcmp(begin, "PCLP", 4) != 0) {
        ESP_LOGE(TAG, "%s: 内嵌容器缺失或头无效（%u B）", b.label, (unsigned)len);
        return false;
    }
    const uint16_t ver = rd16(begin + 4);
    const int w = rd16(begin + 6);
    const int h = rd16(begin + 8);
    const int fps = rd16(begin + 10);
    const int frames = rd16(begin + 12);
    const uint16_t pals = rd16(begin + 14);
    if (ver != 1 || w <= 0 || h <= 0 || w > 412 || h > 412 || frames <= 0) {
        ESP_LOGE(TAG, "%s: 参数不支持 ver=%u %dx%d f=%d", b.label, ver, w, h, frames);
        return false;
    }
    if (48 + (size_t)frames * 4 > len) {
        ESP_LOGE(TAG, "%s: offsets 越界（%u B）", b.label, (unsigned)len);
        return false;
    }

    c.name = b.name;
    c.blob = begin;
    c.len = len;
    c.offsets = begin + 48;
    c.w = w;
    c.h = h;
    c.fps = fps;
    c.frames = frames;
    for (int i = 0; i < 16; ++i) {
        c.pal[i] = (i < pals) ? (uint16_t)((begin[16 + i * 2] << 8) | begin[17 + i * 2]) : 0;
    }
    c.packed_bytes = ((size_t)w * (size_t)h + 1) / 2;
    c.cur = -1;
    c.ok = true;
    return true;
}

}  // namespace

bool Ready(Id id) {
    return id >= 0 && id < kCount && s_clips[id].ok && s_clips[id].packed != nullptr;
}
int Loaded() { return s_loaded; }
int Width(Id id) { return Ready(id) ? s_clips[id].w : 0; }
int Height(Id id) { return Ready(id) ? s_clips[id].h : 0; }
int Fps(Id id) { return Ready(id) ? s_clips[id].fps : 0; }
int Frames(Id id) { return Ready(id) ? s_clips[id].frames : 0; }
const uint16_t* Palette(Id id) { return Ready(id) ? s_clips[id].pal : nullptr; }
int Current(Id id) { return Ready(id) ? s_clips[id].cur : -1; }

bool Init() {
    if (s_inited) return s_loaded > 0;
    s_inited = true;
    s_loaded = 0;

    // 1) 先解析全部头，算出最大解码缓冲（共享一份即可：同一时刻只有一段在播）
    for (const Blob& b : kBlobs) {
        if (ParseEmbedded(s_clips[b.id], b)) {
            if (s_clips[b.id].packed_bytes > s_packed_cap) s_packed_cap = s_clips[b.id].packed_bytes;
        }
    }
    if (s_packed_cap == 0) {
        ESP_LOGE(TAG, "没有任何可用 clip（素材缺失/头无效）");
        return false;
    }
    s_packed = static_cast<uint8_t*>(heap_caps_malloc(s_packed_cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!s_packed) s_packed = static_cast<uint8_t*>(heap_caps_malloc(s_packed_cap, MALLOC_CAP_8BIT));
    if (!s_packed) {
        ESP_LOGE(TAG, "共享解码缓冲 %u KB 分配失败（PSRAM 不足）", (unsigned)(s_packed_cap / 1024));
        for (int i = 0; i < kCount; ++i) s_clips[i].ok = false;
        return false;
    }
    std::memset(s_packed, 0, s_packed_cap);
    for (int i = 0; i < kCount; ++i) {
        if (s_clips[i].ok) {
            s_clips[i].packed = s_packed;
            ++s_loaded;
        }
    }
    ESP_LOGI(TAG, "桌宠 clip 就绪 %d/%d（%d 段内嵌；共享解码缓冲 %.1f KB PSRAM）", s_loaded, (int)kCount,
             (int)kBlobCount, (double)s_packed_cap / 1024.0);
    return s_loaded > 0;
}

void Rewind(Id id) {
    if (!Ready(id)) return;
    Clip& c = s_clips[id];
    std::memset(c.packed, 0, c.packed_bytes);
    c.cur = -1;
}

static int Step(Id id, uint16_t* fb, int stride, int x, int y, const uint16_t* pal_be,
                int scale_q8) {
    if (!Ready(id) || !fb || !pal_be) return -1;
    Clip& c = s_clips[id];

    const int idx = (c.cur + 1) % c.frames;
    const uint32_t off = rd32(c.offsets + (size_t)idx * 4);
    if ((size_t)off + 4 > c.len) return -1;
    const uint16_t rle = rd16(c.blob + off);
    const uint16_t flags = rd16(c.blob + off + 2);
    const uint8_t* body = c.blob + off + 4;
    if ((size_t)off + 4 + rle > c.len) return -1;

    if (idx == 0 || c.cur < 0) std::memset(c.packed, 0, c.packed_bytes);

    size_t o = 0;
    for (size_t i = 0; i + 1 < (size_t)rle; i += 2) {
        const uint8_t v = body[i];
        const uint8_t n = body[i + 1];
        if (n == 0) continue;
        if (o + n > c.packed_bytes) break;
        if (flags & 1) {
            uint8_t* dst = c.packed + o;
            for (int k = 0; k < n; ++k) dst[k] ^= v;
        } else {
            std::memset(c.packed + o, v, n);
        }
        o += n;
    }

    // 8.8 定点最近邻放大：桌宠在圆屏上偏小、黑边多，2026-11-13 用户要求放大一点。
    const int q = scale_q8 < 64 ? 64 : scale_q8;
    const int dw = (c.w * q + 128) >> 8;
    const int dh = (c.h * q + 128) >> 8;
    for (int dr = 0; dr < dh; ++dr) {
        int sr = (dr * 256) / q;
        if (sr >= c.h) sr = c.h - 1;
        uint16_t* dst = fb + (size_t)(y + dr) * (size_t)stride + x;
        const int src_row = sr * c.w;
        for (int dc = 0; dc < dw; ++dc) {
            int sc = (dc * 256) / q;
            if (sc >= c.w) sc = c.w - 1;
            const int p = src_row + sc;
            const uint8_t b = c.packed[(size_t)p >> 1];
            const uint8_t pi = (p & 1) ? uint8_t(b & 0x0F) : uint8_t(b >> 4);
            if (pi) dst[dc] = pal_be[pi];
        }
    }
    c.cur = idx;
    return idx;
}

int Next(Id id, uint16_t* fb, int stride, int x, int y, const uint16_t* pal_be) {
    return Step(id, fb, stride, x, y, pal_be, 256);
}

int NextScaled(Id id, uint16_t* fb, int stride, int x, int y, const uint16_t* pal_be,
               int scale_q8) {
    return Step(id, fb, stride, x, y, pal_be, scale_q8);
}

}  // namespace clip_player
