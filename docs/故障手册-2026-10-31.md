# 故障手册（2026-10-31 夜 · 鲸鲸项目）

## 1. 配置优先级（最容易踩的坑）

```
config = merge( merge(DEFAULTS, plugins-data/embodied-bridge/config.json),
                ~/.dsh/profiles/desktop/cordis.patch.yml )   ← 最高优先级
```

**规则：音色 / API key / ttsEngine 只改 `cordis.patch.yml`。**
改 `config.json` 会被 patch 层静默覆盖（表现为"改了没反应、重启后回退"）。
面板保存写入 config.json，同样会被 patch 覆盖。

## 2. Breeze TTS 401 / 404（音色不对，或干脆没声）

> **2026-10-31 12:0x 重新实测，结论已更新**：旧的"必须把 `breezeStream` 改成 false"**作废**。

两个历史原因（都已修）：

1. `cordis.patch.yml` 里存的是**失效的旧 key**，而 config.json 是新 key → 桥用旧 key 报 401
2. `speech.js synthOne()` 里 `breeze` 失败会**静默降级到 Edge**（默认 `zh-CN-XiaoyiNeural`），
   于是"故障"表现成"音色不对"，日志里一切正常 → 已移除该降级（v0.3 起失败即失败）
3. ~~`breezeStream: true` 走 `/stream` 返 401 → 改 false~~
   **作废**：现在 `/stream?output_format=pcm` 返回 200，`breezeStream: true` 是**正确配置**。

### 2.1 新坑：`output_format` 写错会被误报成"找不到音色"

```
POST /v1/text-to-speech/{voice}?output_format=wav_24000&delivery=sync
→ 404 {"code":"RESOURCE_NOT_FOUND","detail":"Voice not found."}   ← 音色其实存在！
```

`output_format` 只接受 **`wav` / `mp3` / `pcm`**（stream 端点同样只有这三种；
写 `pcm_24000` 会 400 "Unsupported output_format"）。实测正确的组合：

| 用途 | URL | 结果 |
|---|---|---|
| 整段（WAV 头，24 kHz/mono/16 bit） | `/v1/text-to-speech/{voice}?output_format=wav` | 200，`RIFF…WAVE`，`rate=24000` |
| 流式裸 PCM（设备直接吃） | `/v1/text-to-speech/{voice}/stream?output_format=pcm` | 200，首包约 1.3 s |
| 不带参数 | `/v1/text-to-speech/{voice}` 或 `…/stream` | 200，但格式未声明，别依赖 |

对应代码：`bridge/lib/tts_breeze.js` 的 `synthesizeBreeze`（旧代码写死 `wav_24000`，已改）。

### 2.2 代理到底必需吗

同一时刻实测：**带代理**与**直连**都能到达 API（返回的是同一个 API 级错误），
所以"直连必超时"在当前网络下不成立。但保留 `breezeProxy: http://127.0.0.1:7897`
没有坏处（换网/机房可能不同）；桥的逻辑是"配了代理就直接走 curl，不白等直连超时"。

**排查命令（直连验证 key/音色/格式是否有效）：**
```powershell
curl.exe -sS -x http://127.0.0.1:7897 `
  -H "xi-api-key: <KEY>" -H 'content-type: application/json' `
  --data-binary '@body.json' `
  "https://api.breeze.blue/v1/text-to-speech/<VOICE>?output_format=wav" -o out.wav
# 期望：out.wav 头是 RIFF…WAVE，采样率 24000
```
音色列表：`GET https://api.breeze.blue/v1/voices`

**别再靠"听声音"判断有没有修好**：`bridge/test/tts-smoke.mjs` 会真起桥、真连假设备、
真数设备收到的 PCM 字节数。`/say` 回 ok、日志也打了 TTS 字节数、但设备侧 0 字节，
这种假成功只有它能抓住。

> 写这个冒烟时踩过一次：Node 的 `WebSocket` 默认把二进制帧投递成 **Blob**，
> 顺手写 `e.data.byteLength` 会得到 `undefined` → 计数为 0，看起来像"桥没发音频"。
> 假设备必须设 `ws.binaryType = 'arraybuffer'` 再数 `byteLength`。
> 这次是测试端的错，桥当时发得是对的——记在这里免得下次误判成固件/桥的 bug。

## 3. Windows 上 spawn('curl.exe') 不可靠

`child_process.spawn` 不经过 shell，PATH 未命中会**立刻 reject**（表现为 0.5 秒内回落）。
必须用绝对路径：`C:\Windows\System32\curl.exe`。

## 4. 设备反复重启（收到下行文本就 panic）

`ws` 任务栈仅 5 KB，而文本回调在栈上放了 `Downlink`(~1.1KB) + `buf[560]` + `s[768]` → 栈溢出。
**修法：这些缓冲全部改 `static`。**

## 5. 音频帧全丢（桥发了、设备收不到）

`ws_client.cc`：
```cpp
if (have == kReadBuf) { SetError("rx overflow"); break; }   // ← 致命
```
桥会一次性灌入几十个 4 KB 帧，8192 缓冲填满时**还没解析就断连**。
**修法：`kReadBuf = 32768`；缓冲满只作为"解析无进展"的诊断，不直接断连。**

## 6. 旋钮一转就崩

GPIO 正交编码的 ISR 里直接调回调，而回调做 I2C/刷屏/日志 → 必崩。
**修法：ISR 只累加计数，回调在 `KeyTask` 里派发。**

## 7. 按键无反应

`bsp_io_expander_init()` 没人调用（删掉 `bsp_lvgl_init` 时连带丢了），
`io_exp_handle == NULL` → `bsp_exp_io_get_level()` 恒返回 0。
**修法：启动时显式调用 `bsp_io_expander_init()`。**

## 8. WiFi 一直 reason 201（扫不到 AP）

`net_wifi` 优先读 NVS，编译期默认 SSID 是废的。
**修法：启动时 `net::SaveCredentials(SSID, PASS)` 覆盖 NVS。**

## 9. TTS 播放策略（学小智）

- 不裸 PCM 一次性发（5 秒 = 255 KB），按句切分 / 小帧下发
- 设备侧**攒够 1 秒即播**，不等 `audio_end`，避免长句白等
- 长期方向：Opus 编码（体积降 10 倍）

## 10. 设备放出来全是噪音（PCM 帧奇数字节导致错位）

**症状**：`/say` 正常、日志 `TTS 流式 N B` 正常、设备也出声，但**满耳噪声/爆音**。

**根因**：Breeze 流式 PCM 是按 curl 收到的原始分块往下发的，分块长度任意。
实测一次 121 块里 **72 块是奇数字节**（还夹着 27 B 的碎片）。
设备端用 `(const int16_t*)p` + `n / 2` 取采样，**奇数帧最后一个字节被丢掉，
之后所有采样整体错位一个字节**。

**定量证据**（同一段真实 PCM，仅改变切块方式）：

| | RMS | 过零率 | >4 kHz 能量占比 | 峰值幅值 | 与正确波形相关系数 |
|---|---|---|---|---|---|
| 正确对齐 | 2 753 | 0.108 | 26.8% | 13 969 | — |
| 每块丢尾字节 | 11 982 | 0.226 | **63.3%** | **32 768（削顶）** | **0.088** |

**修法**（两层）：
1. 桥侧 `speech.js` 的 `makeEvenSink()`：用 carry 把奇字节留到下一帧，
   保证每帧**偶数字节且 ≤16 KB**（固件 `kMaxBinaryPayload`）；
2. 固件侧 `app_ui.cc` 的二进制回调：`if (n & 1) --n;` 并只告警一次（防御，不改听感）。

**回归测试**：`test/speech.test.mjs`（汇聚器只发偶数帧）+ `test/tts-smoke.mjs`
（真调 API，**逐帧**校验奇偶与长度）。
教训：只数"设备收到多少字节"不够——总字节对、但分帧错位时，声音依然是噪声。

## 11. 声音没噪音但"卡顿"（流式供给断粮，不是环形缓存小）

**症状**：噪音修好之后，声音是干净的，但开头一小段一顿一顿（"有点卡顿"）。

**先排除**：设备侧环形缓存是 **12 s**（`kRingSamples = 24000 × 12`，PSRAM ≈ 960 KB），
`AudioTask` 每 20 ms 取 480 采样，**容量根本不是瓶颈**——它从来没被填满过。

**根因**：Breeze 流式**首包晚 + 前段脉冲式到达**，桥拿到一块就往设备推，
设备一收到 `audio` 头就开播：先播完 120 ms 头静音，然后空转等下一块。

**实测节奏**（同一句话）：

| 指标 | 值 |
| --- | --- |
| 首块到达 | 1117 ms，只带 80 ms 音频 |
| 起播瞬间领先量 | **−1038 ms**（缓冲空） |
| 单块最大间隔 | 393 ms（其余 274 / 268 / 183 / 166 ms） |
| 平均每块 / 间隔 | 27 ms 音频 / 13 ms |
| 平均速率 | 260 块、6.3 s 音频在 3.3 s 内到齐（≈2 倍实时，但**前 1.1 s 是 0**） |

**修法**：`speech.js` 的 `makePrebufferGate()`——先攒够 `ttsPreBufferMs`（默认 1000 ms）
再发 `audio` 头 + 首批，`onStart` 保证头在第一个二进制帧之前；短句不足时 `start()` 兜底。

**效果**（两次实测：直接量 API 节奏 + 经桥的假设备）：首帧 **1241–1355 ms**，
起播时领先 **1012–1072 ms**（日志会打 `预缓冲 N ms`）；起播后最小领先 **896–925 ms**，
块间隔最大 230–574 ms 也仍被缓冲吸收；结束时领先约 3.9 s。代价：开口晚约 0.2 s。

**回归测试**：`test/speech.test.mjs` 的 5 条预缓冲用例（未攒够不发 / 攒够一次发 /
直通 / 短句兜底 / `onStart` 放弃）+ `test/prebuf-live.mjs`（真调 Breeze、假设备，
按 5 ms 栅格算"那一刻缓冲里还剩多少毫秒"，断言最小领先 ≥ 400 ms）。
教训："加大设备缓存"是错的解法——数据还没生成出来，缓存再大也变不出来；要控的是**供给起播点**。

## 12. 越说越赶不上（链路只有 ~25 KB/s，而 PCM 要 48 KB/s）

**症状**：开头一两秒正常，之后开始一顿一顿；越长的句子越明显（"说快点，赶在卡顿之前说完"）。
§11 的预缓冲已生效（起播领先 1 s），但放到中段还是会断。

**先把三个嫌疑人逐个排除**（2026-10-31 现场数据）：

| 嫌疑人 | 测法 | 结论 |
| --- | --- | --- |
| 设备 CPU / 入队慢 | 固件探针：每帧记 `入队 us` | **274 帧合计 34 ms（0.12 ms/帧）** → 设备不慢 |
| 桥 / Breeze 生成慢 | 同代码在本机跑假设备 | 3.5–5 s 音频 **2.5–2.8 s** 到齐（1.6–2 倍实时）→ 生成不慢 |
| 链路 | 设备侧逐帧时间戳 | **帧间隔 200 / 400 / 800 / 1600 ms 阶梯**，缓冲反复掉到 0 采样 |

需求是 24 kHz × 16 bit × 单声道 = **48 KB/s**；实测到达 **21–28 KB/s**（0.45–0.6 倍实时）。
帧间隔成倍递增 + 突发成簇，是 TCP **丢包后 RTO 退避**的典型形状，不是"设备算不过来"。

**已经做过的**：任务优先级理顺（渲染不能抢实时）——UI 6→4、WS 5→6、音频 5→7。
效果：同一段音频 `audio头→audio_end` 从 **13.9 s 降到 7.6–9.8 s**（约 +40%），但仍然不够。

**怎么量链路**（新增端点，不经过 TTS）：

```powershell
# 灌 3 秒静音，返回写了多少字节/多久；到达耗时看设备串口
Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/linktest?seconds=3' -Method Post
```

串口里 `音频头` → `音频收尾` 的时间差 ÷ 灌入秒数 = **链路倍速**：

- ≥ 1.3 → 链路够用，卡顿另有原因（回去看 §11 的供给节奏）
- 0.5–1.0 → 就是这里：PCM 塞不下，必须降码率或改编码

**优化菜单**（按性价比）

| 方案 | 带宽 | 代价 | 说明 |
| --- | --- | --- | --- |
| 桥侧合并 4 KB 帧 + 1.2× 实时节奏 | 不变 | 小 | 少发小包、别一次灌满 32 KB 窗口，减少丢包/重传 |
| WiFi 缓冲加大：`STATIC_RX 10→16`、`DYNAMIC_RX 32→64`、`RX_BA_WIN 6→16` | 略增 | 小 | 突发更容易被吸收 |
| 采样率 24 k → 16 k | **32 KB/s** | 中（音质变闷） | 仍偏紧，只能算缓解 |
| **Opus 编码（16–24 kbps）** | **2–3 KB/s** | 大（设备要解码器） | 治本；12 s 音频从 576 KB 降到 ~36 KB |

**教训**：先分清"供给慢"还是"管道窄"再动手。这次靠三样证据（设备入队耗时、本机对照、
逐帧间隔形状）才把责任从设备挪到链路——只盯着"收到多少字节"永远分不清。
