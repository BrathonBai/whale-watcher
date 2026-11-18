// proto.h —— 设备 ⇄ DSH 桥 的线协议编解码。
//
// 契约来源：bridge/lib/protocol.js（服务端那一半，已跑通 live.mjs 冒烟）。
// 这里只做设备侧的一半，**不依赖任何 esp_* 头文件**，所以能在 Windows 主机上
// 用 cl.exe 单测（firmware/host/test_proto.cc）——协议错了不该等到刷机才发现。
//
// 形状（一条消息一个 JSON 对象，t 字段判别）：
//
//   设备 → 大脑  hello{fw,board,ver} / press{edge} / level{v} / text{text}
//                state{mood,battery} / pong
//   大脑 → 设备  welcome{ver,moods,commands} / say{text,mood} / face{mood}
//                result{ok,payload|error{code,message}} / ping{ver}
//
// 设计取向（抄 Muse Gadgets 的 link.invoke 形状，不抄它的传输）：
//   - 上行只发"原语"，语义留在云端；
//   - 下行统一走 Downlink 结构体，UI 侧不碰 JSON；
//   - 解析器自带深度/长度上限，坏帧只丢一条，不拖垮连接。
#pragma once

#include <cstddef>
#include <cstdint>

namespace proto {

// hello 里的 fw 字段（固件版本）；改动时同步 docs
// v2（hub_v2）：身份常量集中在这里，hello 也由 BuildHello() 生成，
// 不再出现"proto.h 一套、app_ui.cc 硬编码另一套"的漂移（审计 FW-22）。
constexpr const char* kFwVersion = "hub_v2";     // firmware 标识
constexpr const char* kFwVerString = "0.4";      // 语义版本（线上 hello.ver 字符串；2026-11-13 v0.4 取消 WiFi，BLE-only）
constexpr const char* kBoard = "watcher";
constexpr int kProtocolVersion = 2;

// 设备支持的下行音频编码。线上字段：hello.codecs / audio.codec / pong.codec。
// 注意：它是 proto 命名空间级类型（Downlink::codec 用它），不是 Downlink 的嵌套类型。
// 2026-11-13（BLE 契约 §6）：新增 Adpcm（IMA ADPCM 块流，24 kHz 直出，无重采样）。
enum class Codec : uint8_t { Pcm = 0, Opus, Adpcm };
const char* CodecName(Codec c);   // "pcm" / "opus" / "adpcm"（线上字符串唯一来源）

// 当前生效链路（hello.transport / pong.transport，§7）。
enum class Transport : uint8_t { None = 0, Wifi, Ble };
const char* TransportName(Transport t);   // "none" / "wifi" / "ble"

// hello 里的能力字段（2026-11-03 起 / 2026-11-13 扩展）：
//   "codecs":["pcm","adpcm"]（+ "opus"，解码器不可用时不报 opus，不静默假报）
//   "transport":"ble"|"wifi"、"uplink":"adpcm"|"pcm"、"mtu":247（wifi 时 0/省略）、
//   "name":"Jingjing-XXXX"（仅 BLE）

// ============================ 表情 ============================
// 与 bridge/lib/protocol.js 的 MOODS 严格同序同名。改这里必须同时改那边。
enum class Mood : uint8_t {
    Idle = 0,
    Blink,
    Listen,
    Think,
    Speak,
    Happy,
    Sad,
    Error,
};

constexpr int kMoodCount = 8;

const char* MoodName(Mood m);
// 名字 → Mood；未知返回 false（调用方自己决定退回 idle 还是忽略）
bool MoodFromName(const char* s, size_t n, Mood* out);

// ============================ 下行 ============================
struct Downlink {
    enum Kind : uint8_t {
        None = 0,
        Welcome,
        Say,
        Face,
        Result,
        Ping,
        Audio,      // 后面紧跟 bytes 个二进制帧的 PCM
        AudioEnd,   // 一条语音播完
        Shot,       // 让设备现在拍一张，随后上行 image（2026-11-02：从裸 strstr 收编为正式 kind）
        Record,     // 让设备现在录一段（L2 按需音频）
        Mic,        // 麦克风自动模式开关（免按键对话的前提）
        Play,       // 播放 TF 卡上的音频文件（mp3，路径见 file）
        Stop,       // 停止本地播放
    } kind = None;

    Mood mood = Mood::Idle;
    bool ok = false;

    // say.text：服务器的硬上限是 2000 字符，但屏上放不下；
    // 这里截到 kTextCap-1 字节（UTF-8 边界对齐，不会切出半个汉字）。
    static constexpr size_t kTextCap = 512;
    char text[kTextCap] = {0};
    bool text_truncated = false;

    char moods[192] = {0};   // welcome.moods 原样（逗号分隔，仅用于日志）
    int ver = 0;

    char code[40] = {0};     // result.error.code
    char message[120] = {0}; // result.error.message

    // ---- 音频（TTS 播放）----
    // 下行顺序：{"t":"audio",...} → N 个二进制帧 → {"t":"audio_end"}
    // 二进制帧的含义由 codec 决定：
    //   Pcm   —— 裸 PCM（24 kHz/16 bit/mono），原有路径；
    //   Opus  —— 每帧一个裸 Opus 包（20 ms/16 kHz mono，无长度前缀），解码见 audio_dec.h；
    //   Adpcm —— IMA ADPCM 块流（1024 B 块 = 2041 采样，末块可短），解码见 audio_dec.h。
    // 无 codec 字段 = pcm（向后兼容，老桥不感知新字段）。
    Codec codec = Codec::Pcm;
    int rate = 24000;        // Hz（opus 时填解码输出率 24000；允许 16000/24000）
    int bits = 16;
    int channels = 1;
    int audio_bytes = 0;     // 本次语音总字节数（pcm/adpcm 用于对账；opus 可为 0）
    int audio_seq = 0;       // 会话序号，乱序/丢帧时能对账
    // PCM 采样数（adpcm 必需：末块补齐的 1 个采样靠它裁掉；pcm 可为 0）
    int sample_count = 0;
    int seconds = 0;         // record.seconds：要录几秒（0=设备默认）
    bool mic_auto = false;   // mic.auto：VAD 是否自动起录并上传

    // ---- 本地播放（TF 卡 mp3）----
    // {"t":"play","file":"/sdcard/mp3/BGM01.MP3","loop":1}
    static constexpr size_t kFileCap = 160;
    char file[kFileCap] = {0};
    bool loop = false;
};

// ============================ 编码 ============================
// 全部返回写入的字节数；缓冲区不够返回 0（不会写半条）。
// 输出的字符串保证是合法 JSON（引号/反斜杠/控制字符转义，UTF-8 原样保留）。

// hello：设备身份 + 能力 + 链路（§7 新增字段全部可选，WiFi 老桥忽略未知字段）。
struct HelloInfo {
    bool opus_available = false;      // 解码器可用才报 opus
    Transport transport = Transport::None;  // 当前生效链路
    const char* uplink = "pcm";       // "adpcm"（BLE）/ "pcm"（WiFi）
    int mtu = 0;                      // BLE MTU；wifi 传 0 = 省略
    const char* name = nullptr;       // 显示名（BLE: Jingjing-XXXX），nullptr/空 = 省略
};
size_t BuildHello(char* out, size_t cap, const HelloInfo& info);
size_t BuildPress(char* out, size_t cap, bool down);
size_t BuildLevel(char* out, size_t cap, float v);          // 0..1，三位小数
size_t BuildText(char* out, size_t cap, const char* utf8);  // 空串返回 0
size_t BuildState(char* out, size_t cap, Mood m, int battery);  // battery<0 表示未知

// pong 诊断字段（2026-11-03 契约；2026-11-13 §7 增加链路诊断）：桥只展示，老桥忽略未知字段。
struct PongInfo {
    int buf_ms = 0;        // 当前 PCM 环形缓冲积压毫秒数（audio::StreamBuffered 换算）
    int underruns = 0;     // 累计欠载次数（audio::StreamUnderruns）
    int reconnects = 0;    // 链路"新连接"次数（link::Stats.reconnects）
    int rssi = 0;          // BLE 时 BLE RSSI，否则 WiFi RSSI（未连上为 0）
    const char* codec = "pcm";      // 当前下行编码 "pcm"/"opus"/"adpcm"（CodecName()）
    const char* transport = "wifi"; // 当前生效链路 "ble"/"wifi"/"none"（TransportName()）
    int mtu = 0;           // BLE MTU（wifi 时 0）
    int tx_drop = 0;       // 发送侧丢弃计数（BLE 为字节数）
    int rx_drop = 0;       // 接收侧丢弃计数（BLE 为消息数）
};
size_t BuildPong(char* out, size_t cap, const PongInfo& info);
// 环境声音上行：kind = quiet/speech/music/tap/noise，level 0..1，ms = 已持续时长
size_t BuildSound(char* out, size_t cap, const char* kind, float level, int ms);
// 语音片段上行头：后面紧跟 bytes 字节的二进制帧（可切成 ≤16384 的任意块）。
// BLE 契约 §6.3：codec="adpcm" 时 bytes = ADPCM 字节数；samples = 本次 PCM 采样数。
size_t BuildVoice(char* out, size_t cap, int bytes, int seq, const char* codec, int samples);
// 诊断遥测：P0/P1/旋钮/按键原始状态，桥落日志永久留档
size_t BuildDiag(char* out, size_t cap, int p0, int p1, int knob, int key, int capturing, int samples);

// ============================ 解析 ============================
// 解析一条下行文本帧。true = 认识的类型（out.kind != None）。
// 不认识的 t / 坏 JSON / 缺字段 → false，调用方只记一行日志。
bool Parse(const char* json, size_t len, Downlink* out);

// 供测试与日志：把 kind 变成可读字符串
const char* KindName(Downlink::Kind k);

}  // namespace proto
