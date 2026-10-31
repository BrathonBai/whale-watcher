// ws_client.h —— 极简 WebSocket 客户端（ws:// 明文，LAN 用）。
//
// 只做这座桥需要的事：连上、发文本、收文本、回 ping/pong、断了自动重连。
// 帧编解码在 ws_frame.{h,cc}（可主机单测），这里只管 socket 与握手。
#pragma once

#include <cstddef>
#include <cstdint>

namespace ws {

struct Stats {
    int connects = 0;
    int disconnects = 0;
    int tx_frames = 0;
    int rx_frames = 0;
    int reconnects = 0;
    int64_t connected_ms = 0;   // 最近一次连上的时刻（xTaskGetTickCount 换算）
    char last_error[72] = {0};
    char host[48] = {0};
    int port = 0;
};

// 文本帧到达回调（在 ws 任务上下文执行，保持短小）
using OnText = void (*)(const char* data, size_t len);
// 二进制帧回调：TTS 的 PCM 就走这里（同样在 ws 任务上下文，只做入队）
using OnBinary = void (*)(const uint8_t* data, size_t len);

void SetTextHandler(OnText cb);
void SetBinaryHandler(OnBinary cb);

// 起任务并连接。url 形如 ws://192.168.0.17:7788/device
void Start(const char* url);

bool Connected();
Stats Get();

// 发一条文本帧；返回 false 表示当前没连上（调用方自己决定丢弃还是排队）
bool SendText(const char* data, size_t len);
// 二进制上行（语音片段 PCM）；客户端帧要掩码，内部已处理
bool SendBinary(const uint8_t* data, size_t len);

}  // namespace ws
