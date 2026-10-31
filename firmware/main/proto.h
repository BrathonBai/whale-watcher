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
// 0.7 = 桌宠 idle clip；0.8 = 五个动作 + 字幕气泡
constexpr const char* kFwVersion = "0.8";
constexpr const char* kBoard = "watcher";
constexpr int kProtocolVersion = 1;

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
        Record,     // 让设备现在录一段（L2 按需音频）
        Mic,        // 麦克风自动模式开关（免按键对话的前提）
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
    // 下行顺序：{"t":"audio",...} → N 个二进制帧（每帧 ≤4KB）→ {"t":"audio_end"}
    int rate = 24000;        // Hz
    int bits = 16;
    int channels = 1;
    int audio_bytes = 0;     // 本次语音总字节数（用于进度/超时）
    int audio_seq = 0;       // 会话序号，乱序/丢帧时能对账
    int seconds = 0;         // record.seconds：要录几秒（0=设备默认）
    bool mic_auto = false;   // mic.auto：VAD 是否自动起录并上传
};

// ============================ 编码 ============================
// 全部返回写入的字节数；缓冲区不够返回 0（不会写半条）。
// 输出的字符串保证是合法 JSON（引号/反斜杠/控制字符转义，UTF-8 原样保留）。
size_t BuildHello(char* out, size_t cap, const char* fw = kFwVersion,
                  const char* board = kBoard, int ver = kProtocolVersion);
size_t BuildPress(char* out, size_t cap, bool down);
size_t BuildLevel(char* out, size_t cap, float v);          // 0..1，三位小数
size_t BuildText(char* out, size_t cap, const char* utf8);  // 空串返回 0
size_t BuildState(char* out, size_t cap, Mood m, int battery);  // battery<0 表示未知
size_t BuildPong(char* out, size_t cap);
// 环境声音上行：kind = quiet/speech/music/tap/noise，level 0..1，ms = 已持续时长
size_t BuildSound(char* out, size_t cap, const char* kind, float level, int ms);
// 语音片段上行头：后面紧跟 bytes/4096 个二进制帧
size_t BuildVoice(char* out, size_t cap, int bytes, int seq);
// 诊断遥测：P0/P1/旋钮/按键原始状态，桥落日志永久留档
size_t BuildDiag(char* out, size_t cap, int p0, int p1, int knob, int key, int capturing, int samples);

// ============================ 解析 ============================
// 解析一条下行文本帧。true = 认识的类型（out.kind != None）。
// 不认识的 t / 坏 JSON / 缺字段 → false，调用方只记一行日志。
bool Parse(const char* json, size_t len, Downlink* out);

// 供测试与日志：把 kind 变成可读字符串
const char* KindName(Downlink::Kind k);

}  // namespace proto
