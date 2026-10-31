// ws_frame.cc —— 见 ws_frame.h。
#include "ws_frame.h"

#include <cstring>

namespace ws_frame {
namespace {

constexpr size_t kHeaderMax = 14;   // 2 + 8(长度) + 4(mask)

// base64：只用来编码 16 字节随机数（Sec-WebSocket-Key），不用通用库
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

}  // namespace

void MakeAcceptKeyInput(const uint8_t rnd[16], char out[25]) {
    int o = 0;
    for (int i = 0; i < 16; i += 3) {
        const uint32_t a = rnd[i];
        const uint32_t b = (i + 1 < 16) ? rnd[i + 1] : 0;
        const uint32_t c = (i + 2 < 16) ? rnd[i + 2] : 0;
        const uint32_t triple = (a << 16) | (b << 8) | c;
        out[o++] = kB64[(triple >> 18) & 0x3F];
        out[o++] = kB64[(triple >> 12) & 0x3F];
        out[o++] = (i + 1 < 16) ? kB64[(triple >> 6) & 0x3F] : '=';
        out[o++] = (i + 2 < 16) ? kB64[triple & 0x3F] : '=';
    }
    out[24] = '\0';
}

size_t Build(uint8_t* out, size_t cap, uint8_t opcode, const void* payload, size_t len, uint32_t mask_key) {
    if (!out) return 0;
    const size_t need = 2 + (len < 126 ? 0 : (len < 65536 ? 2 : 8)) + 4 + len;
    if (cap < need) return 0;

    size_t i = 0;
    out[i++] = static_cast<uint8_t>(0x80 | (opcode & 0x0F));   // FIN=1
    if (len < 126) {
        out[i++] = static_cast<uint8_t>(0x80 | len);
    } else if (len < 65536) {
        out[i++] = 0x80 | 126;
        out[i++] = static_cast<uint8_t>((len >> 8) & 0xFF);
        out[i++] = static_cast<uint8_t>(len & 0xFF);
    } else {
        out[i++] = 0x80 | 127;
        for (int k = 7; k >= 0; --k) out[i++] = static_cast<uint8_t>((static_cast<uint64_t>(len) >> (k * 8)) & 0xFF);
    }

    const uint8_t* mk = reinterpret_cast<const uint8_t*>(&mask_key);
    out[i++] = mk[0];
    out[i++] = mk[1];
    out[i++] = mk[2];
    out[i++] = mk[3];

    const uint8_t* p = static_cast<const uint8_t*>(payload);
    for (size_t k = 0; k < len; ++k) out[i + k] = p[k] ^ mk[k & 3];
    i += len;
    return i;
}

ParseStatus Parse(uint8_t* buf, size_t have, size_t max_payload, Frame* out) {
    if (!buf || !out || have < 2) return ParseStatus::NeedMore;

    const uint8_t b0 = buf[0];
    const uint8_t b1 = buf[1];
    const bool fin = (b0 & 0x80) != 0;
    const uint8_t opcode = b0 & 0x0F;
    if (b0 & 0x70) return ParseStatus::Error;             // 保留位必须为 0（我们不协商扩展）
    if (opcode != kCont && opcode != kText && opcode != kBinary && opcode != kClose && opcode != kPing &&
        opcode != kPong) {
        return ParseStatus::Error;
    }

    const bool masked = (b1 & 0x80) != 0;
    uint64_t len = b1 & 0x7F;
    size_t off = 2;
    if (len == 126) {
        if (have < 4) return ParseStatus::NeedMore;
        len = (static_cast<uint64_t>(buf[2]) << 8) | buf[3];
        off = 4;
    } else if (len == 127) {
        if (have < 10) return ParseStatus::NeedMore;
        len = 0;
        for (int k = 0; k < 8; ++k) len = (len << 8) | buf[2 + k];
        off = 10;
    }
    if (len > max_payload) return ParseStatus::Error;

    const size_t mask_off = off;
    if (masked) off += 4;
    if (have < off + len) return ParseStatus::NeedMore;

    if (masked) {
        const uint8_t* mk = buf + mask_off;
        for (size_t k = 0; k < len; ++k) buf[off + k] ^= mk[k & 3];
    }

    out->opcode = opcode;
    out->fin = fin;
    out->payload = buf + off;
    out->len = static_cast<size_t>(len);
    out->consumed = off + static_cast<size_t>(len);
    (void)kHeaderMax;
    return ParseStatus::Ok;
}

}  // namespace ws_frame
