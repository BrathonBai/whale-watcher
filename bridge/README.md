# dsh-embodied-bridge

把具身节点（SenseCAP Watcher / 鲸鲸 v2）接进 DSH 大脑的插件。

```
设备（固件 v2 / fw "hub_v2"）⇄ WebSocket ⇄ 本插件 ⇄ DSH 会话（默认）／DSH llm（回退）
```

- **设备说话 → 大脑**：按设备上的键录一段 → `voice` 上行 → ASR → 进一个**真正的 DSH 会话**
  （侧栏里能点开看、能插话、共用工具和记忆），回答再回到设备上屏 + 念出来。
- **大脑 → 设备**：六个工具 `device_status / device_say / device_face / device_shot /
  device_events / device_capabilities`，加一套自服务的面板和 HTTP 接口。
- **不连 QQ、不碰外网**：局域网 WebSocket + UDP 发现，谁也不用注册。

形态上抄的是 Meta [Muse Gadgets](https://github.com/facebookincubator/muse-gadget-sdk) 的
`link.register` / `link.invoke`（命令先声明再调用、结果统一 `{ok,payload}` / `{ok:false,error}`），
工程上的模块化、面板、开放接口、服务暴露则参考了
[aurabot](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)。

## v0.3：对着 v2 固件重写（不是打补丁）

v0.2 是照 v1 固件（fw 0.8）写的。v2 上来时只"让它连上"，没有反向核对契约，
于是 `press/record/mic/level/sound/diag` 这些消息在 v2 里根本没有对端，
工具却照样注册给模型 → **工具都在、调用了空转**。

v0.3 的做法：**设备没有的，桥就不假装有。**

| 变化 | 说明 |
|---|---|
| 契约单一事实源 | `lib/contract.js`：上行 4 种、下行 7 种、"不具备"8 种（带原因）。文档由 `tools/gen-contract-doc.mjs` 生成到 `docs/协议-v2-契约.md`，`test/contract.test.mjs` 比对，手改会红 |
| 协议层砍掉 v1 残留 | `parseDeviceMessage` 只认 `hello/pong/image/voice`；其余回 `UNSUPPORTED_UPLINK`，不再"解析成功然后没人用" |
| `hello.ver` 修对 | v2 发的是字符串 `"0.2"`，v1 桥按数字解析 → 日志里永远 `ver=0`；现在原样保留 |
| 工具按能力注册 | `TOOL_NEEDS` 声明依赖哪条下行；缺能力就不注册。`device_listen`/`device_mic` 已被摘掉（v2 没有 `record`/`mic` 下行） |
| 新增 `device_shot` | 发 `{t:"shot"}` → 设备拍一张 → 落盘 → 返回路径（面板也能看） |
| 新增 `device_capabilities` | 如实告诉模型：能做什么、不能做什么、为什么 |
| 采集状态机 | 图片/语音累积从"裸变量 + 猜"改成显式状态（`idle/image/voice`），带 30 s 超时、溢出与孤立字节计数 |
| 下行闸门 | `device.send()` 拦截契约外的 `t`，计入 `counters.rejected`，不静默发出 |
| 失败显式化 | ASR 空会写出三路各为什么失败（`asr.lastReason`）；TTS 缺 key 在启动日志与 `/health` 直接报 |
| 旧接口不再假装能用 | `/listen`、`/mic` 保留路径但返回 **501 + 原因**（不是 404），历史脚本能看懂 |

## 装的工具

| 工具 | 作用 |
|---|---|
| `device_say` | 说一段短文本（可选表情），同时念出来 |
| `device_face` | 只改表情；v2 按 mood 选三段桌宠素材：`idle`=待机 `look`=倾听/张望 `wave`=讲述/兴奋 |
| `device_shot` | 现在拍一张（240×240 JPEG），返回落盘路径 |
| `device_status` | 在线状态 / 连接时长 / fw+ver / 最近上行 / 大脑模式 / 会话 |
| `device_events` | 读最近上行事件（v2 只有 hello/pong/image/voice） |
| `device_capabilities` | 列出支持的上行/下行/工具，以及不具备的能力与原因 |

> 没有 `device_listen` 和 `device_mic`：v2 固件不处理 `record`/`mic` 下行，
> 录音只能按设备上的物理键。要远程开麦得先改固件，再回来改这里的契约。

## 协议（摘要）

- 上行：`hello` `pong` `image` `voice`
- 下行：`welcome` `ping` `say` `face` `audio` `audio_end` `shot`
- 完整表格、字段、固件出处：[`docs/协议-v2-契约.md`](../docs/协议-v2-契约.md)

## 存储与保留（2026-10-31 起）

拍照已改成**只按需**：固件不再 8 秒周期采样，也不在开始录音时顺手拍一张
（ESP32-S3 跑视频流不现实，而且每张都要落盘、没人清理）。要图就显式调 `device_shot` / `POST /shot`。

桥侧仍然会落盘（模型要读图），但加了保留策略：

| 项 | 位置 | 默认保留 | 配置键 |
|---|---|---|---|
| 照片 | `plugins-data/embodied-bridge/workspace/images/*.jpg` | 最近 **20** 张 | `imageKeep` |
| 语音 | `plugins-data/embodied-bridge/voice/*.wav` | 最近 **50** 段 | `voiceKeep` |

- 每次保存后按 mtime 删最旧的；**启动时也清一次**（日志会打“存储：…（保留最近 N）”）。
- 模型真正用到的只有最新一张（`lastImage`），面板也只预览最新一张，所以 20 张足够翻查。
- 当前占用直接看 `/health` 的 `storage` 字段（图片/语音的文件数与字节，附带 keep 值）。

## 跑测试

```powershell
cd ~/.dsh/plugins/dsh-embodied-bridge     # 或本工作区的 bridge/
node test/protocol.test.mjs   # 11 条：真实抓帧、旧消息必须被拒、构造器都在契约内
node test/ws.test.mjs         #  5 条：RFC 6455 编解码
node test/speech.test.mjs     # 10 条：PCM 只发偶数字节帧（错位=噪声）+ 预缓冲闸门 5 条
node test/retention.test.mjs  #  5 条：保留策略只删旧的、不误删别的文件
node test/contract.test.mjs   #  8 条：契约哨兵（含文档一致性）
node test/session.mjs         # 会话模式（假 DSH 宿主）
node test/loop.mjs            # 端到端（假设备走真 WebSocket）
node test/audit.mjs           # 静态+动态审计：配置键/工具/路由/服务/面板/命令目录
node test/tts-smoke.mjs       # 真调 Breeze、真数设备收到的 PCM（需 BREEZE_API_KEY，没有就跳过）
node test/prebuf-live.mjs     # 真调 Breeze + 假设备：量起播后的"缓冲领先量"，证明不卡顿（需 key）
```

> 不要用 `node --test`：它给每个文件派生子进程，受限环境下会 `spawn EPERM`。

### TTS 端点参数（2026-10-31 实测）

`output_format` 只接受 **`wav` / `mp3` / `pcm`**；写 `wav_24000` 会被服务端回
`404 RESOURCE_NOT_FOUND "Voice not found"`（误导性错误，音色其实存在）。
整段用 `?output_format=wav`（头就是 24 kHz/mono/16 bit），流式用
`/stream?output_format=pcm`（裸 PCM，首包约 1.3 s）。`breezeStream: true` 是正确配置。

### 流式音频的时序：必须预缓冲（2026-10-31 实测）

流式分块是**一阵一阵**来的，边到边播一定会卡：

| 指标 | 实测值 |
| --- | --- |
| 首块到达 | 1117 ms（只带 80 ms 音频） |
| 起播时领先量 | **−1038 ms**（设备缓冲是空的） |
| 单块最大间隔 | 393 ms |
| 平均每块音频 / 间隔 | 27 ms / 13 ms（整体比实时快，但前段是空的） |

设备一收到 `audio` 头就开播，先播完 120 ms 头静音就开始空转 —— 听感就是"卡顿"。
`ttsPreBufferMs`（默认 **1000**）让桥先攒够 PCM 再发头和首批，由 `makePrebufferGate`
实现（`onStart` 保证头永远在第一个二进制帧之前）：

- 实测（两次）：首帧 **1241–1355 ms**，起播时领先 **1012–1072 ms**；起播后最小领先 896–925 ms，块间隔最大 574 ms 也仍被吸收
- 代价：开口晚约 0.2 s，换来全程连续
- 短句不足预缓冲 → `start()` 兜底一次性发完；设 `0` 回到旧的"来了就推"（不建议）

### 链路带宽自检 `/api/linktest`

```powershell
Invoke-RestMethod 'http://127.0.0.1:7788/api/linktest?seconds=3' -Method Post
```

往设备灌 N 秒**静音 PCM**（不经过 TTS），返回写了多少字节。到达耗时看设备串口
`音频头` → `音频收尾` 的时间差：**差 ÷ N = 链路倍速**。24 kHz/16 bit 的 PCM 需要
**48 KB/s**；实测这条 WiFi 只有 21–28 KB/s，所以长句必然断（详见
`docs/故障手册-2026-10-31.md` §12）。判据：倍速 ≥ 1.3 才可能不卡。

### 任务优先级（固件，2026-10-31 修）

渲染必须最低，否则会同时饿死 I2S 和 WS 接收：**音频 7 / WS 6 / 录音 5 / 渲染 4 / 心跳 3**。
改之前是渲染 6 > WS 5 = 音频 5，实测下行被压到 13–15 s 才传完 6 s 音频；改完 7.6–9.8 s。

## 配置

三层，后者覆盖前者：`lib/config.js` 的 `DEFAULTS` ← `plugins-data/embodied-bridge/config.json`
← `profile/cordis.patch.yml`。

**音色 / API key / 模型只写 patch 层**；改完必须**完整重启 DSH**（热重载不会重解析 patch 层，
表现为"改了没生效、重启后回退"）。`/health` 里的 `config` 就是**运行时真正生效**的值——
它和 patch 不一致时，以 `/health` 为准，说明 patch 没进去。
