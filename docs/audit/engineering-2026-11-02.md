# 工程面审计（Lead 自审）：运行态、配置、安全、可维护性

> 日期：2026-11-02 · 审计者：lead
> 范围：**运行态**桥 `%USERPROFILE%\.dsh\plugins\dsh-embodied-bridge`（v0.3，11-01 改动后）、
> 工作区结构、构建/脚本环境、配置分层与线上接口实测。
> 固件 / 桥代码的逐行审计见同目录 `firmware-2026-11-02.md`、`bridge-2026-11-02.md`、
> `persona-aux-2026-11-02.md`；本文件只收**跨层、运行态、环境、流程**问题。

## 0. 审计基线与环境事实（实测）

| 项 | 实测 | 影响 |
|---|---|---|
| 运行态桥 | `http://127.0.0.1:7788` 200，uptime 有值，`device.online=false` | 桥活着；设备当前不在线 |
| bridge 版本 | `package.json` 0.3.0；lib 19 模块 / test 11 / tools 1 | v0.3 + 11-01 的 `voicecache.js`、`brain.js`、`speech.js` 改动 |
| 工作区 `bridge/` 副本 | `sync-mirror.ps1 -Verify`：**2 changed / 2 only-in-source**（`brain.js` `speech.js` 不同；源里多 `voicecache.js`、`brain.js.bak-20261101`） | 副本已漂移，按副本读会读到旧逻辑 |
| 工作区 `firmware/` 副本 | `-Verify`：`firmware: 64 files, mirror == source` | v1 镜像同步；**不是** v2（v2 在 `firmware-v2/`） |
| `firmware-v2/main` ↔ `%LOCALAPPDATA%\hubdev\v2\main` | 逐文件哈希一致；源码最新 mtime 5:28:49，`hub_v2.bin` 5:29:46 | 构建副本与源码同步，bin 比源码新，无"改了没编"漂移 |
| Node | v22.14.0 | 桥测试可跑 |
| Shell | **Windows PowerShell 5.1**（`pwsh` 不存在；`$PSVersionTable` 未测但 `Get-Content` 默认按 ANSI 解码） | 读 UTF-8 中文文件/日志会显示乱码；判断编码要用 node/read 工具 |
| ExecutionPolicy | `CurrentUser = RemoteSigned` | 未签名的 `tools\*.ps1`、`build.ps1` **直接运行会被拒绝**（实测） |
| 版本控制 | 工作区、`..\embodied-watcher\`、两个插件目录都**没有 `.git`** | 无回滚点；迭代风险 |
| ESP-IDF | `C:\Espressif\v5.5\esp-idf\export.ps1` 存在 | 固件可编译（路径需 ASCII，见下） |

## 1. 缺陷表

### E-01 P0 · 没有任何版本控制，迭代无回滚点
- 证据：工作区、`%USERPROFILE%\.dsh\plugins\dsh-embodied-bridge`、`dsh-persona`、`..\embodied-watcher` 均无 `.git`；
  工作区只有 `.mirror.json`（SHA-256 清单，不是版本库）；`firmware-v2/main/.gitignore` 写了 `wifi_local.h`，
  但没有 git 时它**不生效**。
- 影响：任何一次改坏都无法 `git diff` / `git checkout`；现在"迭代"等于裸改。
- 建议：立刻在**代码子集**上建库（不要把 382 MB 的 `鲸鲸.zip`、`reference/`、`dist/`、`build/` 纳入），
  每轮迭代一个 commit；或至少每轮前打 zip 快照到 `_archive/`。

### E-02 P1 · 镜像副本已漂移，而文档仍宣称"逐文件一致"
- 证据：`tools\sync-mirror.ps1 -Verify` 输出 `[DRIFT] bridge: 2 changed / 2 only-in-source`；
  `MIRROR.md` 第 13 行仍写 "26 文件（lib 15 / test 7 / tools 1 / 根 3）"，实际 31 文件（lib 19 / test 11）。
- 影响：按 README 的阅读顺序读 `bridge/` 会读到旧版 `brain.js`/`speech.js`，缺 `voicecache.js`。
- 建议：跑一次 `sync-mirror.ps1`，同步更新 `MIRROR.md` 与根 `README.md` §3 的数字；新增自动校验（见 E-04）。

### E-03 P1 · 同一套协议存在三个"事实源"，已经互相矛盾
- 证据：
  - 固件 `firmware-v2/main/proto.h:27-29`：`kFwVersion="0.8"`、`kProtocolVersion=1`、
    `Downlink` 含 `Record/Mic/Play/Stop`（`proto.h:61-64`）。
  - 固件 `app_ui.cc:130` 实际发的是硬编码 `{"t":"hello","fw":"hub_v2",...,"ver":"0.2",...}`，
    **没有用** `BuildHello`；`app_ui.cc:289-300` 实际处理 `Play/Stop`。
  - 桥 `lib/contract.js:42-50`：下行只有 7 种，**没有 `play`/`stop`**；`device.send()` 会直接拒绝。
- 影响：① 固件已实现的本地 MP3 播放（`mp3_player.cc` + `play/stop` 下行）在桥上**永远发不出去**，
  是"写了但空转"；② `proto.h` 的版本常量与线上 hello 不一致，谁再引用 `BuildHello` 就会报错身份；
  ③ 契约文档 `docs/协议-v2-契约.md` 因此也不完整。
- 建议：二选一，别悬着——(a) 把 `play/stop` 纳入 contract 与 `/api/play`（对齐 TODO P1-4），
  并清理 `proto.h` 的 v1 残留（Record/Mic、0.8/1）；或 (b) 删除固件侧 `play/stop` 与 `mp3_player` 调用链。
  推荐 (a)，因为功能已存在且 TODO 本来就要做。

### E-04 P1 · 配置分层静默覆盖（实测仍在发生）
- 证据：`plugins-data/embodied-bridge/config.json` 里 `"maxReplyChars": 60`，
  但 `GET /health` 返回 `maxReplyChars: 240`——被插件自带 `cordis.patch.yml:19` 的 `maxReplyChars: 240` 覆盖。
  启动日志（`%LOCALAPPDATA%\hubdev\bridge.log`）只打路径与存储统计，**不打印任何配置项的有效值与来源层**。
- 影响：用户改 `config.json` 不生效且无提示（TODO P4-1 描述的正是这个坑，至今未修）。
- 建议：启动时逐项打印 `key=value（来源：patch|file|default）`；`/api/config` 写入后回读并提示被 patch 覆盖；
  插件 patch 只保留 `host/port/brain` 这类"接线"值，行为值交给 `config.json`（或反过来，但要可见）。

### E-05 P1 · `imageKeep: 0` 让"拍照"功能实际报废（实测证据）
- 证据：`config.json` `"imageKeep": 0`；`retention.js:20-53` 对 `keep<=0` 的语义是**全删**；
  `index.js:172` 在 `saveImage()` 里先写盘、再 `pruneDir(..., imageKeep)`。
  11-01 的运行日志逐条写着：`图片已保存 …` 紧接 `图片清理：删 1 张（保留 0，释放 … KB）`。
- 影响：`device_shot` 返回的 `path` 指向**已被删除的文件**；把图片路径交给模型/会话时必然读不到；
  `/shot.jpg` 永远 404。拍照链路"看起来成功、实际空转"。
- 建议：最新一张无条件保留（`keep = Math.max(1, imageKeep)`），或把最后一张留在内存/临时目录；
  同时 `imageKeep: 0` 的语义应改成"不积累历史"，不是"不保留当前"。

### E-06 P1 · 动作类 HTTP 接口可被任意网页 CSRF 驱动（本地）
- 证据（实测）：
  - `GET http://127.0.0.1:7788/say?text=csrf-probe` → 200，执行 `device.say`（设备离线时才 `sent:false`）；
  - `POST /api/face` 用 `Content-Type: text/plain` 发 JSON → 200，`readBody()+JSON.parse` **不看 Content-Type**；
  - `http.js:39-50` 的 `authorized()` 只按 `remoteAddress` 判本机，**不校验 Origin/Referer**；
  - 动作路由同时接受 GET（`pick()` 读 query）。
- 影响：用户浏览任意网页时，`<img src="http://127.0.0.1:7788/say?text=...">` 就能让设备念任意文本；
  fetch + `text/plain` 可 POST `/api/config` 持久化改配置（如 `systemPrompt`、`logFile`）。
- 建议：动作类只允许 POST；带 `Origin` 且非本机来源直接 403；`/api/config` 增加字段白名单。
  只读接口的 `access-control-allow-origin: *` 也应收紧（见 E-07）。

### E-07 P2 · 只读接口对局域网/任意网页开放，且无设备侧鉴权
- 证据：`http.js:128-176` 的 `/health /api/state /events /commands /moods /panel /shot.jpg` 不校验来源，
  JSON 响应带 `ACAO: *`；`index.js:447` 监听 `0.0.0.0`；
  `/device` WS 由 `device.handleUpgrade` 直接接受，**没有任何 token/来源校验**（`device.js:203-234`）。
- 影响：同网段任意主机可读设备状态/事件、冒充设备连接（顶掉真设备）、给桥喂伪造图像/语音；
  任意网页可读 `/api/state`（配置已打码，但仍含 systemPrompt、会话 id）。
- 建议：至少给 WS 加共享 token（设备与桥同配置）；只读路由默认仅 loopback，或同样要求 token。

### E-08 P2 · 设备在线判定没有 pong 超时，断线会"假在线"
- 证据：`index.js:470-473` 每 25 s 发 `ping`；`device.js:182-184` 不记录 pong、无超时；
  `online` 只取决于 TCP `conn.alive`（`device.js:121-123`）。
- 影响：设备死机/掉电/网络黑洞时，桥在 TCP 超时前一直报 online=true，工具调用"发出去没人收"；
  交接文档 §4#3 的"online 误报"根因即此。
- 建议：记录 `lastPongAt`，超过 `2×heartbeat` 判离线并记一条事件；`/api/state` 暴露 `lastPongAgeMs`。

### E-09 P2 · 文档里的常用命令在默认环境下跑不起来
- 证据：`Get-ExecutionPolicy` → `RemoteSigned`；实测 `.\tools\sync-mirror.ps1 -Verify` 直接报
  "未对文件进行数字签名"；`README.md` §5 与 `MIRROR.md` §5 都写的是直接运行。
- 影响：第一次接手的人会以为脚本坏了；`build.ps1` 同理（未实测，但同为未签名 .ps1）。
- 建议：脚本首行加说明，文档统一改成
  `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sync-mirror.ps1`；
  或对文件做 `Unblock-File` 并在 README 写一次。

### E-10 P2 · 观测/诊断仍缺两块（TODO P4-3 已做一半、P4-4 未做）
- 证据：`index.js:99-107` 已实现 `logFile`（默认 `%LOCALAPPDATA%\hubdev\bridge.log`），文件存在且 1.5 MB；
  但轮转只在**启动时**检查 8 MB（运行中可无限增长），且全文件只有一个 `.1`。
  `/api/diag` 实测 **404**；`/api/config` GET 实测 **400**（只支持 POST，不能读回）。
- 影响：出问题时仍要串口/日志拼图；TODO 里"一个 URL 定位问题"的验收未达成。
- 建议：先补 `/api/diag`（聚合 device 计数、tts/asr 最近错误、最近 10 条下行、链路自测结果），
  再做日志按大小滚动；`/api/config` 支持 GET 返回 `{config, sources}`。

### E-11 P2 · 固件 v2 没有主机单测，协议回归靠刷机
- 证据：`firmware/host/` 只覆盖 v1 的 `proto.cc/ws/text/sound`；`firmware-v2/` 无 host 目录，
  `main/proto.cc` 改坏只能上板发现。
- 影响：契约调整（如 E-03 的 play/stop）没有快速回归手段。
- 建议：把 `proto.cc`/`ws_frame.cc` 拉进一个最小 host 测试工程（它们不依赖 esp_* 头，
  `proto.h` 注释也这么写），先覆盖 Parse/Build 的边界用例。

### E-12 P3 · 仓库卫生：凭据与大文件
- 证据：`firmware-v2/main/wifi_local.h` 含**真实 SSID 与密码**（142 B，`.gitignore` 里有它但无 git 不生效）；
  `snapshot-2026-10-31_鲸鲸v2/firmware/main/wifi_local.h` 是同一份；`鲸鲸.zip` 382 MB 在根目录；
  `firmware-v2/build`、`components/lvgl`、`managed_components` 共 1600+ 文件在树里。
- 影响：一旦工作区被打包/分享/上传，凭据直接外泄；大文件拖慢任何扫描。
- 建议：建 git 时用严格 `.gitignore`（见 E-01）；把 `wifi_local.h` 移到构建目录生成（v1 `build.ps1` 已有此做法），
  源码树只留 `wifi_local.h.example`；`鲸鲸.zip` 移到 `_archive/` 或工作区外。

### E-13 P3 · 桥日志同步写盘，落在消息处理路径上
- 证据：`index.js:43-56` 每条日志 `fs.appendFileSync`；图片/语音上行每条都会写。
- 影响：正常量级（9 fps 上限已取消）影响小；但语音逐块调试日志开满时会阻塞事件循环。
- 建议：至少把高频繁殖（逐帧日志）改缓冲/采样，或仅在 `HUB_AUDIO_PROBE` 类开关下写。

## 2. 实测记录（可复现）

```powershell
# 只读探测（设备离线时安全）
Invoke-WebRequest http://127.0.0.1:7788/health
Invoke-WebRequest http://127.0.0.1:7788/api/diag        # 404
Invoke-WebRequest http://127.0.0.1:7788/listen          # 501 + UNSUPPORTED
Invoke-WebRequest 'http://127.0.0.1:7788/say?text=csrf-probe'   # 200，动作被执行
Invoke-WebRequest http://127.0.0.1:7788/api/config      # 400（只能 POST）
# 镜像漂移
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sync-mirror.ps1 -Verify
# 配置覆盖
(Invoke-RestMethod http://127.0.0.1:7788/health).config.maxReplyChars   # 240，而 config.json 是 60
```

## 3. 给"迭代"的排序建议（跨层）

1. **先止血**：E-05（拍照空转）、E-06（CSRF）、E-01（版本控制）。
2. **再统一契约**：E-03（play/stop + proto.h 清理）→ 桥补 `/api/play`、工具、契约文档重生成。
3. **可观测**：E-04（配置来源可见）+ E-08（pong 超时）+ E-10（/api/diag）。
4. **工程化**：E-02/E-09/E-11/E-12。

> 说明：以上每条都有代码行或实测输出支撑；没有"感觉可能"的条目。
> 与固件/桥逐行审计重叠的部分（如相机缓冲、speak 状态机）以那两份为准，本文件不重复。
