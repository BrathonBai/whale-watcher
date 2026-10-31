# 协议 v2 契约（设备 ⇄ 桥）

> **本文件由 `tools/gen-contract-doc.mjs` 生成，请勿手改。**
> 唯一事实源是 `bridge/lib/contract.js`；改了契约就重新生成，并跑
> `node test/contract.test.mjs`（它会比对本文件与代码是否一致）。
>
> 上位背景：v0.2 的桥是照 v1 固件（fw 0.8）写的，v2 上来后只"让它连上"，
> 没有反向核对契约，于是 press/record/mic/level/sound/diag 这些消息在 v2 里
> 根本没有对端，工具却照样注册给模型 → "工具都在、用起来空转"。
> 这一版的原则：**设备没有的，桥就不假装有**。

- 协议版本（桥侧）：2
- 设备自报：fw=`hub_v2` · ver=`0.2` · 屏 412×412
- 摄像头：240×240 JPEG，≤ 4 MB，周期 8000 ms
- 音频：24000 Hz / 16 bit / 1 ch，单段 ≤ 10 s
- 桌宠素材：三段（idle / look / wave），10 fps

## 一、设备 → 桥（只有 4 种）

| t | 字段 | 固件出处 |
|---|---|---|
| `hello` | fw, board, ver(字符串), cam, w, h | app_ui.cc:126（ver 是字符串 "0.2"，cam=1, w/h=240） |
| `pong` | — | app_ui.cc:255（收到 ping 回 pong） |
| `image` | bytes, w, h, seq + 二进制分块 | app_ui.cc:294-309（文本头 + 16KB 二进制分块） |
| `voice` | bytes, rate, seq + 二进制分块 | app_ui.cc:141 + proto.cc:401（BuildVoice 头 + 分块） |

其它任何 `t` 一律回 `UNSUPPORTED_UPLINK`（**不是**"向前兼容地解析成功"）。

## 二、桥 → 设备（只有 7 种）

| t | 字段 | 固件出处 |
|---|---|---|
| `welcome` | ver | app_ui.cc:253（收到后只打一行日志，内容忽略） |
| `ping` | ver | app_ui.cc:255 |
| `say` | text, mood | app_ui.cc:258-262（上屏 + mood，等音频播完才熄灯） |
| `face` | mood | app_ui.cc:263（只改 mood） |
| `audio` | rate, bits, ch, bytes, seq | app_ui.cc:265-269（建环形缓冲 + 垫 120ms 头） |
| `audio_end` | seq | app_ui.cc:270-276（对账丢帧 + 垫 180ms 尾） |
| `shot` | — | app_ui.cc:254（Parse 之前用裸 strstr 匹配 "shot"） |

`device.send()` 会拦：不在上表里的 `t` 直接拒绝并计入 `counters.rejected`。

## 三、v2 不具备的能力（写清原因，工具因此不注册）

| 消息 | 为什么没有 |
|---|---|
| `press` | 按键只在设备本地起作用（录音开关/菜单），v2 不上行 press |
| `record` | v2 不处理 record 下行：录音只能由设备物理按键触发 |
| `mic` | v2 不处理 mic 下行：没有免按键自动录音 |
| `state` | v2 不上报电量/表情状态 |
| `level` | v2 不上报旋钮/触摸数值 |
| `sound` | v2 不做环境声分类 |
| `diag` | v2 不上报自检遥测 |
| `text` | v2 没有文本上行通道（按键录音后走 voice） |

## 四、工具与依赖

| 工具 | 依赖下行 | 说明 |
|---|---|---|
| `device_status` | — |  |
| `device_say` | `say` |  |
| `device_face` | `face` |  |
| `device_shot` | `shot` | 发 shot 等设备回 image，落盘后返回路径 |
| `device_events` | — |  |
| `device_capabilities` | — | 如实告诉模型能做什么、不能做什么 |

## 五、HTTP 路由

- 只读：`/health` `/api/state` `/events` `/commands` `/moods` `/panel` `/` `/shot.jpg`
- 动作（本机免令牌 / 配了 panelToken 要 Bearer）：`/say` `/api/speak` `/api/face` `/shot` `/api/config` `/api/linktest`
- 历史接口（返回 501 + 原因，不是 404）：
  - `/listen`：v2 没有 record 下行，无法远程触发录音；请按设备上的按键
  - `/mic`：v2 没有 mic 下行，无法远程开关自动录音

## 六、表情 → 桌宠素材

| mood | clip |
|---|---|
| `idle` | `idle` |
| `blink` | `idle` |
| `listen` | `look` |
| `think` | `look` |
| `speak` | `wave` |
| `happy` | `wave` |
| `sad` | `idle` |
| `error` | `look` |

映射与固件 `render.cc:269-282` 的 `PetClipFor` 一一对应；改这里必须同时改那边。

## 七、机器可读摘要

```json
{
  "protocolVersion": 2,
  "uplink": [
    "hello",
    "pong",
    "image",
    "voice"
  ],
  "downlink": [
    "welcome",
    "ping",
    "say",
    "face",
    "audio",
    "audio_end",
    "shot"
  ],
  "tools": [
    "device_status",
    "device_say",
    "device_face",
    "device_shot",
    "device_events",
    "device_capabilities"
  ],
  "unsupported": {
    "press": "按键只在设备本地起作用（录音开关/菜单），v2 不上行 press",
    "record": "v2 不处理 record 下行：录音只能由设备物理按键触发",
    "mic": "v2 不处理 mic 下行：没有免按键自动录音",
    "state": "v2 不上报电量/表情状态",
    "level": "v2 不上报旋钮/触摸数值",
    "sound": "v2 不做环境声分类",
    "diag": "v2 不上报自检遥测",
    "text": "v2 没有文本上行通道（按键录音后走 voice）"
  },
  "routes": {
    "read": [
      "/health",
      "/api/state",
      "/events",
      "/commands",
      "/moods",
      "/panel",
      "/",
      "/shot.jpg"
    ],
    "act": [
      "/say",
      "/api/speak",
      "/api/face",
      "/shot",
      "/api/config",
      "/api/linktest"
    ]
  }
}
```
