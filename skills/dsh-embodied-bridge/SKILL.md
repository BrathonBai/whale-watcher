---
name: dsh-embodied-bridge
description: "把「鲸鲸」具身设备接进 DSH：安装 dsh-embodied-bridge 插件、配置 TTS 音色与 ASR、编译刷写 ESP32-S3 固件、验证链路。当用户说要在新机器上装这套设备、要接入/重装/排障具身桥、要改音色、要刷固件、或问『设备怎么连到 DSH』时使用。安装时必须先问清楚 TTS 引擎和音色（breeze 要 API Key + Voice ID），不要替用户猜。"
---

# dsh-embodied-bridge：安装与配置

一套「设备 ⇄ DSH 大脑」的最小可用链路：

```
ESP32-S3（鲸鲸） ── WiFi/WebSocket ──▶ DSH 插件（桥）──▶ DSH 会话 / LLM
     ▲ 麦克风、喇叭、240×240 相机                │
     └────────── 音频下行（PCM）+ say/face/shot ─┘
```

发布包里有两个目录 + 两个脚本：`firmware/`（设备固件）、`bridge/`（DSH 插件）、
`install/install-bridge.ps1`、`install/flash-firmware.ps1`。

## 铁律

1. **凭据只在本机**：API Key、Voice ID、WiFi 密码只写 `~/.dsh/plugins-data/embodied-bridge/config.json`
   和 `firmware/main/wifi_local.h`。绝不写进仓库、不写进发布包、不回显到对话或日志里。
2. **装完必须完整重启 DSH**：插件是 ESM，热重载不会重新加载；patch 层只在启动时解析。
   不要替用户重启，让他自己重启。
3. **配置三层，后者覆盖前者**：`lib/config.js` DEFAULTS ← `plugins-data/.../config.json` ←
   `profiles/<名字>/cordis.patch.yml`。改了没生效，先看 `/health` 的 `config`（那是运行时真值），
   再看是不是 patch 层把它压回去了。
4. **固件构建目录必须纯 ASCII**：中文路径会让 ESP-IDF 的 kconfig 生成失败。

## 一、装桥（先问 TTS，别猜）

跑 `install/install-bridge.ps1`（交互式），它会按顺序问：

1. **TTS 引擎**（这一步必须问用户，不能替他选）
   - `breeze`：云端、音色最好。要 **API Key** + **Voice ID**（形如 `voc_xxxxxxxx`）+ 模型（默认 `breeze-tts-2`）；
     国内常需代理（如 `http://127.0.0.1:7897`）。
   - `edge`：微软在线 TTS，要 Python + `ffmpeg`，音色名如 `zh-CN-XiaoxiaoNeural`。
   - `sapi`：Windows 自带，离线、秒出、机器味，适合先跑通。
   - `off`：只显示不出声。
2. ASR：`server`（sherpa-onnx 常驻，推荐）/ `auto` / `off`。选 server 要 Python + `asr_server.py` + 模型目录。
3. 大脑：`session`（设备有独立 DSH 会话，能共用工具）/ `llm`（插件自己调模型，更轻）。
4. 端口（默认 7788）、回复字数上限。

脚本会把配置写到 `~/.dsh/plugins-data/embodied-bridge/config.json`，面板令牌自动生成。

**如果用户没给 Voice ID**：明确告诉他"现在会没有声音（`/health` 里 `tts.configured=false`）"，
并给两条路：① 去 Breeze 控制台拿 Voice ID 重跑脚本；② 先用 `sapi` 跑通链路，音色之后再换。

## 二、刷固件

跑 `install/flash-firmware.ps1`，它会问 WiFi SSID/密码和"跑 DSH 的那台电脑的局域网 IP"，
然后生成 `main/wifi_local.h`、`idf.py build`、`esptool write_flash 0xe00000`（921600 波特率）。

前置：ESP-IDF 5.5（默认 `C:\Espressif\v5.5\esp-idf`）、`esptool`（IDF 自带 python 里有）。
设备插 USB 后是 `COMx`，刷写用 921600，看日志用 115200。

## 三、验证（必须逐条过，不要只说"应该好了"）

```
1) 桥启动日志：工具 6 个 + 面板令牌 + 监听 ws://0.0.0.0:7788/device
2) GET  /health      → ver=2、device.online=true、fw=hub_v2、ver="0.2"、tts.configured=true
3) GET  /panel       → 412×412 面板，能点 /say、/shot
4) POST /say         → 设备念出来，日志有 `TTS 流式 N B（… ms），预缓冲 ~1000 ms`
5) 按键说话          → 桥收到 voice 上行 → 落 WAV → ASR → 回复 → 出声
6) POST /shot        → 240×240 JPEG，约 0.3 s，落在 plugins-data/.../workspace/images/
7) POST /api/linktest?seconds=3 → 量链路带宽（见 docs/troubleshooting §12）
```

## 四、排障入口

`docs/troubleshooting-2026-10-31.md` 是踩坑合集，按症状查：

| 症状 | 看哪节 |
| --- | --- |
| 改了配置没生效 / 声音变回测试男声 | §1 配置优先级 |
| 没声音 / 404 Voice not found | §2 Breeze 参数（`output_format` 只能是 `wav`/`mp3`/`pcm`） |
| 满耳噪声、爆音 | §10 PCM 奇数字节错位 |
| 开头正常、越说越赶不上 | §11 预缓冲 + §12 链路带宽 |
| 设备反复重启、旋钮一碰就崩 | §4 / §6 |
| 按键没反应 | §7 |

## 五、已知边界（别向用户承诺能力之外的事）

- 设备**不能**被远程触发录音：录音只能按设备上的物理按键（v2 没有 `record`/`mic` 下行）。
- 设备**不上报**电量/表情/旋钮数值/环境声，也没有文本上行通道（按键录音走 `voice`）。
- 24 kHz/16 bit 单声道 PCM 需要 **48 KB/s** 链路；WiFi 实际只有 20–30 KB/s 时，长句会卡——
  这是已知问题，修法是降码率或上 Opus，不要在设备侧"加大缓存"糊弄。
- 一段 12 s 音频约 576 KB，落盘保留策略：图片 20 张、语音 50 段。

## 六、改代码时

- `bridge/lib/contract.js` 是**唯一契约源**：上行 4 种、下行 7 种、不具备 8 种（带原因）。
  改完跑 `node tools/gen-contract-doc.mjs` 重新生成 `docs/protocol-v2-contract.md`，
  `node test/contract.test.mjs` 会比对，不一致就红。
- 测试不要用 `node --test`（会 `spawn EPERM`），逐个跑：
  `node test/protocol.test.mjs` / `ws` / `speech` / `retention` / `contract` / `session.mjs` / `loop.mjs` / `audit.mjs`。
- 只读副本与运行态的边界见发布包 `bridge/README.md`。
