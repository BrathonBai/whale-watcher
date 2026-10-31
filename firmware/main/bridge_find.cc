// bridge_find.cc —— 见 bridge_find.h。
#include "bridge_find.h"

#include <cstdlib>
#include <cstring>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include "esp_log.h"

namespace bridge_find {
namespace {

constexpr const char* TAG = "find";
constexpr int kDiscoverPort = 7789;

}  // namespace

bool Find(char* host, size_t host_cap, int* port, int timeout_ms) {
    if (!host || host_cap < 8 || !port) return false;

    const int fd = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0) {
        ESP_LOGW(TAG, "socket() 失败");
        return false;
    }
    int yes = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
    struct timeval tv = {};
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    const char* q = "{\"t\":\"who\"}";
    struct sockaddr_in to = {};
    to.sin_family = AF_INET;
    to.sin_port = htons(kDiscoverPort);
    to.sin_addr.s_addr = htonl(INADDR_BROADCAST);
    // 广播丢包很常见（AP 限速、省电休眠），连发三次比等重传便宜
    for (int i = 0; i < 3; ++i) {
        ::sendto(fd, q, std::strlen(q), 0, reinterpret_cast<sockaddr*>(&to), sizeof(to));
    }

    char buf[256];
    for (int tries = 0; tries < 2; ++tries) {
        struct sockaddr_in from = {};
        socklen_t fl = sizeof(from);
        const int n = ::recvfrom(fd, buf, sizeof(buf) - 1, 0, reinterpret_cast<sockaddr*>(&from), &fl);
        if (n <= 0) continue;
        buf[n] = '\0';

        int p = 7788;
        const char* k = std::strstr(buf, "\"port\"");
        if (k) {
            const char* c = std::strchr(k, ':');
            if (c) p = std::atoi(c + 1);
            if (p <= 0 || p > 65535) p = 7788;
        }
        if (!::inet_ntoa_r(from.sin_addr, host, static_cast<socklen_t>(host_cap))) {
            continue;
        }
        ::close(fd);
        ESP_LOGW(TAG, "发现桥 %s:%d（%s）", host, p, buf);
        *port = p;
        return true;
    }

    ::close(fd);
    ESP_LOGI(TAG, "广播没找到桥（桥那侧发现端口 7789 没开？）");
    return false;
}

}  // namespace bridge_find
