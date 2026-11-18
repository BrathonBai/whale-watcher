# 具身 Agent · 工作区地图

> **先读这一页，再进 `docs/`。**
> 这个工作区是**大脑侧**：设计文档、界面资产、参考实现、路演物料。
> **设备固件和桥不在这里**——它们在隔壁工作区和 DSH 插件目录，见 §3。
> 核对时间：2026-10-30 17:25。

> **2026-11-13 大改：鲸鲸通过 BLE 直连手机 dsh-Go（不再必须连 PC）**
>
> 设计与协议（唯一事实源）：[`docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md`](docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md)
> 交付报告（做了什么/验证到哪/还剩什么）：[`docs/蓝牙直连dsh-go-交付报告-2026-11-13.md`](docs/蓝牙直连dsh-go-交付报告-2026-11-13.md)
> 手机端覆盖集与操作手册：[`dsh-go-ble/`](dsh-go-ble/README.md)
>
> 三块改动：设备固件 `firmware-v2/` 新增 BLE 传输层 + ADPCM（编译通过，**已刷真机并跑通主链路**）；
> 桥 `bridge/` 新增 ADPCM 上下行、`wsToken`、`discover` 开关（测试全绿）；
> 新增 `dsh-go-ble/` —— dsh-Go 的覆盖集补丁（BLE 网关前台服务 + guest 插件注入 + 设置页），
> **已在本机装 Flutter 编译并在 Pixel 6 真机跑通**（analyze 0 error；APK 装成独立包
> `…dsh_app.blelab`，与官方 1.0.15 并存）。
> 老的 WiFi/PC 链路保持可用（设备 `>link wifi`，桥默认行为不变）。
>
> **2026-11-13 晚真机结果**：Watcher + Pixel 6 已跑通 广播→连接→MTU 247→CCCD→hello(0.3)→
> pong→ADPCM 下行→`shot` 回 2836 B JPEG（TX 分帧重组正确）；真机修掉 BLE+WiFi 同开 OOM、
> 无卡 mp3 占内部 RAM、订阅前 hello 丢失三个问题。
>
> **同晚 App 真机结果**：Flutter 3.47.7 编译 dsh-Go 1.0.16 覆盖集 → 装 Pixel 6 → 设置里开
> 「鲸鲸蓝牙」→ BLE 自动连接（MTU 247/PHY 2M/CCCD）→ 手机 PRoot 引擎里的桥 `device.online=true`；
> 从桥触发 `/say`（设备出声）、`/shot`（设备拍照经 BLE 回传到桥）都成功。又修掉
> 3 个 App 侧真机 Bug（`onMtuChanged` 递归、MTU/发现顺序、早期 hello 丢）。
> **最终按用户确认收尾**：旧官方 1.0.15（无数据）已卸载，现在手机上是**官方包名
> `io.github.ccch1mneyyy.dsh_app` 的 1.0.16 debug 版**（带「鲸鲸蓝牙」+ DeepSeek 桥，versionCode 11132342），
> **23:25 固件 v0.4 已按用户要求移除 WiFi、只保留 BLE**：删掉 net_wifi/ws_client/ws_frame/
> bridge_find/nvs_creds/wifi_local，`link` 重写为单 BLE 门面，配网向导改为「蓝牙配对」；
> bin 6,505,872 B（sha256 `8ED62B…0D7B`），内部 free **119 KB**（原 34.7 KB），
> 刷机后 BLE/桥/`say`/`shot` 全部复验通过。
> **桥的 TTS/ASR 已切到 DeepSeek 官方 API**（`bridge/lib/deepseek.js`，`npm test` 107 条全绿；
> APK 已重建并把新桥注入手机 rootfs；真实 key 已配置到手机桥，**TTS 已真机出声**
> （设备串口：audio PCM 218,880 B 收齐 → audio_end → 播放完毕，lastEngine=deepseek）。
> 还差：设备 mic→桥 ASR 真机段（按设备键说话）、App 登录/模型 provider 的全对话；
> 以及 PC⇄手机会话互通（「远程主机」，非账号同步）。报告 §3.6/§3.7/§10。

---

## 1. 四类东西，一眼分清

| 类别 | 判据 | 目录 | 能不能改 |
|---|---|---|---|
| **① 当前项目** | 我们自己写的、现在还在用的设计/资产/物料 | `design/` `docs/` `路演/` | ✅ 可以改，改完更新本页 |
| **② 参考** | 别人写的、只读，用来对照和抄做法 | `reference/` | ❌ 只读。升级用 `git pull`，不提交本地改动 |
| **③ 历史** | 我们自己写过、已被取代，但还能跑/还有解释力 | `prototypes/` | 🟡 别修，只读来查"当初为什么这么做" |
| **④ 归档** | 证据与残骸：会话记录、已删代码、旧编译产物 | `_archive/` | ⛔ 不再引用，只在追查时翻 |

一句话记法：**`reference/` 是别人的，`prototypes/` 是过去的自己，`_archive/` 是证物。**

> 现行固件 `firmware-v2/` 就在本目录、**直接改**；只有 `bridge/` 属于①但是**只读副本**
> （源在 DSH 插件目录，放一份是为了"一个文件夹读全栈"）。**v1 固件已废弃**，历史副本在
> `_archive/firmware-v1-2026-11-02/`，只作证物，不要按它的逻辑改 v2 —— 见 [`MIRROR.md`](MIRROR.md)。

---

## 2. 现在的真实结构

```
具身Agent/
├── README.md                 ← 本页（索引与判据）
├── START-HERE.md             ← 状态日志，最新在前；§3 的树是 10-26 的历史快照
├── MIRROR.md                 ← `bridge/` 副本的来源、边界、刷新方式（v1 固件已废弃/已归档）
├── .mirror.json              ← 逐文件 SHA-256 清单（`tools\sync-mirror.ps1` 生成）
│
├── firmware-v2/              ← ① **现行固件唯一真源**（直接在源上改）
│   ├── main/                   38 个自有源文件：app_ui / proto / ws_client / audio / audio_dec(Opus) / camera / mp3 / render …
│   └── components/micro-opus/   vendored Opus 解码组件（0.4.1，随仓库提供，构建必需）
├── bridge/                   ← ① 当前项目·只读副本（源：`~\.dsh\plugins\dsh-embodied-bridge`）
│   ├── lib/                    21 个模块：index / device / ws / protocol / contract / brain / asr / speech / tts / opus_encode / audio_profile / tools / http / config / voicecache
│   └── test/                   14 个：protocol / ws / contract / session / loop / audit / retention / speech / speech-queue / opus …
├── tools/sync-mirror.ps1     ← 刷新并校验 `bridge/` 副本（`-Verify` 只比对不改动）
│
├── docs/                     ← ① 现行文档：设计 / 审查 / 进度 / 取证（索引见 docs/README.md）
├── design/                   ← ① 「虹膜」界面：生成器 + 9 态视觉稿 + 浏览器原型
│   ├── ui_mock.py              改数字即出图（4× 超采样）
│   ├── out/                    idle/listen/think/speak/… PNG + contact sheet + GIF
│   └── preview/                index.html 交互原型、sense.html 真摄像头/麦克风端
├── 路演/                      ← ① 交付物料：PPTX / PDF / 讲稿 / 评委 Q&A / 生成脚本
│
├── prototypes/               ← ③ 早期实现，四个都不再是主线
│   ├── cloud/                  最小感知 Agent（WS + 知觉状态机，8711 端口）
│   ├── embodied/               Seeed 工厂固件时代的视觉网关 + ota_stub
│   ├── mcp-bridge/             外挂 MCU 的 MCP 桥协议 + MicroPython 侧车
│   └── scripts/                dump / inspect / nvs / factory 工具
│
├── reference/                ← ② 第三方，只读（每个的来源与 commit 见 reference/README.md）
│   ├── watcher-sdk/            Seeed SenseCAP-Watcher-Firmware（Apache-2.0）
│   ├── watcher-osw/            Seeed OSHW 硬件仓库（含 3D 外壳、图纸）
│   ├── ai-passport/            FoloToy AI Passport 固件（ESP32-C3，MIT）
│   ├── muse-gadget-sdk/        Meta/Facebook muse-gadget-sdk（Apache-2.0）
│   ├── aurabot/                dsh-aurabot-qq v1.1.22（MIT）——桥 v0.2 的参照物
│   ├── dsh-src/                DSH 内部包源码抽取（dsh-tools / dsh-llm / host-webserver）
│   └── honestqiao-board/       HonestQiao 的 sensecap-watcher 板级实现（4 个源文件）
│
└── _archive/                 ← ④ 证物
    ├── session-59a8ff8c.*       上一轮 12 轮对话（raw.jsonl + 可读 transcript）
    ├── pixel_face-removed-20261030/  已从固件删除的像素脸（可回滚）
    ├── boot-first-firmware.log  首次刷机启动日志
    ├── build-stale-2026-10-28/  宿主编译产物（sim.exe 等），源码已迁去 embodied-watcher
    ├── scratch-2026-10-28/      解码散图 + hello.obj + office 渲染临时目录
    └── photo/                   开箱/拆机照片
```

---

## 3. 活代码在哪：三处源 + 本目录两份副本

| # | 是什么 | 源（唯一可改） | 本目录副本 | 现状 |
|---|---|---|---|---|
| 1 | **设备固件 v2**（ESP-IDF / ESP32-S3 / Watcher） | 本目录 `firmware-v2/` | 就是本体 | **现行唯一真源**；2026-11-03 落地 Opus 解码（PCM 环 576→120 KB）/ WiFi 锁 BSSID / core dump / 栈水位，编译通过（bin 4,946,432 B，未刷机；本轮**新增 coredump 分区，需刷分区表**） |
| 1b | 设备固件 v1（**已废弃**） | — | `_archive/firmware-v1-2026-11-02/`（只作证物） | 不要读、不要按它的逻辑改 v2 |
| 2 | **桥**（DSH 插件：设备 ⇄ 大脑） | `%USERPROFILE%\.dsh\plugins\dsh-embodied-bridge\` | `bridge/`（只读镜像） | v0.3 + 2026-11-03 Opus 编码/协商/自适应码率/诊断（38 文件；10 套件含 opus 26 例全绿）；已同步运行态，**重启 DSH 生效** |
| 3 | **浏览器原型**（验界面用，不需要设备） | 本目录 `design\preview\` | 就是本体 | 静态页，`serve.ps1` 起服务 → http://127.0.0.1:8713/（PS 5.1 下需 `-ExecutionPolicy Bypass`） |

> 两个易混点：
> - `..\embodied-watcher\bridge\` 是 **v0.1 旧单文件版**（13 文件，含 `index.js.patched`），既不是运行中的那份，也不是 `bridge/` 副本的来源。
> - `prototypes/cloud/` 是**更早**的 Python 感知 Agent，已被桥取代；`路演` 与 `平台选型` 里提到的 `cloud/agent.py` 就是它。

副本能读什么、不能做什么（改了会被覆盖、缺 `managed_components` 编不了、不含凭据）：见 [`MIRROR.md`](MIRROR.md)。
设备侧完整目录约定见 `..\embodied-watcher\WORKSPACE.md` 与 `.workspace.json`（救砖镜像、tools、logs 都在那边）。

---

## 4. 阅读顺序（按你现在的目的选一条）

**A. 接手项目（约 30 分钟）**
1. 本页 → 2. `docs/进度与下一步-2026-10-30.md`（最新状态与三个卡点）→ 3. `docs/审查-固件与桥-2026-10-30.md`（被修掉的 P0）→ 4. `..\embodied-watcher\WORKSPACE.md`（设备侧全貌）→ 5. `docs/端云具身Agent-落地设计.md`（架构底线：L0/L1/L2）。

**B. 只关心界面**
**圆屏模板（做设计前先看）**：`docs/圆屏显示模板-412.md` + `design/preview/round-template.html`（交互：安全圆/弦长/圆外遮罩/字幕拟合/导出 SVG）→ `design/round-412-template.svg`（拖进 Figma 做叠加）→ `design/out/contact_sheet.png`（9 态联排）→ `design/preview/index.html`（可点）→ `design/ui_mock.py`（改数字出图）→ 规范在 `..\embodied-watcher\docs\UI-设计语言.md` 与 `屏幕倾角补偿.md`。

**C. 只关心设备链路**
先 `..\embodied-watcher\docs\固件-v0.6-接入大脑.md`（整链路与踩坑，v1 时代但物理链路仍成立）→ 代码从 `firmware-v2\main\app_main.cc` 进，再看 `proto.cc` / `app_ui.cc`（协议与交互）、`ws_client.cc`（WS 连接）→ 桥侧 `bridge\lib\index.js`、`bridge\lib\device.js` → 为什么模块化看 `docs/桥-v0.2-参考-aurabot-重构.md`，吞吐瓶颈看 `docs/语音上传-逐帧定位-2026-10-30.md`。

**D. 要讲/要投**
`路演/路演讲稿.md`（8.8 KB，逐页口播）→ `路演/评委Q&A-预案.md`（12 个必问）→ `路演/具身Agent-路演.pdf`。

---

## 5. 常用命令

```powershell
# 镜像：刷新固件/桥的只读副本；-Verify 只比对不改动
# 本机 ExecutionPolicy=RemoteSigned，未签名 .ps1 直接跑会被拒（2026-11-02 实测），用 Bypass：
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sync-mirror.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sync-mirror.ps1 -Verify

# 桥：单元 + 端到端 + 静态审计（改桥后必须全绿；在源目录或本目录镜像里都能跑）
# 注意：本机沙箱里 `node --test` 会因 spawn EPERM 失败，逐文件跑即可
cd $env:USERPROFILE\.dsh\plugins\dsh-embodied-bridge
node --test test\protocol.test.mjs ; node test\loop.mjs ; node test\session.mjs ; node test\audit.mjs
# 2026-11-02 新增回归：node test\retention.test.mjs ; node test\speech.test.mjs ; node test\speech-queue.test.mjs

# 固件：源码在中文路径下不能原地构建；同步到 ASCII 构建目录再 idf.py build
# 构建目录 %LOCALAPPDATA%\hubdev\v2 的 main/ 是源码副本
$env:IDF_TOOLS_PATH='C:\Espressif'; & 'C:\Espressif\v5.5\esp-idf\export.ps1'
Copy-Item .\firmware-v2\main\* "$env:LOCALAPPDATA\hubdev\v2\main\" -Recurse -Force
Set-Location "$env:LOCALAPPDATA\hubdev\v2"; idf.py build
# 固件 host 单测：v2 目前没有（待补：proto/ws_frame 可脱离 IDF 编译）

# 界面：出图 / 起原型
python design\ui_mock.py
.\design\preview\serve.ps1        # → http://127.0.0.1:8713/

# 桥状态
Invoke-RestMethod http://127.0.0.1:7788/health

# 路演物料重建
python 路演\build_deck.py
python 路演\传单\build_flyer.py    # A4 传单（300 dpi PNG + 无损 PDF）
```

---

## 6. 文档与现实的漂移（照着旧文档做会踩的地方）

| 文档 | 它写的 | 实际 |
|---|---|---|
| `START-HERE.md` §3 | 树里有 `firmware/` `bridge/` `proto/` `backup/` `tools/` | 这些全在 `..\embodied-watcher\`；本目录从来没有 |
| `START-HERE.md` §3 | `docs/屏幕倾角补偿.md` `docs/移交清单.md` `docs/UI-设计语言.md` | 在 `..\embodied-watcher\docs\` |
| `docs/落实清单.md` §1 | "Hub 内核代码 ❌ 零行" | 固件已跑到 0.8；S1 骨架的主体在 `embodied-watcher\firmware\` |
| `docs/落实清单.md` §S1 | `firmware/main/core/…` `firmware\host\build.bat` | 路径已迁走，宿主 `build/` 只剩归档的 .obj（见 `_archive/build-stale-2026-10-28/`） |
| `docs/平台选型…md` | `cloud/agent.py`、`firmware/main/core/` | `prototypes/cloud/agent.py`；固件路径同上一行 |
| `prototypes/cloud/README.md` | `proto/schema.json` 是单一事实源 | 协议已按实现为准（`embodied-watcher\proto` 只是早期草稿） |
| `路演/评委Q&A-预案.md` | `cloud/agent.py` | `prototypes/cloud/agent.py` |

> 规则：**文档与代码冲突时，以设备实测/日志为准**（`docs/审查-固件与桥…` 就是这么写的）。
> 镜像另有时间戳：`.mirror.json` 的 `generated_at` 若早于源里最后一次改动，先 `.\tools\sync-mirror.ps1` 再读。

---

## 7. 纪律

1. **`reference/` 只读。** 要升级就 `git -C reference\<name> pull --ff-only`；不要把本地改动提交进去，也不要把它拷回根目录。
2. **新写的东西别放根目录。** 文档进 `docs/`（文件名带日期：`<主题>-YYYY-MM-DD.md`），能跑的实现进 `prototypes/` 或对应工作区。
3. **`_archive/` 只进不出。** 往里放时给个日期目录；引用它之前先确认没有更新的副本。
4. **跨工作区的东西只镜像、不双写。** 固件与桥在本目录是只读副本（`MIRROR.md`），改回源；救砖镜像 `backup/`、`logs/`、`tools/`（设备侧）不复制——唯一凭据只有 `..\embodied-watcher\backup\` 一份。
5. **本页是唯一索引。** 增删目录时同步改 §2 与 §6。

---

## 8. 整理记录（2026-10-30）

### 第一轮 17:05 · 分层（只移动、没删改内容）

路径映射如下（回滚就是反向搬一次）：

| 原位置 | 新位置 | 理由 |
|---|---|---|
| `ai-passport/` `muse-gadget-sdk/` `watcher-sdk/` `watcher-osw/` | `reference/…` | 四个干净的上游克隆（未改动），混在根目录会被误当自研代码 |
| `_ref/aurabot/` | `reference/aurabot/` | 外部参考项目，统一入口 |
| `_dshsrc/` | `reference/dsh-src/` | DSH 内部包源码抽取，写桥时对照用 |
| `docs/reference/honestqiao-board/` | `reference/honestqiao-board/` | 别人的板级实现，不该埋在自家文档树里 |
| `cloud/` | `prototypes/cloud/` | 早期实现，与 `prototypes/` 其余三项同类 |
| `build/` | `_archive/build-stale-2026-10-28/` | 宿主 sim 的 .obj/.exe，源码已迁走 |
| 根目录 5 张 PNG + `hello.obj` | `_archive/scratch-2026-10-28/` | 解码散图与 IDF 示例产物 |
| `.dsh-office-<hash>/` | `_archive/scratch-2026-10-28/dsh-office-render/` | 工具临时渲染目录 |
| `_ref/`、`docs/reference/`（已空） | 删除空目录 | — |

同时改了这些引用：`START-HERE.md` 顶部、`docs/平台选型…md`、`docs/小智具身改造.md`、`路演/评委Q&A-预案.md`、`prototypes/cloud/README.md`、`.vscode/settings.json`、`..\embodied-watcher\WORKSPACE.md`。

### 第二轮 17:31 · 按要求把固件与桥落一份进本工作区

| 新增 | 来源 | 内容 |
|---|---|---|
| `firmware/` | `..\embodied-watcher\firmware\` | 62 文件 / 9.9 MB：`device/`（IDF 工程 + 9 段 pet bin）、`host/`（单测与模拟器）、`main/core/`（M0 骨架） |
| `bridge/` | `%USERPROFILE%\.dsh\plugins\dsh-embodied-bridge\` | 22 文件 / 0.2 MB：`lib/` 12 模块 + `test/` 5 个 |
| `tools\sync-mirror.ps1` | 新写 | 刷新（robocopy /MIR）+ `-Verify` 逐文件比对；源路径运行时推导，脚本保持 ASCII |
| `.mirror.json` | 脚本生成 | 84 个文件的 SHA-256 清单（`mirror-manifest/v1`） |
| `MIRROR.md` | 新写 | 副本的来源/边界/刷新方式 + 固件与桥的读码入口表 |

排除项（写进脚本，不是手工漏的）：`build/`、`managed_components/`、`sdkconfig`、`*.bak`、`node_modules/`、`*.log`，
以及凭据——`wifi_local.h`（`build.ps1` 从 `%LOCALAPPDATA%\hubdev\wifi.env` 生成）、`breezeApiKey` / `panelToken`（默认空串）。

校验：`.\tools\sync-mirror.ps1 -Verify` → `firmware: 62 files, mirror == source` · `bridge: 22 files, mirror == source`。
