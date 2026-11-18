# 端云协同具身 Agent — 落地设计（ESP32-S3）

> 输入：你给的结构化架构约束（L0/L1/L2 三层、事件总线、MCP + Policy Gate、三任务骨架）。
> 输出：模块划分 / 技术栈 / 目录结构 / **三任务接口定义** / **云端流式管道伪代码** / 里程碑。
> 两块实机：SenseCAP Watcher（8MB PSRAM、摄像头+Himax NPU）、M5Stack Cardputer-Adv（FN8 无 PSRAM、BMI270、键盘）。

---

## 0. 先改你 brief 里的 5 处（其余全部接受）

| # | 你的写法 | 问题 | 改成 |
|---|---|---|---|
| 1 | IMU 用 **XOR + RLE** 增量压缩 | 浮点做 XOR 没有意义（同一物理量的相邻浮点位模式差异巨大，压缩率反而差） | **量化成 int16（mg，1/1000g）→ 帧间 delta → zigzag varint + RLE**。实测压缩比 4~6×，解压是纯整数运算 |
| 2 | L1 用 **Lua 虚拟机** | LVGL+Lua 在无 PSRAM 的板子上吃 100KB+ 常驻，且没有调试器 | **规则表解释器**（JSON → 定长规则数组，300 行 C）。真要脚本再上 mJS；Lua 留作可选 |
| 3 | "拒绝全双工音频流" + "持续低码率上传" | 自相矛盾 | **半双工 + VAD 门控**：只说人声段（opcode 帧带序号），下行 TTS 流式抢断（barge-in 走本地能量门，不等云） |
| 4 | Policy Gate 只做"拒绝" | 拒绝 ≠ 安全。云端下发"继电器开"，设备执行了，之后云端失联 → 继电器永远开着 | Gate = **拒绝 + 钳位 + 看门狗强制回退**。每条 actuator 指令带 `max_on_ms`，由 `esp_timer` 强制关断，与云端是否在线无关 |
| 5 | L0 说"微秒级" | ESP32-S3 上 I2C 读 IMU 不可能微秒级 | L0 现实目标：**中断→动作 < 2ms**。BMI270 用 FIFO 的 INT 引脚走真中断，不轮询 |

另外：`MimiClaw` / `灵枢 Agent Mesh` 我没有可靠资料，只按你给的两句语义（消息队列+双核隔离 / Guardian 策略检查）吸收，不引用其代码。

---

## 1. 模块划分（端侧）

| 模块 | 核 | 优先级 | 栈 | 允许 malloc | 关键约束 |
|---|---|---|---|---|---|
| `ReflexTask` | 1 | 24（最高） | 3 KB | ❌ | 不碰网络、不碰 LVGL、不加锁；只读事件环 + 直接 GPIO/timer |
| `PerceptionTask` | 1 | 12 | 12 KB | 启动期分配 | I2S DMA 回调里只做能量统计 + 入环；编码在任务上下文 |
| `SessionTask` | 0 | 8 | 16 KB | ✅（PSRAM） | 独占 WebSocket；所有下行指令必须过 PolicyGate |
| `RuleEngine`（L1） | 1 | 10 | 4 KB | ❌ | 只消费事件、产出动作，无阻塞调用 |
| `CapabilityRegistry` | — | — | — | 启动期 | 描述符 → 工具/事件/UI；运行期可增删 |
| `PolicyGate` | 任意 | — | — | ❌ | 纯函数 + 白名单表；拒绝/钳位都产审计事件 |
| `UiTask`（LVGL） | 0 | 5 | 12 KB | ✅ | 只在 Watcher/Cardputer 有屏时创建 |

**双核绑定的理由**：Wi-Fi/LWIP 的中断和 `esp_wifi` 任务默认在 core0，抖动大；音频 DMA 和反射必须远离它 → core1。core0 留给"脏活"（网络、解码、LVGL flush）。

---

## 2. 技术栈清单

| 层 | 选型 | 版本/说明 |
|---|---|---|
| RTOS / 框架 | ESP-IDF | 5.4.x（v1.8.5 同级，稳）；6.x 等板级支持齐了再迁 |
| 音频前端 | **esp-sr**（AFE：VAD + 唤醒词 WakeNet9 + NS） | Watcher 单麦无参考 → **AEC 关闭**，只开 VAD/NS |
| 采集/播放 | `esp_codec_dev` + ES8311(输出) / ES7243E(Watcher 输入) | 24 kHz / 16 bit / 单声道 |
| 编码 | `esp_audio_codec`（Opus）16 kbps@16k | 编码放 core1，输出 PSRAM 环 |
| 视觉 | `sscma_client`（Watcher 的 Himax，SPI2）+ 端侧检测 | 单帧 JPEG，禁止推流 |
| IMU | BMI270（Cardputer-Adv）+ FIFO INT | 200 Hz，int16 量化 |
| 显示 | `esp_lcd` + LVGL 9 | 412×412 / 240×135 两套 board 驱动 |
| 协议 | WebSocket（`esp_websocket_client`）+ JSON **+ 二进制 opcode 帧** | 控制面 JSON-RPC 2.0，媒体面二进制 |
| 组网 | ESP-NOW（同信道，零配置） | 双设备事件网格 |
| 云端 | Python 3.11 + asyncio + FastAPI/websockets | ASR/TTS/LLM 全流式 |
| 云端 LLM | 任意 OpenAI 兼容端点（DeepSeek / 本地 vLLM） | Function Calling |
| 工具链 | `idf.py` + 单仓多板（`boards/<name>`） | 内核零条件编译 |

---

## 3. 目录结构

```
firmware/
├── CMakeLists.txt
├── main/
│   ├── app_main.cc                 # 启动顺序：board → bus → gate → registry → tasks
│   ├── core/
│   │   ├── event.h                 # Event/Src/Topic 常量
│   │   ├── event_bus.h/.cc         # 主题前缀订阅 + 无锁 SPSC 环（高优先级通道）
│   │   ├── capability.h/.cc        # 描述符解析 → 工具/事件/UI 注册
│   │   ├── rule_engine.h/.cc       # L1：JSON 规则表 → 动作
│   │   ├── policy_gate.h/.cc       # 白名单 + 钳位 + max_on_ms 看门狗 + 审计
│   │   └── result_envelope.h       # command_id/trace_id/status
│   ├── tasks/
│   │   ├── reflex_task.h/.cc       # L0
│   │   ├── perception_task.h/.cc   # 感知管道
│   │   └── session_task.h/.cc      # 端云会话 + 下行执行
│   ├── mcp/
│   │   ├── device_mcp.h/.cc        # tools/list, tools/call, 结果封装
│   │   └── mcp_bridge.h/.cc        # 侧边车 UART / ESP-NOW 对端的工具镜像
│   ├── transport/
│   │   ├── ws_client.h/.cc
│   │   ├── espnow_mesh.h/.cc
│   │   └── opus_frame.h            # 二进制帧头
│   └── boards/
│       ├── board.h                 # 纯虚接口：audio/display/camera/imu/gpio
│       ├── watcher/
│       └── cardputer/
├── components/                     # 复用：lvgl, esp_lcd_*, sscma_client, esp-sr
└── rules/                          # SD/LittleFS 上的 JSON 能力与规则

cloud/
├── server.py                       # ws 接入 + 会话
├── pipeline.py                     # 流式 VAD→ASR→LLM→TTS
├── mcp_hub.py                      # 把设备工具转成 LLM tools 定义
├── policy.py                       # 云侧预检（和设备侧 Gate 双保险）
└── proto.py                        # 信封/帧编解码，与固件保持单一事实源
```

---

## 4. 端侧三任务接口定义

### 4.1 事件与环

```cpp
// core/event.h
#pragma once
#include <cstdint>
#include <string>

enum class Src : uint8_t { Local, Timer, Net, Mesh, Mcp };

struct Event {
    const char* topic;      // 静态字符串，禁止运行期拼接
    Src         src;
    int64_t     ts_ms;
    const void* payload;    // 指向环内缓冲，回调期间有效
    uint16_t    len;
};

// 常用主题（编译期常量，避免动态分配）
#define TOPIC_IMU_MOVED     "imu.moved"
#define TOPIC_IMU_STILL     "imu.still"
#define TOPIC_AUDIO_LOUD    "audio.loud"
#define TOPIC_AUDIO_WAKE    "audio.wake"
#define TOPIC_VISION_PERSON "vision.person"
#define TOPIC_KEY_PRESS     "key.press"
#define TOPIC_NET_CMD       "net.cmd"       // 下行指令（已过 Gate）
#define TOPIC_NET_LOST      "net.lost"
#define TOPIC_AUDIT_DENY    "audit.deny"
```

```cpp
// core/event_bus.h
#pragma once
#include "core/event.h"
#include <functional>

class EventBus {
public:
    using Handler = std::function<void(const Event&)>;

    // 前缀订阅："imu.*" 可匹配 "imu.moved"
    int  Subscribe(const char* topic_prefix, Handler h, int priority = 0);
    void Unsubscribe(int id);

    // 普通投递：在 bus 任务上下文派发，允许 malloc
    void Publish(const Event& e);

    // 高优先级投递：写入无锁 SPSC 环，由 ReflexTask 消费；payload ≤ 64B，会被拷进环
    bool PublishFast(const Event& e);

    static EventBus& Get();
};
```

### 4.2 ReflexTask（L0，硬实时反射）

```cpp
// tasks/reflex_task.h
#pragma once
#include "core/event_bus.h"

class ReflexTask {
public:
    struct Config {
        uint32_t stack      = 3072;
        UBaseType_t prio    = 24;
        BaseType_t core     = 1;
        uint32_t max_action_us = 2000;   // 超过就记 audit.slow
    };

    // 必须在 bus/音频/IMU 之前启动；内部自建 SPSC 消费环
    static bool Start(const Config& cfg = {});

    // 由 ISR 或高优先级上下文调用；只做入环，不做任何 I/O
    static bool PostFromIsr(const Event& e);

    // 注册一条"反射弧"：命中即执行 action（在 ReflexTask 上下文）
    using Action = std::function<void(const Event&)>;
    static void Bind(const char* topic, Action a);
};
```

实现要点：
- `ReflexTask` 是 `while(1) { xQueueReceive(ring, ...); dispatch(); }`，队列深度 16，`portMAX_DELAY`。
- **不做任何 I/O**：动作只能是 `gpio_set_level` / `ledc_set_duty` / `esp_timer_start_once` / `EventBus::Publish`。
- 允许的动作白名单硬编码：GPIO 写、PWM、RGB、屏背光、蜂鸣、发事件。**不许**开 socket、不许写 flash、不许可变长 malloc。

### 4.3 PerceptionTask（感知管道）

```cpp
// tasks/perception_task.h
#pragma once
#include <cstdint>

class PerceptionTask {
public:
    struct Config {
        uint32_t sample_rate   = 24000;
        uint8_t  channels      = 1;
        uint16_t frame_ms      = 20;      // 20ms 一帧
        uint32_t vad_tail_ms   = 600;     // 静音多久判一句结束
        uint32_t energy_gate   = 1500;    // 粗能量门（int16 RMS），先于 VAD
        uint32_t stack         = 12288;
        UBaseType_t prio       = 12;
        BaseType_t core        = 1;
        bool     enable_wake   = true;    // esp-sr WakeNet9
    };

    static bool Start(const Config& cfg = {});

    // 云端/本地触发：抓一帧 JPEG（阻塞 ≤2s，仅 SessionTask 调用）
    static bool CaptureJpeg(uint8_t** out_buf, size_t* out_len, bool high_res = true);

    // IMU 采样在 board 层的中断里跑，这里只提供摘要接口
    static bool ImuSummary(uint8_t* out, size_t cap, size_t* out_len);

    // 上行音频：由 SessionTask 拉取（不主动推，避免背压穿透到音频任务）
    static size_t ReadOpus(uint8_t* out, size_t cap, uint32_t timeout_ms);

    // 统计（走 /debug 页与事件）
    static void Stats(uint32_t* frames_in, uint32_t* frames_dropped,
                      uint32_t* opus_bytes, uint16_t* rms_last);
};
```

数据流：
```
I2S DMA(20ms) ─ISR─► rms 统计 ──► 若 rms>gate 或 已在语句中 → 送 esp-sr AFE(VAD/NS/唤醒)
                                   │
                     AFE 输出 16k PCM ──► Opus 编码（core1，任务上下文）──► PSRAM 环（4 段 × 8KB）
                                                                             │
                                                          SessionTask 拉取 ──► WS
                       唤醒/语音段结束事件 ──► EventBus ──► ReflexTask / RuleEngine
```
- `ReadOpus` 带超时，环满时**丢最旧**并计数（宁可丢帧，不可阻塞音频）。
- 无 PSRAM 的板（Cardputer）把环缩到 2×2KB，并强制 `sample_rate=16000`。

### 4.4 SessionTask（云端会话）

```cpp
// tasks/session_task.h
#pragma once
#include <string>

class SessionTask {
public:
    struct Config {
        const char* ws_url;
        const char* token;
        uint32_t    stack       = 16384;
        UBaseType_t prio        = 8;
        BaseType_t  core        = 0;      // 跟 Wi-Fi 同核，别抢 core1
        uint32_t    cmd_timeout = 5000;   // 单条下行指令的执行超时
        uint8_t     max_inflight = 4;
    };

    static bool Start(const Config& cfg);

    // 上行：把一条事件推给云端（失败进重发队列，最多 32 条）
    static bool Report(const Event& e);

    // 下行处理顺序（固定，不可跳步）：
    //   parse → schema validate → PolicyGate::Check → execute → result envelope
    // 任何一步失败都要回 result(error) + audit 事件
    static void OnIncoming(const char* json, size_t len);

    // 连接状态机
    static bool Connected();
};
```

下行指令执行（`OnIncoming` 内部）：

```cpp
// 1) 解析信封
CommandEnvelope env = Parse(json);          // {command_id, trace_id, tool, args, timeout_ms}

// 2) Gate：白名单 + 参数钳位 + 危险动作附加约束
GateDecision d = PolicyGate::Check(env);
if (!d.allowed) {
    SendResult(env, Status::Denied, d.reason);     // 审计事件合并进 result
    EventBus::Get().Publish({TOPIC_AUDIT_DENY, Src::Local, now_ms(), d.reason, strlen(d.reason)});
    return;
}

// 3) 执行（MCP 工具表；executor 在 SessionTask 上下文，可阻塞）
Result r = DeviceMcp::Dispatch(d.env.tool, d.env.args, d.env.timeout_ms);

// 4) 回传结构化结果（闭环）
SendResult(env, r.ok ? Status::Ok : Status::Error, r.payload_json);
```

### 4.5 PolicyGate（安全闸）

```cpp
// core/policy_gate.h
#pragma once
#include "core/result_envelope.h"

enum class Severity : uint8_t { Safe, Low, High };   // High 需要二次确认或本地策略放行

class PolicyGate {
public:
    struct Decision {
        bool        allowed;
        CommandEnvelope env;      // 可能被钳位后的参数
        const char* reason;       // 拒绝原因（进审计）
        Severity    sev;
    };

    // 规则：①工具白名单 ②参数类型/范围 ③速率限制 ④危险动作必须带 max_on_ms
    static Decision Check(const CommandEnvelope& in);

    // 关键：给 actuator 类指令注册"必须参数"与钳位范围
    static void RegisterActuator(const char* tool,
                                 int  min_on_ms, int max_on_ms,
                                 const char* const* allowed_params, size_t n);
};
```

强制回退（这条比"拒绝"重要）：

```cpp
// 任何 actuator 执行后立刻武装看门狗；超时由 esp_timer 回调强制关断，
// 与云端是否在线、是否发过"关"指令完全无关。
static void ArmDeadline(const char* tool, int on_ms);
// esp_timer 回调里：board->ActuatorOff(tool); Report(audit.timeout);
```

---

## 5. 云端流式管道伪代码

```python
# cloud/pipeline.py
import asyncio, json, time
from dataclasses import dataclass
from typing import AsyncIterator

@dataclass
class Frame:
    kind: str        # "json" | "audio_up" | "audio_down"
    payload: bytes
    seq: int

class StreamPipeline:
    """
    一条会话 = 一个双向管道：
      device --audio_up--> VAD --> ASR(流式) --> LLM(流式, 带 tools) --> TTS(流式) --audio_down--> device
                                                     ↕ tool_call
                                              device MCP tools
    关键原则：
      1) 早出字：LLM token 一到就送 TTS，不等整句
      2) 可抢断：设备端本地能量门触发 barge-in，云端立刻 abort TTS 并丢弃未发音频
      3) 工具调用期间保持音频空闲（可播提示音），超时按 timeout_ms 失败并回 result(error)
    """

    def __init__(self, ws, asr, llm, tts, tools: "McpHub", policy):
        self.ws, self.asr, self.llm, self.tts = ws, asr, llm, tts
        self.tools, self.policy = tools, policy
        self.audio_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=64)
        self.tts_task: asyncio.Task | None = None
        self.turn_id = 0

    # ---------- 上行 ----------
    async def on_frame(self, f: Frame):
        if f.kind == "audio_up":
            if self.audio_q.full():            # 背压：丢最旧，绝不阻塞 WS 读
                self.audio_q.get_nowait()
            await self.audio_q.put(f.payload)
        elif f.kind == "json":
            msg = json.loads(f.payload)
            if msg.get("type") == "barge_in":
                await self.abort_tts()
            elif msg.get("type") == "result":
                self.tools.resolve_result(msg)  # 唤醒等待中的 tool_call

    # ---------- 主循环 ----------
    async def run(self):
        async for seg in self.vad_segments():          # 只处理"人声段"
            self.turn_id += 1
            transcript = await self.transcribe(seg)    # 流式 ASR 增量
            if not transcript.strip():
                continue
            await self.reply(transcript)

    async def vad_segments(self) -> AsyncIterator[bytes]:
        """把连续 audio_up 切成语句；静音 >600ms 或达到 15s 上限即切段。"""
        buf, silence, total = bytearray(), 0, 0
        while True:
            chunk = await self.audio_q.get()
            buf += chunk; total += len(chunk)
            silence = silence + len(chunk) if is_silent(chunk) else 0
            if silence > 600 * 32 or total > 15 * 32000:   # 16k*2B = 32B/ms
                if buf:
                    yield bytes(buf)
                buf, silence, total = bytearray(), 0, 0

    # ---------- 认知 ----------
    async def reply(self, user_text: str):
        await self.abort_tts()
        self.tts_task = asyncio.create_task(self._speak_loop())
        try:
            async for ev in self.llm.stream(user_text, tools=self.tools.schemas()):
                if ev.kind == "text":
                    await self.tts_q.put(ev.text)              # 早送 TTS
                elif ev.kind == "tool_call":
                    await self.tts_q.put("")                   # 让 TTS 先吐完已排队的
                    result = await self.call_device(ev)
                    async for ev2 in self.llm.continue_with(result):
                        if ev2.kind == "text":
                            await self.tts_q.put(ev2.text)
        finally:
            await self.tts_q.put(None)                          # 结束标记

    async def call_device(self, call) -> dict:
        """把 LLM 的 tool_call 变成一条带 trace 的设备指令，并等 result。"""
        trace_id = f"{self.turn_id}-{call.id}"
        allowed, reason = self.policy.precheck(call.name, call.args)   # 云侧预检
        if not allowed:
            return {"ok": False, "error": reason, "trace_id": trace_id}
        fut = self.tools.expect_result(trace_id)
        await self.ws.send(json.dumps({
            "type": "cmd", "command_id": call.id, "trace_id": trace_id,
            "tool": call.name, "args": call.args,
            "timeout_ms": self.tools.timeout_ms(call.name),
        }))
        try:
            return await asyncio.wait_for(fut, timeout=self.tools.timeout_ms(call.name) / 1000)
        except asyncio.TimeoutError:
            return {"ok": False, "error": "device timeout", "trace_id": trace_id}

    # ---------- 说 ----------
    async def _speak_loop(self):
        async for pcm in self.tts.stream(self.tts_q):        # 增量合成
            await self.ws.send_frame("audio_down", pcm)      # 二进制帧
```

配套的两条云端纪律：

1. **`Result` 必须回填给 LLM**：`{"ok":false,"error":"denied by policy"}` 这种要作为 tool 结果塞回上下文，模型才知道"物理世界没执行"。
2. **云侧 Policy 与设备侧 Gate 是双保险**，不是替代：云侧防"模型胡说"，设备侧防"云端被攻破"。

---

## 6. 协议（单一事实源）

```jsonc
// 下行指令
{"type":"cmd","command_id":"c1","trace_id":"t1","tool":"led.set",
 "args":{"on":true,"max_on_ms":3000},"timeout_ms":3000}

// 上行结果（必回）
{"type":"result","trace_id":"t1","status":"ok|denied|error|timeout",
 "latency_ms":42,"payload":{...},"audit":{"reason":"","clamped":false}}

// 上行事件
{"type":"event","topic":"vision.person","ts":1730000000000,"payload":{"count":1}}
```

二进制帧（媒体面，6 字节头）：

```
| 0x02 | flags | seq(2, LE) | len(2, LE) | payload ... |
  opus  up=0x01/down=0x02   barge-in 标志在位 0
```

---

## 7. 里程碑

| M | 目标 | 验收（可观测、可回放） |
|---|---|---|
| **M0** | 内核骨架：EventBus + 三任务空跑 + `/debug` 事件流 | 摇 Cardputer，串口与 `/debug` 同时出现 `imu.moved`；CPU 占用 <5% |
| **M1** | 上行音频闭环：I2S→VAD→Opus→WS→服务端落盘 wav | 说一句话，服务器上出现可播放的 wav；端到端 <400ms 切片延迟 |
| **M2** | 下行 TTS + 抢断 | 云端 TTS 播放中，本地喊"停"→ 音频 300ms 内停 |
| **M3** | Device MCP + 闭环 result | LLM 调 `led.set`，设备亮灯并回 `status=ok, latency_ms`；拔网线→ 回 `timeout` 且灯自动灭 |
| **M4** | PolicyGate 三件套 | ①超白名单工具 → `denied` ②参数超范围 → 被钳位且 `audit.clamped=true` ③`max_on_ms` 到点强制关断 |
| **M5** | L1 规则引擎 + 断网降级 | 拔路由器：人走过仍亮屏显示文字；规则改 JSON 重启即生效 |
| **M6** | 视觉 + 双设备网格 | 说"看下桌上有什么"→ 拍照 → 回答；Cardputer 按键 → Watcher 屏显 |

每阶段的产物都可回放（事件日志 + wav/jpg 落盘），不靠"看起来好了"。

---

## 8. 取舍（明确不做的）

- 端侧不跑 ASR 大模型；唤醒词之外不做本地语义。
- 不做视频流；视觉只有"事件帧"。
- L1 不上 Lua（除非 Cardputer 之外有 PSRAM 板）。
- 不做多租户/多设备账本（个人系统，单用户）。
- Watcher 的 `ota_1` 是空的 → **M0 之前先把分区表改成 A/B 双槽**，否则每次刷机都是单点。
