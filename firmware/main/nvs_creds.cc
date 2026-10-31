// nvs_creds.cc —— 见 nvs_creds.h。
#include "nvs_creds.h"

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "esp_partition.h"

namespace nvs_creds {
namespace {

constexpr const char* TAG = "nvsrd";
constexpr int kPageSize = 4096;
constexpr int kEntryBase = 64;        // 32 字节页头 + 32 字节 entry-state 位图
constexpr int kEntrySize = 32;
constexpr int kMaxEntries = (kPageSize - kEntryBase) / kEntrySize;

constexpr uint32_t kPageStateEmpty = 0xFFFFFFFF;
constexpr uint32_t kPageStateActive = 0xFFFFFFFE;
constexpr uint32_t kPageStateFull = 0xFFFFFFFC;

uint32_t Rd32(const uint8_t* p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

// 把一条（可能跨多条）blob 的数据拷出来。返回有效字节数。
// 关键细节（实测 backup/nvs_orig.bin 得出，别按直觉写）：
//   首条的 data[8] **不是**载荷，而是元数据：[u16 size][u16 0xFFFF][u32 crc]。
//   真正的载荷从下一条开始，每条 32 字节整块，最后一条用 0x00/0xFF 补齐。
//   所以载荷长度以元数据里的 size 为准，不受补齐影响。
size_t GatherBlob(const uint8_t* page, int entry_idx, size_t entry_off_in_page, uint8_t* out, size_t cap) {
    const uint8_t* e = page + entry_off_in_page;
    const uint8_t span = e[2];
    if (span == 0) return 0;
    const size_t size = size_t(e[24]) | (size_t(e[25]) << 8);
    size_t n = 0;
    for (int k = 1; k < span && entry_idx + k < kMaxEntries; ++k) {
        const uint8_t* next = page + kEntryBase + (entry_idx + k) * kEntrySize;
        for (size_t i = 0; i < kEntrySize && n < cap; ++i) out[n++] = next[i];
    }
    return (size < n) ? size : n;
}

struct ScanState {
    // 统计（只用于日志，不含凭据内容）
    struct Probe {
        bool found_ssid = false;
        bool found_pswd = false;
        int pages_scanned = 0;
        int entries_scanned = 0;
    } probe;
    bool got_ssid = false;
    bool got_pswd = false;
    char* ssid = nullptr;
    size_t ssid_cap = 0;
    char* pass = nullptr;
    size_t pass_cap = 0;
};

bool KeyIs(const uint8_t* e, const char* key) {
    return std::strncmp(reinterpret_cast<const char*>(e + 8), key, 16) == 0;
}

void HandleEntry(ScanState& st, const uint8_t* page, int idx, size_t off) {
    const uint8_t* e = page + off;
    ++st.probe.entries_scanned;

    if (!st.got_ssid && KeyIs(e, "sta.ssid")) {
        uint8_t buf[64];
        const size_t n = GatherBlob(page, idx, off, buf, sizeof(buf));
        if (n >= 4) {
            // 载荷 = uint32 长度 + ssid[32]（小智那层是这么存的，已用 nvs_orig.bin 核对）
            uint32_t len = Rd32(buf);
            if (len > 32) len = 32;
            if (len > 0 && len + 4 <= n) {
                const size_t cp = (len < st.ssid_cap - 1) ? len : st.ssid_cap - 1;
                std::memcpy(st.ssid, buf + 4, cp);
                st.ssid[cp] = '\0';
                st.got_ssid = true;
                st.probe.found_ssid = true;
            }
        }
    } else if (!st.got_pswd && KeyIs(e, "sta.pswd")) {
        uint8_t buf[96];
        const size_t n = GatherBlob(page, idx, off, buf, sizeof(buf));
        // 密码是裸字符串（NUL 结尾），没有长度前缀
        size_t len = 0;
        while (len < n && buf[len] != 0 && len < 64) ++len;
        if (len > 0) {
            const size_t cp = (len < st.pass_cap - 1) ? len : st.pass_cap - 1;
            std::memcpy(st.pass, buf, cp);
            st.pass[cp] = '\0';
            st.got_pswd = true;
            st.probe.found_pswd = true;
        }
    }
}

}  // namespace

bool ReadStaCreds(char* ssid, size_t ssid_cap, char* pass, size_t pass_cap) {
    if (!ssid || !pass || ssid_cap < 2 || pass_cap < 2) return false;
    ssid[0] = '\0';
    pass[0] = '\0';

    const esp_partition_t* part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, "nvs");
    if (!part) {
        ESP_LOGW(TAG, "找不到 nvs 分区");
        return false;
    }
    ESP_LOGI(TAG, "nvs 分区 @0x%lx 大小 %lu 字节（%lu 页）", (unsigned long)part->address,
             (unsigned long)part->size, (unsigned long)(part->size / kPageSize));

    static uint8_t page[kPageSize];
    ScanState st;
    st.ssid = ssid;
    st.ssid_cap = ssid_cap;
    st.pass = pass;
    st.pass_cap = pass_cap;

    bool logged_head = false;
    for (size_t off = 0; off + kPageSize <= part->size; off += kPageSize) {
        const esp_err_t rerr = esp_partition_read(part, off, page, kPageSize);
        if (rerr != ESP_OK) {
            ESP_LOGW(TAG, "读页失败 off=0x%lx err=0x%x", (unsigned long)off, (unsigned)rerr);
            break;
        }
        const uint32_t state = Rd32(page);
        if (!logged_head) {
            logged_head = true;
            // 前 4 页的 page_state 打出来：
            //   0xfffffffc=FULL / 0xfffffffe=ACTIVE / 0xffffffff=已擦
            // 若全是 0xffffffff，说明这份 NVS 被整片擦过 ——
            // 小智当年写的凭据在设备上已经没了，不是解析器的错。
            char line[128];
            int n = std::snprintf(line, sizeof(line), "前4页 page_state:");
            static uint8_t tmp[kPageSize];
            for (int i = 0; i < 4 && (size_t)(i + 1) * kPageSize <= part->size; ++i) {
                if (esp_partition_read(part, size_t(i) * kPageSize, tmp, kPageSize) != ESP_OK) break;
                n += std::snprintf(line + n, sizeof(line) - n, " p%d=0x%08x", i, (unsigned)Rd32(tmp));
            }
            ESP_LOGI(TAG, "%s", line);
        }
        if (state == kPageStateEmpty) continue;
        if (state != kPageStateActive && state != kPageStateFull) continue;
        ++st.probe.pages_scanned;

        for (int i = 0; i < kMaxEntries; ++i) {
            const size_t eoff = kEntryBase + size_t(i) * kEntrySize;
            const uint8_t ns = page[eoff + 0];
            const uint8_t type = page[eoff + 1];
            if (ns == 0xFF && type == 0xFF) continue;   // 空条目
            HandleEntry(st, page, i, eoff);
            if (st.got_ssid && st.got_pswd) {
                ESP_LOGI(TAG, "从裸 NVS 读回凭据（%d 页 / %d 条）", st.probe.pages_scanned,
                         st.probe.entries_scanned);
                return true;
            }
        }
    }
    ESP_LOGW(TAG, "裸 NVS 里没找全凭据：ssid=%d pswd=%d（扫了 %d 页）", st.got_ssid ? 1 : 0,
             st.got_pswd ? 1 : 0, st.probe.pages_scanned);
    return st.got_ssid && st.got_pswd;
}

}  // namespace nvs_creds
