// clip_player.cc —— 从 TF 卡读 PCLP 容器（/sdcard/anim/<name>.bin）。
//
// 为什么从卡读：12 MB 的 app 槽装不下 9 段动画（9 MB），而补丁/编译一次就要重刷 10 MB。
// 放到卡上以后固件只剩 ~1.7 MB，想加几段就丢几个文件进 /sdcard/anim，不用重新编译。
//
// 内存策略：PSRAM 只有 8 MB，9 段全装会挤掉音频环形缓冲——
//   · 前 5 个（idle/look/happy/wave/tickle）在 Init 时**预加载**（说话/待机要即时切换）
//   · 后 4 个（shy/angry/dangle/roam）**懒加载**，第一次用到时读卡（~0.3 s，交互不频繁）
//   · 加载失败就地返回 -1，渲染层保持上一帧，不黑屏
#include "clip_player.h"

#include <cstdio>
#include <cstring>

#include "esp_heap_caps.h"
#include "esp_log.h"

extern "C" const uint8_t _binary_pet_idle_bin_start[];
extern "C" const uint8_t _binary_pet_idle_bin_end[];
extern "C" const uint8_t _binary_pet_look_bin_start[];
extern "C" const uint8_t _binary_pet_look_bin_end[];
extern "C" const uint8_t _binary_pet_wave_bin_start[];
extern "C" const uint8_t _binary_pet_wave_bin_end[];

namespace clip_player {
namespace {

constexpr const char* TAG = "clip";
constexpr const char* kDir = "/sdcard/anim";

struct Clip {
    const char* name = "";
    char path[48] = {0};
    bool ok = false;
    uint8_t* blob = nullptr;      // PSRAM 里的整个文件（懒加载）
    size_t len = 0;
    const uint8_t* offsets = nullptr;
    uint8_t* packed = nullptr;
    size_t packed_bytes = 0;
    int w = 0, h = 0, fps = 0, frames = 0, cur = -1;
    uint16_t pal[16] = {0};
};

Clip s_clips[kCount];
bool s_inited = false;
int s_loaded = 0;

inline uint16_t rd16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
inline uint32_t rd32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

struct Entry { Id id; const char* name; const char* label; };
// 只保留三段：待机 / 倾听 / 讲述（合计 3.46 MB，PSRAM 8 MB 装得下，
// 也能整体嵌进固件，不依赖 TF 卡）。其余 6 段的 mood 都映射到这三段。
const Entry kEntries[] = {
    {kIdle, "idle", "待机"},
    {kLook, "look", "倾听"},
    {kWave, "wave", "讲述"},
};
constexpr int kEntriesCount = sizeof(kEntries) / sizeof(kEntries[0]);
constexpr int kPreload = 3;   // 三段全常驻（3.46 MB）

/** 只读文件头：w/h/fps/frames/palette，不加载 body。 */
bool Probe(Clip& c, const Entry& e) {
    c.name = e.name;
    std::snprintf(c.path, sizeof(c.path), "%s/%s.bin", kDir, e.name);

    FILE* f = std::fopen(c.path, "rb");
    if (!f) {
        ESP_LOGW(TAG, "%s: 卡上没有 %s", e.label, c.path);
        return false;
    }
    uint8_t hdr[48];
    const size_t n = std::fread(hdr, 1, sizeof(hdr), f);
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fclose(f);

    if (n < 48 || std::memcmp(hdr, "PCLP", 4) != 0) {
        ESP_LOGW(TAG, "%s: 容器头无效（%ld B）", e.label, size);
        return false;
    }
    const uint16_t ver = rd16(hdr + 4);
    const int w = rd16(hdr + 6);
    const int h = rd16(hdr + 8);
    const int fps = rd16(hdr + 10);
    const int frames = rd16(hdr + 12);
    const uint16_t pals = rd16(hdr + 14);
    if (ver != 1 || w <= 0 || h <= 0 || w > 412 || h > 412 || frames <= 0) {
        ESP_LOGW(TAG, "%s: 参数不支持 ver=%u %dx%d f=%d", e.label, ver, w, h, frames);
        return false;
    }
    if (48 + (long)frames * 4 > size) {
        ESP_LOGW(TAG, "%s: offsets 越界（%ld B）", e.label, size);
        return false;
    }

    c.len = (size_t)size;
    c.w = w;
    c.h = h;
    c.fps = fps;
    c.frames = frames;
    for (int i = 0; i < 16; ++i) {
        c.pal[i] = (i < pals) ? (uint16_t)((hdr[16 + i * 2] << 8) | hdr[17 + i * 2]) : 0;
    }
    c.packed_bytes = ((size_t)w * (size_t)h + 1) / 2;
    c.packed = static_cast<uint8_t*>(
        heap_caps_malloc(c.packed_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!c.packed) c.packed = static_cast<uint8_t*>(heap_caps_malloc(c.packed_bytes, MALLOC_CAP_8BIT));
    if (!c.packed) {
        ESP_LOGE(TAG, "%s: 解码缓冲 %u KB 分配失败", e.label, (unsigned)(c.packed_bytes / 1024));
        return false;
    }
    std::memset(c.packed, 0, c.packed_bytes);
    c.cur = -1;
    c.ok = true;
    ESP_LOGI(TAG, "%s %dx%d @%dfps %d 帧 %.2f MB（卡）", e.label, w, h, fps, frames,
             (double)size / (1024.0 * 1024.0));
    return true;
}

/** 内嵌兜底：卡没插（或读不到）时至少还有 idle 能看。 */
bool ParseEmbedded(Clip& c, const uint8_t* begin, const uint8_t* end, const char* name) {
    const size_t len = (size_t)(end - begin);
    if (len < 48 || std::memcmp(begin, "PCLP", 4) != 0) return false;
    const int w = rd16(begin + 6);
    const int h = rd16(begin + 8);
    const int fps = rd16(begin + 10);
    const int frames = rd16(begin + 12);
    const uint16_t pals = rd16(begin + 14);
    if (w <= 0 || h <= 0 || frames <= 0) return false;
    c.name = name;
    c.blob = const_cast<uint8_t*>(begin);   // 指向 DROM，不参与 free
    c.len = len;
    c.offsets = begin + 48;
    c.w = w; c.h = h; c.fps = fps; c.frames = frames;
    for (int i = 0; i < 16; ++i) {
        c.pal[i] = (i < pals) ? (uint16_t)((begin[16 + i * 2] << 8) | begin[17 + i * 2]) : 0;
    }
    c.packed_bytes = ((size_t)w * (size_t)h + 1) / 2;
    c.packed = static_cast<uint8_t*>(
        heap_caps_malloc(c.packed_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!c.packed) c.packed = static_cast<uint8_t*>(heap_caps_malloc(c.packed_bytes, MALLOC_CAP_8BIT));
    if (!c.packed) return false;
    std::memset(c.packed, 0, c.packed_bytes);
    c.cur = -1;
    c.ok = true;
    ESP_LOGW(TAG, "%s 用内嵌兜底 %dx%d %d 帧 %.2f MB（卡上没读到）", name, w, h, frames,
             (double)len / (1024.0 * 1024.0));
    return true;
}

/** 第一次用到才把整段读进 PSRAM。 */
bool EnsureLoaded(Clip& c) {
    if (c.blob) return true;
    if (!c.ok) return false;
    uint8_t* buf = static_cast<uint8_t*>(
        heap_caps_malloc(c.len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!buf) {
        ESP_LOGW(TAG, "%s: PSRAM 不足（要 %.2f MB）", c.name, (double)c.len / (1024.0 * 1024.0));
        return false;
    }
    FILE* f = std::fopen(c.path, "rb");
    if (!f) {
        heap_caps_free(buf);
        return false;
    }
    const size_t got = std::fread(buf, 1, c.len, f);
    std::fclose(f);
    if (got != c.len) {
        ESP_LOGW(TAG, "%s: 读不全 %u/%u B", c.name, (unsigned)got, (unsigned)c.len);
        heap_caps_free(buf);
        return false;
    }
    c.blob = buf;
    c.offsets = buf + 48;
    ESP_LOGI(TAG, "%s: 已从卡载入 %.2f MB", c.name, (double)c.len / (1024.0 * 1024.0));
    return true;
}

}  // namespace

bool Ready(Id id) { return id >= 0 && id < kCount && s_clips[id].ok && s_clips[id].packed; }
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
    for (const Entry& e : kEntries) {
        if (Probe(s_clips[e.id], e)) { ++s_loaded; continue; }
        // 卡没插/读不到：idle 用固件里那份，保证屏幕上还有她
        // 三段都内嵌在固件里：卡不在位也能完整显示
        const uint8_t* b = nullptr;
        const uint8_t* en = nullptr;
        if (e.id == kIdle) { b = _binary_pet_idle_bin_start; en = _binary_pet_idle_bin_end; }
        else if (e.id == kLook) { b = _binary_pet_look_bin_start; en = _binary_pet_look_bin_end; }
        else if (e.id == kWave) { b = _binary_pet_wave_bin_start; en = _binary_pet_wave_bin_end; }
        if (b && ParseEmbedded(s_clips[e.id], b, en, e.name)) ++s_loaded;
    }
    int pre = 0;
    for (const Entry& e : kEntries) {
        if (e.id >= kPreload) break;
        if (EnsureLoaded(s_clips[e.id])) ++pre;
    }
    for (const Entry& e : kEntries) {
        const Clip& c = s_clips[e.id];
        ESP_LOGI(TAG, "自检 %-5s Ready=%d blob=%d packed=%d frames=%d len=%u", e.name, (int)Ready(e.id),
                 c.blob ? 1 : 0, c.packed ? 1 : 0, c.frames, (unsigned)c.len);
    }
    size_t bytes = 0;
    for (int i = 0; i < kCount; ++i) if (s_clips[i].blob) bytes += s_clips[i].len;
    ESP_LOGI(TAG, "桌宠 clip 就绪 %d/%d（预载 %d 段 / %.2f MB PSRAM）",
             s_loaded, (int)kCount, pre, (double)bytes / (1024.0 * 1024.0));
    return s_loaded > 0;
}

void Rewind(Id id) {
    if (!Ready(id)) return;
    Clip& c = s_clips[id];
    std::memset(c.packed, 0, c.packed_bytes);
    c.cur = -1;
}

int Next(Id id, uint16_t* fb, int stride, int x, int y, const uint16_t* pal_be) {
    if (!Ready(id) || !fb || !pal_be) return -1;
    Clip& c = s_clips[id];
    if (!EnsureLoaded(c)) return -1;   // 卡没插 / PSRAM 不足：让渲染层保持上一帧

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

    const int npix = c.w * c.h;
    int p = 0;
    for (int row = 0; row < c.h; ++row) {
        uint16_t* dst = fb + (size_t)(y + row) * (size_t)stride + x;
        for (int col = 0; col < c.w && p < npix; ++col, ++p) {
            const uint8_t b = c.packed[(size_t)p >> 1];
            const uint8_t pi = (p & 1) ? uint8_t(b & 0x0F) : uint8_t(b >> 4);
            if (pi) dst[col] = pal_be[pi];
        }
    }
    c.cur = idx;
    return idx;
}

}  // namespace clip_player
