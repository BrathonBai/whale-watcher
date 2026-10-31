// ws_frame.h —— RFC 6455 帧编解码（纯函数，无 socket、无 esp_*，可主机单测）。
//
// 为什么自己写：ESP-IDF 5.5 不再内置 esp_websocket_client（改成组件市场下载），
// 而这个固件的价值是"离线可重现构建"。我们只需要 RFC 6455 的一个子集：
//   - 客户端→服务端：文本帧、ping、pong、close（必须带 mask）
//   - 服务端→客户端：文本帧、ping、pong、close（不带 mask）
// 不支持扩展（permessage-deflate）、不支持二进制业务负载。
#pragma once

#include <cstddef>
#include <cstdint>

namespace ws_frame {

enum Opcode : uint8_t {
    kCont = 0x0,
    kText = 0x1,
    kBinary = 0x2,
    kClose = 0x8,
    kPing = 0x9,
    kPong = 0xA,
};

// 客户端侧：把 payload 打包成一帧（自动加 mask）。返回写入的字节数，0 = 缓冲区不够。
size_t Build(uint8_t* out, size_t cap, uint8_t opcode, const void* payload, size_t len, uint32_t mask_key);

struct Frame {
    uint8_t opcode = 0;
    bool fin = true;
    const uint8_t* payload = nullptr;
    size_t len = 0;
    size_t consumed = 0;   // 这一帧在输入缓冲里占了多少字节
};

enum class ParseStatus : uint8_t {
    NeedMore,   // 数据不够，再 recv
    Ok,         // 拿到一帧
    Error,      // 协议错（超长、非法 opcode、服务端发了带 mask 的帧但我们是客户端…）
};

// 解析缓冲里的第一帧。payload 指向 buf 内部（mask 已就地解掉）。
ParseStatus Parse(uint8_t* buf, size_t have, size_t max_payload, Frame* out);

// 生成 Sec-WebSocket-Key 需要的一个 16 字节随机数的 base64 形式（24 字符 + NUL）。
// 用外部传入的随机源，避免这个文件依赖 esp_random。
void MakeAcceptKeyInput(const uint8_t rnd[16], char out[25]);

}  // namespace ws_frame
