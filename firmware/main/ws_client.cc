// ws_client.cc —— 见 ws_client.h。
//
// 分层：本文件 = socket + HTTP Upgrade 握手 + 收帧循环 + 心跳 + 重连。
// 帧的字节级逻辑全在 ws_frame.cc（那边有主机单测）。
#include "ws_client.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>   // ::atoi
#include <cstring>
#include <strings.h>

#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "bridge_find.h"
#include "net_wifi.h"
#include "ws_frame.h"

namespace ws {
namespace {

constexpr const char* TAG = "ws";
// 读缓冲/单帧上限：必须**大于**"一帧最大负载 + 帧头"。
// 踩过的坑：桥按 4096 字节切 PCM，而这里 kReadBuf 也是 4096，
// 一帧 4096+8 字节永远塞不满解析条件 → NeedMore 死循环 → 缓冲写满 → rx overflow → 断线。
// 16KB 给足余量（音频流是连续大帧，留给突发）。
constexpr size_t kReadBuf = 32768;  // 桥会一次性灌入几十个 4 KB 帧，缓冲太小会误判溢出
constexpr size_t kMaxPayload = 16384;
constexpr int kPingEveryMs = 15000;
constexpr int kIdleTimeoutMs = 60000;

struct Target {
    char host[48] = {0};
    int port = 80;
    char path[64] = "/";
};

Target s_target;
Stats s_stats;
OnText s_on_text = nullptr;
OnBinary s_on_binary = nullptr;
SemaphoreHandle_t s_tx_mutex = nullptr;
volatile bool s_connected = false;
int s_sock = -1;   // 当前会话的 fd（单连接模型）

// 显式截断拷贝：不用 snprintf("%s")，免得 -Werror=format-truncation 在 xtensa 上直接报错
void CopyStr(char* dst, size_t cap, const char* src) {
    if (!dst || cap == 0) return;
    size_t i = 0;
    if (src) {
        for (; i + 1 < cap && src[i]; ++i) dst[i] = src[i];
    }
    dst[i] = '\0';
}

bool ParseUrl(const char* url, Target* out) {
    if (!url) return false;
    const char* p = url;
    if (::strncasecmp(p, "ws://", 5) == 0) p += 5;
    else return false;   // wss 需要 TLS 层，暂不支持（写清边界而不是假装支持）

    const char* slash = ::strchr(p, '/');
    const size_t hostlen_raw = slash ? size_t(slash - p) : ::strlen(p);
    char hostport[80];
    if (hostlen_raw >= sizeof(hostport)) return false;
    ::memcpy(hostport, p, hostlen_raw);
    hostport[hostlen_raw] = '\0';

    char* colon = ::strrchr(hostport, ':');
    if (colon) {
        *colon = '\0';
        out->port = ::atoi(colon + 1);
    } else {
        out->port = 80;
    }
    CopyStr(out->host, sizeof(out->host), hostport);
    CopyStr(out->path, sizeof(out->path), slash ? slash : "/");
    return out->host[0] != '\0' && out->port > 0;
}

void SetError(const char* what) {
    CopyStr(s_stats.last_error, sizeof(s_stats.last_error), what ? what : "?");
}

bool SendAll(int sock, const uint8_t* buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        const int64_t t0 = esp_timer_get_time();
        const int n = ::send(sock, buf + sent, len - sent, 0);
        const int64_t dt_ms = (esp_timer_get_time() - t0) / 1000;
        // 阻塞超过 100ms 就记一笔：这一笔就是"上行慢"的现场
        if (dt_ms >= 100) {
            ESP_LOGW(TAG, "send 阻塞 %lldms（本次收 %d B / 待发 %u B）",
                     (long long)dt_ms, n, (unsigned)(len - sent));
        }
        if (n <= 0) {
            ESP_LOGW(TAG, "send 失败 len=%u 已发=%u errno=%d(%s)", (unsigned)len, (unsigned)sent, errno,
                     strerror(errno));
            return false;
        }
        sent += size_t(n);
    }
    return true;
}

// 握手：发 GET + 读响应头，认证 101
bool Handshake(int sock, const Target& t) {
    uint8_t rnd[16];
    esp_fill_random(rnd, sizeof(rnd));
    char key[25];
    ws_frame::MakeAcceptKeyInput(rnd, key);

    char req[320];
    const int n = ::snprintf(req, sizeof(req),
                             "GET %s HTTP/1.1\r\n"
                             "Host: %s:%d\r\n"
                             "Upgrade: websocket\r\n"
                             "Connection: Upgrade\r\n"
                             "Sec-WebSocket-Key: %s\r\n"
                             "Sec-WebSocket-Version: 13\r\n"
                             "\r\n",
                             t.path, t.host, t.port, key);
    if (n <= 0 || !SendAll(sock, reinterpret_cast<const uint8_t*>(req), size_t(n))) {
        SetError("handshake send failed");
        return false;
    }

    char resp[512];
    size_t got = 0;
    // 握手要有**总时限**，而不是"一次 recv 超时就失败"。
    // 实测：DSH 那个 Electron 主进程偶尔忙几秒（流式输出/UI 渲染），101 会晚到；
    // 原来 5s 单次超时就把这次握手判死，于是出现"重连 645 次、连上 2 次"的抖动。
    const int64_t deadline = int64_t(xTaskGetTickCount()) * portTICK_PERIOD_MS + 20000;
    while (got < sizeof(resp) - 1) {
        const int r = ::recv(sock, resp + got, sizeof(resp) - 1 - got, 0);
        if (r <= 0) {
            const bool timeout = (r < 0) && (errno == EAGAIN || errno == EWOULDBLOCK);
            if (timeout && int64_t(xTaskGetTickCount()) * portTICK_PERIOD_MS < deadline) {
                continue;   // 还没到总时限，继续等 101
            }
            SetError(timeout ? "handshake timeout" : "handshake recv failed");
            return false;
        }
        got += size_t(r);
        resp[got] = '\0';
        if (::strstr(resp, "\r\n\r\n")) break;
    }
    if (!::strstr(resp, " 101 ") && ::strncasecmp(resp, "HTTP/1.1 101", 12) != 0) {
        // 只取状态行做日志
        char line[64] = {0};
        for (size_t i = 0; i < got && i < sizeof(line) - 1 && resp[i] != '\r'; ++i) line[i] = resp[i];
        SetError(line[0] ? line : "no 101");
        return false;
    }
    return true;
}

int Dial(const Target& t) {
    struct addrinfo hints;
    ::memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    char portstr[8];
    ::snprintf(portstr, sizeof(portstr), "%d", t.port);
    struct addrinfo* res = nullptr;
    if (::getaddrinfo(t.host, portstr, &hints, &res) != 0 || !res) {
        SetError("dns failed");
        return -1;
    }

    const int sock = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock < 0) {
        ::freeaddrinfo(res);
        SetError("socket failed");
        return -1;
    }
    struct timeval tv{5, 0};
    ::setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    int one = 1;
    ::setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    const int rc = ::connect(sock, res->ai_addr, res->ai_addrlen);
    ::freeaddrinfo(res);
    if (rc != 0) {
        ::close(sock);
        SetError("connect failed");
        return -1;
    }
    return sock;
}

void OnFrameText(const uint8_t* data, size_t len) {
    ++s_stats.rx_frames;
    // 超长文本帧直接丢：桥的 welcome 有 1520 字节，下游缓冲撑不住（实测 Cache error 重启）
    if (len > 512) {
        ESP_LOGW(TAG, "丢弃超长文本帧 %u 字节", (unsigned)len);
        return;
    }
    if (s_on_text) s_on_text(reinterpret_cast<const char*>(data), len);
}

// 一次连接的生命周期：跑完就返回，外层负责重连
void SessionOnce(int sock) {
    s_connected = true;
    ++s_stats.connects;
    s_stats.connected_ms = int64_t(xTaskGetTickCount()) * portTICK_PERIOD_MS;
    ESP_LOGI(TAG, "已连接 %s:%d%s", s_target.host, s_target.port, s_target.path);

    static uint8_t buf[kReadBuf];
    size_t have = 0;
    int64_t last_rx = int64_t(xTaskGetTickCount()) * portTICK_PERIOD_MS;
    int64_t last_ping = last_rx;

    for (;;) {
        const int64_t now = int64_t(xTaskGetTickCount()) * portTICK_PERIOD_MS;

        // 心跳：WS 协议层 ping（服务端会自动回 pong，见 bridge/lib/ws.js）
        if (now - last_ping >= kPingEveryMs) {
            uint8_t frame[16];
            const size_t n = ws_frame::Build(frame, sizeof(frame), ws_frame::kPing, nullptr, 0, esp_random());
            if (n && s_tx_mutex && xSemaphoreTake(s_tx_mutex, pdMS_TO_TICKS(500)) == pdTRUE) {
                SendAll(sock, frame, n);
                xSemaphoreGive(s_tx_mutex);
            }
            last_ping = now;
        }
        if (now - last_rx > kIdleTimeoutMs) {
            SetError("idle timeout");
            break;
        }

        // 先消化缓冲区里已经完整的帧
        bool progressed = false;
        for (;;) {
            ws_frame::Frame f;
            const ws_frame::ParseStatus st = ws_frame::Parse(buf, have, kMaxPayload, &f);
            if (st == ws_frame::ParseStatus::NeedMore) break;
            if (st == ws_frame::ParseStatus::Error) {
                SetError("frame error");
                s_connected = false;
                return;
            }
            progressed = true;
            last_rx = now;

            switch (f.opcode) {
                case ws_frame::kText:
                    OnFrameText(f.payload, f.len);
                    break;
                case ws_frame::kPing: {
                    uint8_t out[64];
                    const size_t n = ws_frame::Build(out, sizeof(out), ws_frame::kPong, f.payload,
                                                     f.len < 32 ? f.len : 32, esp_random());
                    if (n && s_tx_mutex && xSemaphoreTake(s_tx_mutex, pdMS_TO_TICKS(500)) == pdTRUE) {
                        SendAll(sock, out, n);
                        xSemaphoreGive(s_tx_mutex);
                    }
                    break;
                }
                case ws_frame::kPong:
                    break;
                case ws_frame::kClose:
                    ESP_LOGW(TAG, "服务端发来 close");
                    s_connected = false;
                    return;
                case ws_frame::kBinary:
                    // TTS 的 PCM 分片就走这里：只入队，不在 ws 任务里做重活
                    ++s_stats.rx_frames;
                    if (s_on_binary && f.len) s_on_binary(f.payload, f.len);
                    break;
                default:
                    break;
            }

            ::memmove(buf, buf + f.consumed, have - f.consumed);
            have -= f.consumed;
        }
        if (progressed && have == 0) continue;

        // 读下一段
        const int r = ::recv(sock, buf + have, kReadBuf - have, 0);
        if (r == 0) {
            SetError("peer closed");
            break;
        }
        if (r < 0) {
            // 超时（SO_RCVTIMEO）会返回 -1/EAGAIN，这是正常的轮询返回
            if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
            SetError("recv error");
            break;
        }
        have += size_t(r);
        if (have == kReadBuf) {
            // 缓冲满**不等于**溢出：里面可能装着完整的帧，先让解析器试着消费。
            ws_frame::Frame probe;
            if (ws_frame::Parse(buf, have, kMaxPayload, &probe) == ws_frame::ParseStatus::NeedMore) {
                SetError("rx overflow");
                break;
            }
        }
    }

    s_connected = false;
    ++s_stats.disconnects;
}

}  // namespace

void SetTextHandler(OnText cb) { s_on_text = cb; }
void SetBinaryHandler(OnBinary cb) { s_on_binary = cb; }
bool Connected() { return s_connected; }
Stats Get() { return s_stats; }

bool SendText(const char* data, size_t len) {
    if (!data || len == 0 || !s_connected) return false;
    if (!s_tx_mutex) return false;
    if (len > 3000) return false;   // 上行都是短原语，超了说明调用方有问题

    // 发送缓冲**必须**是静态的：这个函数会被 ui / console / 按键 等任务调用，
    // 而 4KB 的栈上缓冲会把 4KB 栈的任务（console）直接撑爆 —— v0.6 实测过一次：
    // 串口敲 >text 后设备立刻重启，就是这里。用 mutex 串行化，顺带保护 build+send。
    static uint8_t frame[4096];
    if (xSemaphoreTake(s_tx_mutex, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
    const size_t n = ws_frame::Build(frame, sizeof(frame), ws_frame::kText, data, len, esp_random());
    bool ok = false;
    if (n && s_sock >= 0) ok = SendAll(s_sock, frame, n);
    xSemaphoreGive(s_tx_mutex);
    if (ok) ++s_stats.tx_frames;
    return ok;
}

// 二进制上行：语音 PCM 分片。客户端帧必须带掩码（RFC 6455 §5.3），
// 掩码键用 esp_random()，每帧都换。
// 一帧最多 16 KB：语音上传 98 KB 从 25 次往返降到 7 次。
// 缓冲**必须放 PSRAM**：内部堆只剩 ~18 KB，静态 16 KB 的 BSS 会把别的任务挤死；
// 也不能放栈上（console 任务只有 4 KB 栈，v0.6 就被这么撑爆过）。
constexpr size_t kMaxBinaryPayload = 16384;

bool SendBinary(const uint8_t* data, size_t len) {
    if (!data || len == 0) return false;
    if (!s_connected) { ESP_LOGW(TAG, "SendBinary: 未连接"); return false; }
    if (!s_tx_mutex) return false;
    if (len > kMaxBinaryPayload) { ESP_LOGW(TAG, "SendBinary: 帧太大 %u", (unsigned)len); return false; }
    static uint8_t* s_frame = nullptr;
    if (!s_frame) {
        s_frame = static_cast<uint8_t*>(heap_caps_malloc(kMaxBinaryPayload + 16, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        if (!s_frame) { ESP_LOGW(TAG, "SendBinary: PSRAM 分配失败"); return false; }
    }
    if (xSemaphoreTake(s_tx_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) { ESP_LOGW(TAG, "SendBinary: 抢锁超时"); return false; }
    const size_t n = ws_frame::Build(s_frame, kMaxBinaryPayload + 16, ws_frame::kBinary, data, len, esp_random());
    bool ok = false;
    if (n && s_sock >= 0) ok = SendAll(s_sock, s_frame, n);
    xSemaphoreGive(s_tx_mutex);
    if (ok) ++s_stats.tx_frames;
    return ok;
}

void Start(const char* url) {
    if (s_tx_mutex) return;   // 只启动一次
    s_tx_mutex = xSemaphoreCreateMutex();
    if (!ParseUrl(url, &s_target)) {
        ESP_LOGE(TAG, "URL 不合法（只支持 ws://host:port/path）: %s", url ? url : "(null)");
        return;
    }
    ::snprintf(s_stats.host, sizeof(s_stats.host), "%s", s_target.host);
    s_stats.port = s_target.port;
    ESP_LOGI(TAG, "目标 %s:%d%s", s_target.host, s_target.port, s_target.path);

    const BaseType_t ws_task_ok = xTaskCreate(
        [](void*) {
            int backoff = 1000;
            int fail_streak = 0;
            // 开机先广播找一次桥：换网后 PC 的 IP 变了也能自己找到。
            // （之前只在连续失败两次后才找，而 Dial 一个不可达 IP 会卡很久，
            //  换网后要等好几分钟 —— 2026-10-30 实测。）
            {
                char found[48] = {0};
                int fport = s_target.port;
                if (bridge_find::Find(found, sizeof(found), &fport, 1500)) {
                    ::snprintf(s_target.host, sizeof(s_target.host), "%s", found);
                    s_target.port = fport;
                    ::snprintf(s_stats.host, sizeof(s_stats.host), "%s", found);
                    s_stats.port = fport;
                    ESP_LOGW(TAG, "开机广播找到桥 %s:%d，改用之", found, fport);
                }
            }
            for (;;) {
                if (!net::WifiConnected()) {
                    vTaskDelay(pdMS_TO_TICKS(1000));
                    continue;
                }
                const int sock = Dial(s_target);
                if (sock < 0) {
                    ESP_LOGW(TAG, "连接失败：%s，%dms 后重试", s_stats.last_error, backoff);
                    // 连续失败 → 桥可能换 IP 了（DHCP / 换了网络）：广播找一次。
                    // 找到就改写目标，下一次循环立刻用新地址。
                    if (++fail_streak >= 2) {
                        fail_streak = 0;
                        char found[48] = {0};
                        int port = s_target.port;
                        if (bridge_find::Find(found, sizeof(found), &port)) {
                            ::snprintf(s_target.host, sizeof(s_target.host), "%s", found);
                            s_target.port = port;
                            ::snprintf(s_stats.host, sizeof(s_stats.host), "%s", found);
                            s_stats.port = port;
                            backoff = 300;
                            ESP_LOGW(TAG, "改用发现到的桥 %s:%d", found, port);
                        }
                    }
                    vTaskDelay(pdMS_TO_TICKS(backoff));
                    backoff = backoff < 10000 ? backoff * 2 : 10000;
                    ++s_stats.reconnects;
                    continue;
                }
                fail_streak = 0;
                s_sock = sock;
                if (!Handshake(sock, s_target)) {
                    ESP_LOGW(TAG, "握手失败：%s", s_stats.last_error);
                    ::close(sock);
                    s_sock = -1;
                    vTaskDelay(pdMS_TO_TICKS(2000));
                    ++s_stats.reconnects;
                    continue;
                }
                backoff = 1000;
                SessionOnce(sock);
                ::close(sock);
                s_sock = -1;
                s_connected = false;
                ++s_stats.reconnects;
                vTaskDelay(pdMS_TO_TICKS(1000));
            }
        },
        // 优先级 6：必须高于渲染(4)、低于音频(7)。接包被 UI 抢占时，下行 PCM 会从
        // 几十 KB/s 掉到 ~20 KB/s，设备的 12 秒环形缓冲照样会被抽干（2026-10-31 实测）。
        "ws", 5120, nullptr, 6, nullptr);
    if (ws_task_ok != pdPASS) {
        ESP_LOGE(TAG, "ws 任务创建失败！栈 5120 / 内部堆 %u / 最大块 %u", 
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    }
}

}  // namespace ws
