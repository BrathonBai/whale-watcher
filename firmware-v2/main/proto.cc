// proto.cc —— 见 proto.h。手写极小 JSON 扫描器：只为 5 种下行消息服务，
// 不引入 cJSON（避免设备端堆分配与版本差异），也不用正则。
#include "proto.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>   // std::strtol：gcc 需要显式包含，MSVC 会从 <cstring> 带进来
#include <cstring>

namespace proto {
namespace {

// ---------------------------------------------------------------- JSON 扫描
struct Cur {
    const char* s;
    size_t n;
    size_t i;
};

inline bool Ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

void SkipWs(Cur& c) {
    while (c.i < c.n && Ws(c.s[c.i])) ++c.i;
}

// 跳过（或读取）一个 JSON 字符串。进入时 c.i 指向 '"'。
// out 为 nullptr 时只跳过。
bool ScanString(Cur& c, char* out, size_t cap, size_t* written) {
    if (c.i >= c.n || c.s[c.i] != '"') return false;
    ++c.i;
    size_t w = 0;
    while (c.i < c.n) {
        const unsigned char ch = static_cast<unsigned char>(c.s[c.i]);
        if (ch == '"') {
            ++c.i;
            if (out && cap) out[w < cap ? w : cap - 1] = '\0';
            if (written) *written = w;
            return true;
        }
        if (ch == '\\') {
            ++c.i;
            if (c.i >= c.n) return false;
            char e = c.s[c.i++];
            char lit = 0;
            switch (e) {
                case '"': lit = '"'; break;
                case '\\': lit = '\\'; break;
                case '/': lit = '/'; break;
                case 'b': lit = '\b'; break;
                case 'f': lit = '\f'; break;
                case 'n': lit = '\n'; break;
                case 'r': lit = '\r'; break;
                case 't': lit = '\t'; break;
                case 'u': {
                    // \uXXXX → UTF-8（只处理 BMP，设备端够用）
                    if (c.i + 4 > c.n) return false;
                    unsigned cp = 0;
                    for (int k = 0; k < 4; ++k) {
                        const char h = c.s[c.i++];
                        cp <<= 4;
                        if (h >= '0' && h <= '9') cp |= unsigned(h - '0');
                        else if (h >= 'a' && h <= 'f') cp |= unsigned(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') cp |= unsigned(h - 'A' + 10);
                        else return false;
                    }
                    unsigned char buf[4];
                    size_t bl = 0;
                    if (cp < 0x80) { buf[bl++] = (unsigned char)cp; }
                    else if (cp < 0x800) {
                        buf[bl++] = (unsigned char)(0xC0 | (cp >> 6));
                        buf[bl++] = (unsigned char)(0x80 | (cp & 0x3F));
                    } else {
                        buf[bl++] = (unsigned char)(0xE0 | (cp >> 12));
                        buf[bl++] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
                        buf[bl++] = (unsigned char)(0x80 | (cp & 0x3F));
                    }
                    if (out) for (size_t k = 0; k < bl; ++k) { if (w + 1 < cap) out[w] = (char)buf[k]; ++w; }
                    else w += bl;
                    continue;
                }
                default: return false;
            }
            if (out) { if (w + 1 < cap) out[w] = lit; }
            ++w;
            continue;
        }
        if (out) { if (w + 1 < cap) out[w] = (char)ch; }
        ++w;
        ++c.i;
    }
    return false;   // 没等到闭合引号
}

bool SkipNumber(Cur& c) {
    const size_t start = c.i;
    while (c.i < c.n) {
        const char ch = c.s[c.i];
        if ((ch >= '0' && ch <= '9') || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E') ++c.i;
        else break;
    }
    return c.i > start;
}

bool SkipValue(Cur& c, int depth = 0) {
    if (depth > 8) return false;
    SkipWs(c);
    if (c.i >= c.n) return false;
    const char ch = c.s[c.i];
    if (ch == '"') return ScanString(c, nullptr, 0, nullptr);
    if (ch == '{' || ch == '[') {
        const char close = (ch == '{') ? '}' : ']';
        ++c.i;
        for (;;) {
            SkipWs(c);
            if (c.i >= c.n) return false;
            if (c.s[c.i] == close) { ++c.i; return true; }
            if (c.s[c.i] == ',') { ++c.i; continue; }
            if (ch == '{') {
                if (!ScanString(c, nullptr, 0, nullptr)) return false;
                SkipWs(c);
                if (c.i >= c.n || c.s[c.i] != ':') return false;
                ++c.i;
            }
            if (!SkipValue(c, depth + 1)) return false;
        }
    }
    if (ch == 't' && c.i + 4 <= c.n && std::memcmp(c.s + c.i, "true", 4) == 0) { c.i += 4; return true; }
    if (ch == 'f' && c.i + 5 <= c.n && std::memcmp(c.s + c.i, "false", 5) == 0) { c.i += 5; return true; }
    if (ch == 'n' && c.i + 4 <= c.n && std::memcmp(c.s + c.i, "null", 4) == 0) { c.i += 4; return true; }
    return SkipNumber(c);
}

// 在顶层对象里找 key。命中返回 true，pos/len 是**值**的字节范围。
bool FindField(const char* s, size_t n, const char* key, size_t* pos, size_t* len) {
    Cur c{s, n, 0};
    SkipWs(c);
    if (c.i >= c.n || c.s[c.i] != '{') return false;
    ++c.i;
    const size_t klen = std::strlen(key);
    for (;;) {
        SkipWs(c);
        if (c.i >= c.n) return false;
        if (c.s[c.i] == '}') return false;
        if (c.s[c.i] == ',') { ++c.i; continue; }

        char kbuf[32];
        size_t kw = 0;
        if (!ScanString(c, kbuf, sizeof(kbuf), &kw)) return false;
        SkipWs(c);
        if (c.i >= c.n || c.s[c.i] != ':') return false;
        ++c.i;
        SkipWs(c);
        const size_t vstart = c.i;
        if (!SkipValue(c)) return false;
        const size_t vend = c.i;
        if (kw == klen && std::memcmp(kbuf, key, klen) == 0) {
            if (pos) *pos = vstart;
            if (len) *len = vend - vstart;
            return true;
        }
    }
}

// 取某个键的**原始** JSON 值文本（数组/对象用；字符串会被连引号一起拷出来）
bool FieldRaw(const char* s, size_t n, const char* key, char* out, size_t cap) {
    size_t pos = 0, len = 0;
    if (!FindField(s, n, key, &pos, &len) || cap == 0) return false;
    const size_t use = len < cap ? len : cap - 1;
    std::memcpy(out, s + pos, use);
    out[use] = '\0';
    return true;
}

// 值 → 字符串（自动解码转义）
bool FieldStr(const char* s, size_t n, const char* key, char* out, size_t cap, bool* truncated = nullptr) {
    size_t pos = 0, len = 0;
    if (!FindField(s, n, key, &pos, &len)) return false;
    // 必须是字符串
    Cur c{s + pos, len, 0};
    size_t written = 0;
    if (!ScanString(c, out, cap, &written)) return false;
    if (truncated) *truncated = written >= cap;
    return true;
}

bool FieldBool(const char* s, size_t n, const char* key, bool* out) {
    size_t pos = 0, len = 0;
    if (!FindField(s, n, key, &pos, &len)) return false;
    if (len == 4 && std::memcmp(s + pos, "true", 4) == 0) { *out = true; return true; }
    if (len == 5 && std::memcmp(s + pos, "false", 5) == 0) { *out = false; return true; }
    return false;
}

bool FieldInt(const char* s, size_t n, const char* key, int* out) {
    size_t pos = 0, len = 0;
    if (!FindField(s, n, key, &pos, &len) || len == 0 || len > 16) return false;
    char buf[17];
    std::memcpy(buf, s + pos, len);
    buf[len] = '\0';
    char* end = nullptr;
    const long v = std::strtol(buf, &end, 10);
    if (end == buf) return false;
    *out = int(v);
    return true;
}

// 截断到 UTF-8 边界：不要把最后一个汉字切成半个。
// 走一遍序列验证，遇到"该字符还没拷全"就截在那里。
void TrimUtf8(char* s, size_t cap, bool* truncated) {
    if (!s || cap == 0 || !truncated || !*truncated) return;
    const size_t len = std::strlen(s);
    size_t i = 0;
    while (i < len) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        size_t need = 1;
        if (c < 0x80) need = 1;
        else if ((c & 0xE0) == 0xC0) need = 2;
        else if ((c & 0xF0) == 0xE0) need = 3;
        else if ((c & 0xF8) == 0xF0) need = 4;
        else { s[i] = '\0'; return; }        // 非法起始字节，直接截
        if (i + need > len) { s[i] = '\0'; return; }
        i += need;
    }
}

// ---------------------------------------------------------------- 转义输出
struct Out {
    char* p;
    size_t cap;
    size_t n = 0;
    bool ok = true;

    void raw(const char* s, size_t len) {
        if (!ok) return;
        if (n + len + 1 > cap) { ok = false; return; }
        std::memcpy(p + n, s, len);
        n += len;
    }
    void raw(const char* s) { raw(s, std::strlen(s)); }
    void ch(char c) { raw(&c, 1); }
    // JSON 字符串内容转义；UTF-8 原样保留（JSON 允许）
    void quoted(const char* s, size_t len) {
        ch('"');
        for (size_t i = 0; i < len && ok; ++i) {
            const unsigned char c = static_cast<unsigned char>(s[i]);
            switch (c) {
                case '"': raw("\\\"", 2); break;
                case '\\': raw("\\\\", 2); break;
                case '\n': raw("\\n", 2); break;
                case '\r': raw("\\r", 2); break;
                case '\t': raw("\\t", 2); break;
                default:
                    if (c < 0x20) {
                        char esc[7];
                        std::snprintf(esc, sizeof(esc), "\\u%04x", c);
                        raw(esc, 6);
                    } else {
                        ch(static_cast<char>(c));
                    }
            }
        }
        ch('"');
    }
    size_t finish() {
        if (!ok) return 0;
        p[n] = '\0';
        return n;
    }
};

}  // namespace

// ============================ 表情 ============================
const char* MoodName(Mood m) {
    switch (m) {
        case Mood::Idle: return "idle";
        case Mood::Blink: return "blink";
        case Mood::Listen: return "listen";
        case Mood::Think: return "think";
        case Mood::Speak: return "speak";
        case Mood::Happy: return "happy";
        case Mood::Sad: return "sad";
        case Mood::Error: return "error";
    }
    return "idle";
}

bool MoodFromName(const char* s, size_t n, Mood* out) {
    if (!s || !out) return false;
    struct P { const char* name; Mood m; };
    static const P kTable[] = {
        {"idle", Mood::Idle},   {"blink", Mood::Blink}, {"listen", Mood::Listen},
        {"think", Mood::Think}, {"speak", Mood::Speak}, {"happy", Mood::Happy},
        {"sad", Mood::Sad},     {"error", Mood::Error},
    };
    for (const auto& p : kTable) {
        const size_t l = std::strlen(p.name);
        if (l == n && std::memcmp(p.name, s, l) == 0) { *out = p.m; return true; }
    }
    return false;
}

const char* CodecName(Codec c) {
    // 线上唯一来源：hello.codecs / audio.codec / pong.codec / voice.codec 都从这里取字符串。
    switch (c) {
        case Codec::Opus: return "opus";
        case Codec::Adpcm: return "adpcm";
        case Codec::Pcm: break;
    }
    return "pcm";
}

const char* TransportName(Transport t) {
    switch (t) {
        case Transport::Ble: return "ble";
        case Transport::Wifi: return "wifi";
        case Transport::None: break;
    }
    return "none";
}

const char* KindName(Downlink::Kind k) {
    switch (k) {
        case Downlink::None: return "none";
        case Downlink::Welcome: return "welcome";
        case Downlink::Say: return "say";
        case Downlink::Face: return "face";
        case Downlink::Result: return "result";
        case Downlink::Ping: return "ping";
        case Downlink::Audio: return "audio";
        case Downlink::AudioEnd: return "audio_end";
        case Downlink::Shot: return "shot";
        case Downlink::Record: return "record";
        case Downlink::Mic: return "mic";
        case Downlink::Play: return "play";
        case Downlink::Stop: return "stop";
    }
    return "?";
}

// ============================ 编码 ============================
size_t BuildHello(char* out, size_t cap, const HelloInfo& info) {
    Out o{out, cap};
    o.raw("{\"t\":\"hello\",\"fw\":");
    o.quoted(kFwVersion, std::strlen(kFwVersion));
    o.raw(",\"board\":");
    o.quoted(kBoard, std::strlen(kBoard));
    o.raw(",\"ver\":");
    o.quoted(kFwVerString, std::strlen(kFwVerString));
    // cam/w/h：桥构图提示用（v2 摄像头固定 240×240，photo 走后台上行）
    o.raw(",\"cam\":1,\"w\":240,\"h\":240");
    // 能力协商：解码器不可用（PSRAM/创建失败）时只报 PCM/ADPCM —— 桥不会下发 opus。
    // BLE 链路固件总是带 adpcm（§6/§7：BLE 固件报 ["pcm","opus","adpcm"]）。
    o.raw(",\"codecs\":[\"pcm\",\"adpcm\"");
    if (info.opus_available) o.raw(",\"opus\"");
    o.ch(']');
    if (info.opus_available) o.raw(",\"opusRate\":16000");   // 与 audio_dec::kEncRate 一致
    // 链路字段（§7，全部可选；WiFi 老桥忽略未知字段）
    o.raw(",\"transport\":");
    o.quoted(TransportName(info.transport), std::strlen(TransportName(info.transport)));
    const char* uplink = (info.uplink && info.uplink[0]) ? info.uplink : "pcm";
    o.raw(",\"uplink\":");
    o.quoted(uplink, std::strlen(uplink));
    if (info.mtu > 0) {
        char num[24];
        std::snprintf(num, sizeof(num), ",\"mtu\":%d", info.mtu);
        o.raw(num);
    }
    if (info.name && info.name[0]) {
        o.raw(",\"name\":");
        o.quoted(info.name, std::strlen(info.name));
    }
    o.ch('}');
    return o.finish();
}

size_t BuildPress(char* out, size_t cap, bool down) {
    Out o{out, cap};
    o.raw(down ? "{\"t\":\"press\",\"edge\":\"down\"}" : "{\"t\":\"press\",\"edge\":\"up\"}");
    return o.finish();
}

size_t BuildLevel(char* out, size_t cap, float v) {
    if (!(v >= 0.0f)) v = 0.0f;         // 同时吃掉 NaN
    if (v > 1.0f) v = 1.0f;
    char num[12];
    std::snprintf(num, sizeof(num), "%.3f", v);
    Out o{out, cap};
    o.raw("{\"t\":\"level\",\"v\":");
    o.raw(num);
    o.ch('}');
    return o.finish();
}

size_t BuildText(char* out, size_t cap, const char* utf8) {
    if (!utf8 || !*utf8) return 0;
    Out o{out, cap};
    o.raw("{\"t\":\"text\",\"text\":");
    o.quoted(utf8, std::strlen(utf8));
    o.ch('}');
    return o.finish();
}

size_t BuildState(char* out, size_t cap, Mood m, int battery) {
    Out o{out, cap};
    o.raw("{\"t\":\"state\",\"mood\":\"");
    o.raw(MoodName(m));
    o.ch('"');
    if (battery >= 0 && battery <= 100) {
        char num[16];
        std::snprintf(num, sizeof(num), ",\"battery\":%d", battery);
        o.raw(num);
    }
    o.ch('}');
    return o.finish();
}

size_t BuildPong(char* out, size_t cap, const PongInfo& info) {
    // 诊断字段全部来自设备实时状态；数值夹到非负（rssi 允许负 = 正常 dBm）。
    const int buf_ms = info.buf_ms < 0 ? 0 : info.buf_ms;
    const int underruns = info.underruns < 0 ? 0 : info.underruns;
    const int reconnects = info.reconnects < 0 ? 0 : info.reconnects;
    const int mtu = info.mtu < 0 ? 0 : info.mtu;
    const int tx_drop = info.tx_drop < 0 ? 0 : info.tx_drop;
    const int rx_drop = info.rx_drop < 0 ? 0 : info.rx_drop;
    const char* codec = (info.codec && info.codec[0]) ? info.codec : "pcm";
    const char* transport = (info.transport && info.transport[0]) ? info.transport : "wifi";
    char head[220];
    std::snprintf(head, sizeof(head),
                  "{\"t\":\"pong\",\"bufMs\":%d,\"underruns\":%d,\"reconnects\":%d,\"rssi\":%d,"
                  "\"mtu\":%d,\"txDrop\":%d,\"rxDrop\":%d,\"codec\":",
                  buf_ms, underruns, reconnects, info.rssi, mtu, tx_drop, rx_drop);
    Out o{out, cap};
    o.raw(head);
    o.quoted(codec, std::strlen(codec));
    o.raw(",\"transport\":");
    o.quoted(transport, std::strlen(transport));
    o.ch('}');
    return o.finish();
}

size_t BuildSound(char* out, size_t cap, const char* kind, float level, int ms) {
    if (!kind || !*kind) return 0;
    // level 夹到 0..1，保留三位小数；NaN 归 0（实测过 NaN 会写出 "nan" 让 JSON 非法）
    if (!(level > 0.0f)) level = 0.0f;
    if (level > 1.0f) level = 1.0f;
    if (ms < 0) ms = 0;
    char num[24];
    std::snprintf(num, sizeof(num), "%.3f", double(level));
    Out o{out, cap};
    o.raw("{\"t\":\"sound\",\"kind\":\"");
    o.raw(kind);
    o.raw("\",\"level\":");
    o.raw(num);
    o.raw(",\"ms\":");
    std::snprintf(num, sizeof(num), "%d", ms);
    o.raw(num);
    o.ch('}');
    return o.finish();
}

size_t BuildVoice(char* out, size_t cap, int bytes, int seq, const char* codec, int samples) {
    if (bytes <= 0) return 0;
    const char* c = (codec && codec[0]) ? codec : "pcm";
    char num[160];
    // samples：本次录音的 PCM 采样数（adpcm 解码端裁末块补齐用；pcm 可用于对账）
    if (samples > 0) {
        std::snprintf(num, sizeof(num),
                      "{\"t\":\"voice\",\"rate\":%d,\"bits\":16,\"ch\":1,\"bytes\":%d,\"seq\":%d,"
                      "\"codec\":\"%s\",\"samples\":%d}",
                      24000, bytes, seq, c, samples);
    } else {
        std::snprintf(num, sizeof(num),
                      "{\"t\":\"voice\",\"rate\":%d,\"bits\":16,\"ch\":1,\"bytes\":%d,\"seq\":%d,"
                      "\"codec\":\"%s\"}",
                      24000, bytes, seq, c);
    }
    Out o{out, cap};
    o.raw(num);
    return o.finish();
}

size_t BuildDiag(char* out, size_t cap, int p0, int p1, int knob, int key, int capturing,
                         int samples) {
    char num[160];
    std::snprintf(num, sizeof(num),
                  "{\"t\":\"diag\",\"p0\":%d,\"p1\":%d,\"knob\":%d,\"key\":%d,\"cap\":%d,\"len\":%d}", p0,
                  p1, knob, key, capturing, samples);
    Out o{out, cap};
    o.raw(num);
    return o.finish();
}

// ============================ 解析 ============================
bool Parse(const char* json, size_t len, Downlink* out) {    if (!json || !out || len < 4 || len > 8192) return false;
    *out = Downlink{};

    char t[16];
    if (!FieldStr(json, len, "t", t, sizeof(t))) return false;

    // ---- 音频（TTS）：头 + 二进制帧 + 尾
    if (std::strcmp(t, "audio") == 0) {
        out->kind = Downlink::Audio;
        // codec 缺省 = pcm：老桥/老设备不带这个字段，二进制帧就是裸 PCM（向后兼容）。
        char cbuf[8];
        if (FieldStr(json, len, "codec", cbuf, sizeof(cbuf))) {
            if (std::strcmp(cbuf, "opus") == 0) out->codec = Codec::Opus;
            else if (std::strcmp(cbuf, "adpcm") == 0) out->codec = Codec::Adpcm;
            else if (std::strcmp(cbuf, "pcm") == 0) out->codec = Codec::Pcm;
            else return false;   // 未知编码：整条拒掉（按 pcm 播 opus/adpcm 字节只会是噪音）
        }
        FieldInt(json, len, "rate", &out->rate);
        FieldInt(json, len, "bits", &out->bits);
        FieldInt(json, len, "ch", &out->channels);
        FieldInt(json, len, "bytes", &out->audio_bytes);
        FieldInt(json, len, "seq", &out->audio_seq);
        FieldInt(json, len, "samples", &out->sample_count);
        if (out->sample_count < 0) out->sample_count = 0;
        // 合理性兜底：设备端不做重采样，格式不对就拒掉，别放噪音。
        //   opus ：rate 是解码器输出率（契约 24000），也容忍桥直接报编码率 16000；
        //   adpcm：块流按 24 kHz 编码，设备直接 24k 播放（不做重采样）→ 只收 24000；
        //   pcm  ：保持原来的宽范围（设备按 24k 播，桥侧历史上允许浮点写法）。
        if (out->codec == Codec::Opus) {
            if (out->rate != 24000 && out->rate != 16000) return false;
        } else if (out->codec == Codec::Adpcm) {
            if (out->rate != 24000) return false;
        } else {
            if (out->rate <= 0 || out->rate > 48000) return false;
        }
        if (out->bits != 16 || out->channels != 1) {
            return false;
        }
        if (out->audio_bytes < 0) out->audio_bytes = 0;
        return true;
    }
    if (std::strcmp(t, "mic") == 0) {
        out->kind = Downlink::Mic;
        int v = 0;
        FieldInt(json, len, "auto", &v);
        out->mic_auto = (v != 0);
        return true;
    }
    if (std::strcmp(t, "record") == 0) {
        out->kind = Downlink::Record;
        FieldInt(json, len, "seconds", &out->seconds);
        if (out->seconds < 0) out->seconds = 0;
        if (out->seconds > 10) out->seconds = 10;
        return true;
    }
    if (std::strcmp(t, "audio_end") == 0) {
        out->kind = Downlink::AudioEnd;
        FieldInt(json, len, "seq", &out->audio_seq);
        return true;
    }
    if (std::strcmp(t, "play") == 0) {
        out->kind = Downlink::Play;
        if (!FieldStr(json, len, "file", out->file, sizeof(out->file))) return false;
        int lp = 0;
        FieldInt(json, len, "loop", &lp);
        out->loop = (lp != 0);
        return out->file[0] != '\0';
    }
    if (std::strcmp(t, "stop") == 0) {
        out->kind = Downlink::Stop;
        return true;
    }

    if (std::strcmp(t, "shot") == 0) {
        // 2026-11-02：原来靠 app_ui 里裸 strstr(buf, "\"shot\"") 判断，say 正文里带
        // 这个词会误触发拍照（FW-16）。收编成正式 kind 后由 Parse 精确匹配。
        out->kind = Downlink::Shot;
        return true;
    }
    if (std::strcmp(t, "welcome") == 0) {
        out->kind = Downlink::Welcome;
        FieldInt(json, len, "ver", &out->ver);
        // moods 是数组（["idle",...]），原样保留一段供日志用
        FieldRaw(json, len, "moods", out->moods, sizeof(out->moods));
        return true;
    }
    if (std::strcmp(t, "say") == 0) {
        out->kind = Downlink::Say;
        bool trunc = false;
        if (!FieldStr(json, len, "text", out->text, sizeof(out->text), &trunc)) return false;
        TrimUtf8(out->text, sizeof(out->text), &trunc);
        out->text_truncated = trunc;
        char m[16];
        if (FieldStr(json, len, "mood", m, sizeof(m))) MoodFromName(m, std::strlen(m), &out->mood);
        else out->mood = Mood::Speak;
        return true;
    }
    if (std::strcmp(t, "face") == 0) {
        out->kind = Downlink::Face;
        char m[16];
        if (!FieldStr(json, len, "mood", m, sizeof(m))) return false;
        if (!MoodFromName(m, std::strlen(m), &out->mood)) out->mood = Mood::Idle;
        return true;
    }
    if (std::strcmp(t, "result") == 0) {
        out->kind = Downlink::Result;
        FieldBool(json, len, "ok", &out->ok);
        // error 是嵌套对象：先取它的字节范围，再在这个范围里找 code/message
        size_t epos = 0, elen = 0;
        if (FindField(json, len, "error", &epos, &elen)) {
            char buf[256];
            const size_t use = elen < sizeof(buf) ? elen : sizeof(buf) - 1;
            std::memcpy(buf, json + epos, use);
            buf[use] = '\0';
            FieldStr(buf, use, "code", out->code, sizeof(out->code));
            FieldStr(buf, use, "message", out->message, sizeof(out->message));
        }
        return true;
    }
    if (std::strcmp(t, "ping") == 0) {
        out->kind = Downlink::Ping;
        FieldInt(json, len, "ver", &out->ver);
        return true;
    }
    return false;
}

}  // namespace proto
