# dsh-embodied-bridge

> **DSH 插件**：本目录是一个标准 DSH Host bundle（`package.json` 声明
> `dsh.bundle.patch`，带 `locale/` 与 `icon.svg`），通过 Cordis 注册一个 WebSocket
> 设备桥。GitHub topic：`dsh-plugin` / `deepseek-harness` / `cordis`。
>
> 设备固件与真机报告在同仓库：`firmware-v2/`、`docs/`。

## 作为 DSH 插件安装

1. 有带插件管理器的 DSH（桌面版，或支持 Plugins 的 DSH 引擎）。
2. 本地目录安装：把 `bridge/` 整个目录放到任意路径，在 **Plugins → Add plugin** 选择该目录；
   或让 DSH 执行 `plugin_manager` 的 `install_bundle`，`target` 填 `bridge/` 的绝对路径。
3. 没有 npm 发布要求；也可以 `npm pack` 生成 tarball 后从本地安装。
4. 安装后插件会注册 `embodied-bridge` 一行；配置从 `plugins-data/embodied-bridge/config.json`
   或插件配置读取。DeepSeek 语音需要 `DEEPSEEK_API_KEY`（或配置 `deepseekApiKey`）。
5. 桥启动后默认 `ws://0.0.0.0:7788/device`，面板 `/panel`，健康检查 `/health`。
   手机 BLE 网关接入见仓库根 README。

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

## BLE 直连手机（2026-11-13）

设备还可以通过 **BLE** 连接手机 DSH 宿主（宿主原生层负责 BLE 网关，桥在引擎里跑）。

- 线上协议**完全不变**；只是在 `hello` 里多几个可选字段：`transport`（ble/wifi）、`uplink`
  （pcm/adpcm）、`mtu`、`name`，`pong` 里多 `transport/mtu/txDrop/rxDrop`。
- **上行语音用 IMA ADPCM 4:1**（24 kHz，1024 B/块 = 2041 采样 = 85 ms，约 12 KB/s），桥在
  `finishVoice` 里解回 PCM 再写 WAV → ASR 不用改。编解码：`lib/adpcm.js`（与 ffmpeg
  `adpcm_ima_wav` 同构，解码结果与 ffmpeg 参考实现逐采样 0 差异）。
- **下行语音**：`audioCodec=auto` 时，设备支持 adpcm 且本机没有 ffmpeg（典型的手机引擎
  环境）→ 用 ADPCM 下发；PC 有 ffmpeg 时仍用 Opus（码率更低、音质更好）。显式值：
  `pcm | opus | adpcm`；设备不支持所选编码时显式回退 PCM 并告警。
- **wsToken**（手机端必开）：`/device` 需要 `?token=<wsToken>`，否则 401。手机 loopback 上
  任何 App 都能连 127.0.0.1，没有这道口令等于把设备控制面开放给全机。PC 默认空串 = 行为不变。
- **discover**（默认开）：`discover:false` 时不绑 UDP 7789（手机端没有"局域网找桥"场景）。
- 手机宿主的 BLE 网关由宿主提供；桥只负责 WebSocket 帧、音频与工具。

## 语音：DeepSeek 官方 TTS / ASR（2026-11-13）

TTS 与 ASR 现在**默认走 DeepSeek 官方 API**（同一把 key，`Authorization: Bearer`，base
`https://api.deepseek.com`）。没配 key 时自动回退原来的 edge/sapi/breeze 与 DSH `speechToText`/命令
链路——老配置一行不改、老行为零回归，老段落原样保留（见下文「TTS 端点参数」「音频编码」）。

### 配置键（`lib/config.js` DEFAULTS ← `config.json` ← `cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `deepseekApiKey` | 空（读环境变量 `DEEPSEEK_API_KEY`） | secret；空 = 未配置 → `auto` 回退老引擎 |
| `deepseekBaseUrl` | `https://api.deepseek.com` | 也可用环境变量 `DEEPSEEK_BASE_URL` 覆盖（代理/自测） |
| `ttsEngine` | `auto` | auto：有 key → `deepseek`，否则 `edge`；显式 `deepseek/edge/sapi/breeze` 永远优先 |
| `ttsVoice` | 空 → `stella` | DeepSeek：`stella`（默认女声）/ `tide`（男声）；edge/sapi 音色名照旧 |
| `asr` | `auto` | auto：有 key 先 DeepSeek（失败/为空再走老链路）；显式 `deepseek/dsh/command/server/off` |
| `deepseekTimeoutMs` | `30000` | 单次 HTTP 超时（TTS 整段合成 / ASR 上传识别） |
| `deepseekMaxRetries` | `2` | 429（并发）/ 503（忙）指数退避重试次数；ASR 504 固定只额外重试 1 次 |
| `deepseekRetryBackoffMs` | `800` | 退避基数（指数翻倍；优先服务端 `retry-after`，单次上限 8–15 s） |

最小配置（写进 profile 的 `cordis.patch.yml`，改完**完整重启 DSH**）：

```yaml
- insert:
    - id: embodied-bridge
      name: dsh-embodied-bridge
      config:
        deepseekApiKey: sk-...
        # 可选：ttsVoice: tide / ttsEngine: deepseek / asr: deepseek
```

也可以只设环境变量 `DEEPSEEK_API_KEY`（key 不落 config.json 也能用；`/health` 里照样打码）。

### 切换与强制回退

- 用 DeepSeek：配 key（或环境变量），`ttsEngine`/`asr` 留 `auto`。
- **强制回退老引擎**（key 还在也不走 DeepSeek）：`ttsEngine: "edge"`（或 `sapi`/`breeze`）、
  `asr: "dsh"` / `"command"` / `"server"`——显式值永远优先。
- 显式写 `ttsEngine: "deepseek"` / `asr: "deepseek"` 但没 key：**显式失败并告警**，
  不会静默换引擎（换声音是事故）。`/health` 的 `tts.engine` 是实际生效值、`tts.preference`
  是配置里写的值，两个都能看；`tts.configured=false` 即"只亮屏不出声"。

### TTS 下行（固定 PCM）

- `POST {base}/v1/tools/tts`，body `{text, voice_id, format:"pcm", filter_markdown:true}`；
  整段 HTTP 拿回 **24 kHz / 16 bit / mono 裸 PCM**（回复 ≤240 字，不用 WebSocket 流式——一次拿全更简单、
  长度已知、`audio_end` 对账更可靠）。
- 下行**固定 `codec:"pcm"` 直通**：即使 hello 协商出 opus/adpcm，DeepSeek 段也不编码
  （`/api/diag.audio.effective` 会如实显示 pcm 并给出回退原因）。`audio` 头
  `rate=24000 / bits=16 / ch=1 / bytes=总长度`；分块用 `wsFrameBytes`（默认 4096；BLE 链路按
  hello.mtu 的 `mtu-3` 收窄，且每帧偶数）；发完做字节对账，再发 `audio_end`。
- 本地台词包（`voicecache`）照旧：同一句第二次命中就不出网、不重复计费；键里含 engine/音色。
- 失败/截断（content-length 对不上、PCM 奇数字节、超时）→ **不发 audio 头、绝不把半截当成功**；
  文本照常上屏，`/health.tts.lastError` 有原因。

### ASR 上行

- 设备 `voice`（pcm 或 ADPCM）按现方式解回 24 kHz/16 bit/mono PCM → **44 字节 WAV 头** →
  `POST {base}/v1/tools/asr` multipart（字段 `file`，`audio/wav`）。只用 Node 内置
  `fetch`+`FormData`+`Blob`，**没有新增 npm 依赖**。
- 本地预检：WAV ≤ **8 MiB**、时长 ≤ **120 s**（官方限制；设备单段最多 20 s），超了直接报清原因、不上传。
- 错误映射：400 格式 / 408 上传超时 / 413 过大 / 429 并发 / 503 忙 / 504 识别超时；
  429/503 退避重试，504 只额外重试一次；空文本带 `request_id` 写进 `asr.lastReason`（`/health` 可见）。
- 日志带 `request_id`、耗时、字符数/音频时长/字节数；**不打印 API key**。
- 老链路（DSH `speechToText` / `asrServerCommand` / `asrCommand`）**原样保留**，
  作为无 key 或显式模式下的回退；`route` 会标明这次走的是 `deepseek`/`server`/`dsh`/`command`。

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
node test/protocol.test.mjs    # 11 条：真实抓帧、旧消息必须被拒、构造器都在契约内
node test/ws.test.mjs          #  5 条：RFC 6455 编解码
node test/speech.test.mjs      # 10 条：PCM 只发偶数字节帧（错位=噪声）+ 预缓冲闸门
node test/speech-queue.test.mjs #  2 条：多句回复必须逐句发完（2026-11-02 回归）
node test/deepseek-speech.test.mjs # 20 条：DeepSeek TTS/ASR（2026-11-13，全 mock fetch 不出网）
node test/retention.test.mjs   #  6 条：保留策略只删旧的、不误删别的文件、imageKeep=0 至少留最新
node test/contract.test.mjs    #  9 条：契约哨兵（含文档一致性）
node test/adpcm.test.mjs       #  7 条：ADPCM 与 ffmpeg 参考实现逐采样一致、C/JS 向量、往返 SNR、短块（2026-11-13）
node test/opus.test.mjs        # 26 条：Ogg 拆包/lacing/协商回退/自适应阈值/缓存版本化（2026-11-03）
node test/session.mjs          # 会话模式（假 DSH 宿主）
node test/loop.mjs             # 端到端（假设备走真 WebSocket）
node test/loop-ble.mjs         # 端到端 BLE 语义（2026-11-13）：wsToken 401、transport/uplink、ADPCM 上行→WAV、pong 新诊断
node test/audit.mjs            # 静态+动态审计：配置键/工具/路由/服务/面板/命令目录
node test/tts-smoke.mjs        # 真调 Breeze、真数设备收到的 PCM（需 BREEZE_API_KEY，没有就跳过）
node test/prebuf-live.mjs      # 真调 Breeze + 假设备：量起播后的"缓冲领先量"，证明不卡顿（需 key）
```

> 一条命令：`npm test`（不含两个"真调 Breeze"的 smoke，那俩要 key 且会出网）。
> 不要用 `node --test`：它给每个文件派生子进程，受限环境下会 `spawn EPERM`。

### 音频编码（2026-11-03）

默认 `audioCodec=auto`：设备 hello 里带 `codecs:["pcm","opus"]` 才走 Opus（ffmpeg/libopus 编码，
每 WS 帧一个 20ms 裸包）；否则/编码失败显式回退 PCM。档位由 `audio_profile.js` 按 pong 的
`bufMs/underruns` 自适应（24k/16k/8k→PCM），状态在 `/api/diag.audio`，理由可读。
强制回退：`POST /api/config {"audioCodec":"pcm"}`。

> 注：DeepSeek TTS 段固定 PCM 24k 直通（见上节），不参与这里的 opus/adpcm 协商——
> 协商快照只影响本地引擎（edge/sapi/breeze）的编码路径。

### TTS 端点参数（Breeze 回退路径，2026-10-31 实测）

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

例外：`deepseekApiKey` / `breezeApiKey` 还可以走环境变量（`DEEPSEEK_API_KEY` / `BREEZE_API_KEY`），
`deepseekBaseUrl` 可走 `DEEPSEEK_BASE_URL`——排障时用环境变量临时换 key/base 不必改 patch。
