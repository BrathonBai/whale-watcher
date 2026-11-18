// adpcm.cc —— 见 adpcm.h。逐样本/逐字节与 bridge/lib/adpcm.js 对齐。
//
// 契约：docs/协议-v2-契约.md §6（2026-11-13 裁决版：
// 块 = 1024 字节 = 4B 头 + 1020B nibbles = 2041 采样，头里的 predictor 就是本块
// 第一个 PCM 采样；编码从第 2 个采样开始，解码先输出头采样）。
#include "adpcm.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "esp_heap_caps.h"

#include "adpcm_vectors.h"

namespace adpcm {
namespace {

// 标准 IMA ADPCM step 表（89 项）与 index 调整表（16 项）。
constexpr int32_t kStep[89] = {
    7,     8,     9,     10,    11,    12,    13,    14,    16,    17,    19,    21,    23,
    25,    28,    31,    34,    37,    41,    45,    50,    55,    60,    66,    73,    80,
    88,    97,   107,   118,   130,   143,   157,   173,   190,   209,   230,   253,   279,
    307,   337,   371,   408,   449,   494,   544,   598,   658,   724,   796,   876,   963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
    4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
};
constexpr int8_t kIndexAdj[16] = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};

inline int16_t Clip16(int32_t v) { return v < -32768 ? int16_t(-32768) : (v > 32767 ? int16_t(32767) : int16_t(v)); }
inline uint8_t ClipIndex(int32_t i) { return i < 0 ? uint8_t(0) : (i > 88 ? uint8_t(88) : uint8_t(i)); }

// 解码一个 nibble：更新 state，返回新 predictor。
// 与 JS expandNibble 完全一致：先按**旧 index** 的 step 更新 predictor，再调 index。
inline int16_t Expand(Encoder* st, uint8_t nib) {
    const int32_t step = kStep[st->index];
    int32_t diffq = step >> 3;
    if (nib & 4) diffq += step;
    if (nib & 2) diffq += step >> 1;
    if (nib & 1) diffq += step >> 2;
    st->predictor = Clip16(int32_t(st->predictor) + ((nib & 8) ? -diffq : diffq));
    st->index = ClipIndex(int32_t(st->index) + kIndexAdj[nib & 0xf]);
    return st->predictor;
}

// 单采样编码：就地推进 state，返回 4 bit code（与 JS compressSample / ffmpeg 同序）。
inline uint8_t Compress(Encoder* st, int16_t sample) {
    const int32_t step = kStep[st->index];
    int32_t diff = int32_t(sample) - int32_t(st->predictor);
    uint8_t nib = 0;
    if (diff < 0) {
        nib = 8;
        diff = -diff;
    }
    if (diff >= step) {
        nib |= 4;
        diff -= step;
    }
    if (diff >= (step >> 1)) {
        nib |= 2;
        diff -= step >> 1;
    }
    if (diff >= (step >> 2)) nib |= 1;
    Expand(st, nib);   // 与解码端同一张表推进状态
    return nib;
}

// ---------------------------------------------------------------- 十六进制
int HexNibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// 解析十六进制字符串 → 字节；返回字节数，0 = 格式非法/超容量。
size_t ParseHex(const char* hex, uint8_t* out, size_t cap) {
    if (!hex || !out) return 0;
    const size_t n = std::strlen(hex);
    if ((n & 1) != 0 || n / 2 > cap) return 0;
    for (size_t i = 0; i < n; i += 2) {
        const int hi = HexNibble(hex[i]);
        const int lo = HexNibble(hex[i + 1]);
        if (hi < 0 || lo < 0) return 0;
        out[i / 2] = uint8_t((hi << 4) | lo);
    }
    return n / 2;
}

}  // namespace

// ============================ 编码 ============================
size_t EncodeBlock(Encoder* st, const int16_t* pcm, int count, uint8_t* out, size_t cap) {
    if (!st || !pcm || !out) return 0;
    if (count < 1 || count > kSamplesPerBlock) return 0;
    // 块头采样 + 偶数个 nibble 才自洽：偶数采样数时多编 1 个（补齐）采样。
    const bool padded = (count % 2) == 0;
    const int nibble_samples = padded ? count : count - 1;
    const size_t bytes = size_t(kHeaderBytes) + size_t(nibble_samples / 2);
    if (cap < bytes) return 0;

    st->predictor = pcm[0];   // 块头 = 本块第一个采样
    out[0] = uint8_t(uint16_t(st->predictor) & 0xff);
    out[1] = uint8_t((uint16_t(st->predictor) >> 8) & 0xff);
    out[2] = st->index;
    out[3] = 0;

    size_t o = kHeaderBytes;
    for (int i = 0; i < nibble_samples; i += 2) {
        const int j0 = 1 + i;
        const int j1 = 2 + i;
        // 越界位置按 0（与 JS 的 `?? 0` 一致；偶数末块会读 count 位置用于补齐）。
        uint8_t byte = uint8_t(Compress(st, j0 < count ? pcm[j0] : 0) & 0xf);
        if (i + 1 < nibble_samples) {
            byte = uint8_t(byte | ((Compress(st, j1 < count ? pcm[j1] : 0) & 0xf) << 4));
        }
        out[o++] = byte;
    }
    return bytes;
}

size_t EncodePcm(const int16_t* pcm, int samples, uint8_t* out, size_t cap) {
    if (!pcm || samples <= 0 || !out) return 0;
    const size_t need = EncodedSizeForSamples(samples);
    if (need == 0 || cap < need) return 0;
    Encoder st;
    size_t off = 0;
    int pos = 0;
    while (pos < samples) {
        const int n = (samples - pos) > kSamplesPerBlock ? kSamplesPerBlock : (samples - pos);
        const size_t w = EncodeBlock(&st, pcm + pos, n, out + off, cap - off);
        if (w == 0) return 0;
        off += w;
        pos += n;   // 与 JS `covered` 一致：偶数末块多编的 1 个采样不前进
    }
    return off;
}

size_t EncodedSizeForSamples(int samples) {
    if (samples <= 0) return 0;
    size_t total = 0;
    int pos = 0;
    while (pos < samples) {
        const int n = (samples - pos) > kSamplesPerBlock ? kSamplesPerBlock : (samples - pos);
        const int nibble_samples = ((n % 2) == 0) ? n : (n - 1);
        total += size_t(kHeaderBytes) + size_t(nibble_samples / 2);
        pos += n;
    }
    return total;
}

// ============================ 解码 ============================
int DecodeBlock(const uint8_t* in, size_t len, int16_t* out, int cap) {
    if (!in || !out) return 0;
    if (len < size_t(kHeaderBytes) || len > size_t(kBlockBytes)) return 0;
    const int nibbles = int(len) - kHeaderBytes;
    const int n = nibbles * 2 + 1;
    if (cap < n) return 0;

    Encoder st;
    st.predictor = int16_t(uint16_t(in[0]) | (uint16_t(in[1]) << 8));
    st.index = ClipIndex(in[2]);
    out[0] = st.predictor;   // 头采样就是本块第 1 个 PCM 采样
    int s = 1;
    for (int i = 0; i < nibbles; ++i) {
        const uint8_t byte = in[kHeaderBytes + i];
        out[s++] = Expand(&st, uint8_t(byte & 0xf));
        out[s++] = Expand(&st, uint8_t((byte >> 4) & 0xf));
    }
    return n;
}

int DecodeBlocks(const uint8_t* in, size_t len, int16_t* out, int cap, size_t* consumed) {
    if (!in || !out) return 0;
    size_t off = 0;
    int total = 0;
    while (len - off >= size_t(kHeaderBytes)) {
        const size_t remain = len - off;
        const size_t block_bytes = remain >= size_t(kBlockBytes) ? size_t(kBlockBytes) : remain;
        const int n = (int(block_bytes) - kHeaderBytes) * 2 + 1;
        if (total + n > cap) break;
        const int got = DecodeBlock(in + off, block_bytes, out + total, cap - total);
        if (got <= 0) break;
        total += got;
        off += block_bytes;
    }
    if (consumed) *consumed = off;
    return total;
}

// ============================ 自检 ============================
// 共享向量：bridge/test/fixtures/adpcm-vectors.json（桥侧已用 ffmpeg 交叉验证）。
// 固件不读文件，所以由 tools/gen_adpcm_vectors.mjs 生成为 adpcm_vectors.h 内嵌常量。
bool SelfTest(char* report, size_t cap) {
    if (!report || cap == 0) return false;
    report[0] = '\0';
    size_t used = 0;
    auto add = [&](const char* fmt, ...) {
        if (used + 1 >= cap) return;
        va_list ap;
        va_start(ap, fmt);
        const int n = std::vsnprintf(report + used, cap - used, fmt, ap);
        va_end(ap);
        if (n > 0) {
            used += size_t(n);
            if (used >= cap) used = cap - 1;
        }
    };

    // 一次申请 16 KB PSRAM 做所有向量缓冲（自检是串口手工触发，用完即还）。
    constexpr size_t kArena = 16 * 1024;
    uint8_t* arena = static_cast<uint8_t*>(heap_caps_malloc(kArena, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!arena) {
        std::snprintf(report, cap, "FAIL: PSRAM 不足（需要 %u B）", unsigned(kArena));
        return false;
    }

    // 布局：adpcmIn(1024) | pcmIn(4096) | pcmOut(4096) | adpcmOut(1024)
    uint8_t* adpcm_in = arena;
    uint8_t* pcm_in = adpcm_in + 1024;
    uint8_t* pcm_out = pcm_in + 4096;
    uint8_t* adpcm_out = pcm_out + 4096;

    bool all_ok = true;
    add(">adpcm 共享向量自检（%d 条解码 + %d 条编码）\n", vectors::kDecodeCount, vectors::kEncodeCount);

    // ---- decode[i]：ADPCM 块 → 期望 PCM（逐采样）----
    // 向量目前只有一条（2041 采样/1024B），但按数组遍历，桥侧加向量后重生成即可。
    {
        const char* adpcm_hex = vectors::kDecode0AdpcmHex;
        const char* pcm_hex = vectors::kDecode0PcmHex;
        const int want_samples = vectors::kDecode0Samples;
        const size_t a_len = ParseHex(adpcm_hex, adpcm_in, 1024);
        const size_t p_len = ParseHex(pcm_hex, pcm_in, 4096);
        if (a_len == 0 || p_len == 0 || int(p_len / 2) != want_samples) {
            add("  decode[0] 向量解析失败（adpcm=%u pcm=%u）... FAIL\n", unsigned(a_len), unsigned(p_len));
            all_ok = false;
        } else {
            const int got = DecodeBlock(adpcm_in, a_len, reinterpret_cast<int16_t*>(pcm_out), 2048);
            int max_diff = 0;
            int bad = 0;
            const int16_t* want = reinterpret_cast<const int16_t*>(pcm_in);
            const int16_t* have = reinterpret_cast<const int16_t*>(pcm_out);
            if (got != want_samples) {
                bad = 1;
            } else {
                for (int i = 0; i < got; ++i) {
                    const int d = int(want[i]) - int(have[i]);
                    const int ad = d < 0 ? -d : d;
                    if (ad > max_diff) max_diff = ad;
                    if (ad != 0) ++bad;
                }
            }
            const bool ok = (bad == 0 && got == want_samples);
            all_ok = all_ok && ok;
            add("  decode[0] %4d 采样/%4u B  maxDiff=%d %s\n", got, unsigned(a_len), max_diff,
                ok ? "PASS" : "FAIL");
        }
    }

    // ---- encode[i]：PCM → 期望 ADPCM（逐字节）----
    for (int i = 0; i < vectors::kEncodeCount; ++i) {
        const char* pcm_hex = (i == 0) ? vectors::kEncode0PcmHex : vectors::kEncode1PcmHex;
        const char* adpcm_hex = (i == 0) ? vectors::kEncode0AdpcmHex : vectors::kEncode1AdpcmHex;
        const int want_samples = (i == 0) ? vectors::kEncode0Samples : vectors::kEncode1Samples;
        const size_t p_len = ParseHex(pcm_hex, pcm_in, 4096);
        const size_t a_len = ParseHex(adpcm_hex, adpcm_in, 1024);
        if (p_len == 0 || a_len == 0 || int(p_len / 2) != want_samples) {
            add("  encode[%d] 向量解析失败（pcm=%u adpcm=%u）... FAIL\n", i, unsigned(p_len),
                unsigned(a_len));
            all_ok = false;
            continue;
        }
        const size_t got = EncodePcm(reinterpret_cast<const int16_t*>(pcm_in), want_samples, adpcm_out,
                                     kArena - size_t(adpcm_out - arena));
        if (got != a_len) {
            add("  encode[%d] %4d 采样 → %u B（期望 %u B）... FAIL\n", i, want_samples, unsigned(got),
                unsigned(a_len));
            all_ok = false;
            continue;
        }
        const int cmp = std::memcmp(adpcm_out, adpcm_in, a_len);
        all_ok = all_ok && (cmp == 0);
        add("  encode[%d] %4d 采样 → %4u B  %s\n", i, want_samples, unsigned(got),
            cmp == 0 ? "PASS（逐字节一致）" : "FAIL（字节不一致）");
    }

    add("  RESULT: %s", all_ok ? "PASS" : "FAIL");
    heap_caps_free(arena);
    return all_ok;
}

}  // namespace adpcm
