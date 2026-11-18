# dsh-go-ble —— 让鲸鲸通过 BLE 直连 dsh-Go

> 一份**覆盖集补丁**（不是完整 fork）：把
> 「手机 dsh-Go（DSH 引擎）⇄ BLE ⇄ SenseCAP Watcher / 鲸鲸」这条链路接起来。
> 契约见 [`../docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md`](../docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md)，
> 本文是**操作手册**。

```
设备（firmware-v2，BLE peripheral）
   │  BLE GATT：7 字节帧 / ADPCM 音频 / 12 KB/s
   ▼
dsh-Go App（本补丁：EmbodiedBleService 前台服务，BLE central + 手写 WS 客户端）
   │  ws://127.0.0.1:7788/device?token=…
   ▼
手机 PRoot 里的 DSH 引擎
   └─ 插件 dsh-embodied-bridge（大脑桥，来自本工作区 bridge/，guest 注入，**不用重建运行时**）
```

三块交付物：

| 位置 | 跑在哪 | 作用 |
|---|---|---|
| `bridge/`（本工作区根） | PC 或手机 DSH 引擎 | 大脑桥（DSH 插件）。本次新增 ADPCM/wsToken/discover/BLE 诊断；PC 老行为不变 |
| `firmware-v2/`（本工作区根） | 设备 | BLE 传输层 + ADPCM 编解码 + 双链路仲裁 + 串口命令；WiFi 路径保留 |
| `dsh-go-ble/`（本目录） | 手机 App | BLE 网关前台服务、guest 插件注入、设置页、权限/清单 |

> **2026-11-13 真机状态：已编译 + 已跑通，并已合并进官方包名。** 在本机装 Flutter 3.47.7 /
> Android SDK 36 / JDK 21 / Gradle 9.3.1（NDK 由 AGP 自动安装；Gradle/NDK 下载走本机代理 7897），
> 把本覆盖集应用到 dsh-Go 1.0.16，`flutter analyze` 0 error，构建 arm64 debug APK 并装到 Pixel 6：
> 设置「能力 › 鲸鲸蓝牙」→ BLE 自动连接（MTU 247 / PHY 2M / CCCD）→ 引擎内桥
> `device.online=true` → 桥 `/say` 设备出声、`/shot` 设备拍照经 BLE 回传成功。
> 真机修的 3 个 Bug（`onMtuChanged` 递归、MTU/发现顺序、早期 hello 丢）已回写本目录的
> `EmbodiedGateway.kt`。
>
> 收尾时用户确认旧官方 1.0.15 无数据，已卸载；当前手机上是**官方包名
> `io.github.ccch1mneyyy.dsh_app` 的 1.0.16 debug 版**（带「鲸鲸蓝牙」），不是 `.blelab` 两个 App。
> 注意 debug 签名与官方 release 不同，以后装官方 release 包需要先卸载；要保留数据升级需用
> 同一 release key 重打。完整记录（build/env/命令/证据/剩余项）见
> [`../docs/蓝牙直连dsh-go-交付报告-2026-11-13.md`](../docs/蓝牙直连dsh-go-交付报告-2026-11-13.md) §3.5。
>
> 测试期两个临时改动（不进覆盖集）：`applicationId` 先改成 `…dsh_app.blelab` 并存、最终改回官方包名；
> `app/android/gradle.properties` 加 `systemProp.https.proxyHost/Port`。

---

## 0. 前置条件

- 一份 **dsh-Go 1.0.16 源码树**（本机对照件在 `../reference/dsh-go-main/`，只读）。
- Flutter 3.47.7 / Dart 3.13 SDK + Android SDK 36、JDK 21、Gradle 9.3.1（上游
  `tooling/setup-toolchain.sh` 有清单；Windows 本机实测可用）。
- 一份**可用的运行时资产** `runtime/out/arm64/assets/runtime/**`（dsh-Go 的 APK 构建直接引用它；
  本补丁**没有**改运行时，继续用你原来那份即可。没有就按上游 `runtime/build-runtime.sh` 在
  Linux 上先构建一次——那一步要下载 Ubuntu/Node/DSH，手机上做不了）。**实测最快的来源**：
  从已安装的官方 APK 里 `adb pull` 出 `assets/runtime/rootfs-arm64-v8a.tar.xz` +
  `manifest.json` + `jniLibs/*.so`，解压到 `runtime/out/arm64-v8a/`（详见交付报告 §3.5）。
- 手机：Android 8+（targetSdk 28 的 Legacy 蓝牙模型，扫描需要**定位权限**）。
- 设备：SenseCAP Watcher，刷本次编好的 `hub_v2.bin`（见 §5）。

---

## 1. 应用覆盖集

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-go-ble\apply.ps1 -Target C:\path\to\dsh-go
# 先看会改什么（不写文件）
powershell ... -File .\dsh-go-ble\apply.ps1 -Target ... -DryRun
# 只检查目标能不能干净应用
powershell ... -File .\dsh-go-ble\apply.ps1 -Target ... -Check
```

```bash
# Linux / macOS
bash dsh-go-ble/apply.sh /path/to/dsh-go
bash dsh-go-ble/apply.sh /path/to/dsh-go --dry-run
```

覆盖集内容 = **新增文件 + 被替换文件的完整内容**：新增 7 个 Kotlin + 1 个 guest + Flutter 4 个
新文件 + 插件 assets；替换 `AndroidManifest.xml`、`MainActivity.kt`、`runtime/DshProcess.kt`、
`runtime/RuntimeController.kt`、`settings/index/spots.dart`、`settings/index/settings_pages.dart`、
`settings/settings_screen.dart`、`test/settings/index/index_sync_test.dart`、`pubspec.yaml`。
**不删除**目标里的任何文件；`git diff` 就是全部改动。

`files-manifest.json` 记录每个替换文件的上游 SHA-256：目标文件既不是上游原版、也不是本补丁时，
脚本报**漂移**并拒绝覆盖（换上游版本后先 `node dsh-go-ble/tooling/make-manifest.mjs` 再 diff）。
应用/改完 bridge 后重跑 `node dsh-go-ble/tooling/sync-embodied-assets.mjs`（把 `bridge/` 同步成
`files/app/assets/engine/embodied/`）和 `make-manifest.mjs`。

---

## 2. Flutter 侧验证（没有 Flutter 的机器做不了）

```bash
cd app
flutter pub get
flutter analyze
# 新设置行让「全部功能」hub 多一行：goldens 必须重拍（本补丁交付时没有 Flutter 环境）
flutter test --update-goldens test/settings test/shell test/landscape
flutter test
```

> 本补丁新增的 Dart 文件用 `embodied_strings.dart` 里的中英双语 helper（v1 不走 ARB 生成链，
> 因为交付环境没有 Flutter 跑 `tool/l10n_merge.py` + gen-l10n）。迁到 ARB 是后续清理项；
> 在此之前 `python3 app/tool/l10n_merge.py --check` 仍应通过（没有新增/改动 ARB）。

---

## 3. 构建 APK

```bash
# 运行时资产已就位时（runtime/out/arm64/…）
bash tooling/build-apk.sh -f arm64
# 产物：app/build/app/outputs/flutter-apk/…（见上游 docs/release.md）
```

本补丁**不需要** `DSH_BETA_TOKEN_FILE`（那是 `--beta` 内部渠道包才用）。
APK 包体不会变大到需要关心：新增代码 + 插件 assets 约 250 KB（插件 JS 本身 ~230 KB）。

安装后首次打开：`设置 › 鲸鲸蓝牙`（在「能力」分组里）。

---

## 4. 手机端使用

1. 打开 `设置 › 鲸鲸蓝牙`，读一下状态卡（服务/蓝牙/权限/引擎/桥）。
2. 打开 **启用蓝牙对接**：会申请**定位权限**（Legacy 蓝牙模型扫描必需）并启动前台服务
   （通知「鲸鲸蓝牙」，带 **停止 / 重连**）。
3. 设备开机后出现在 **设备** 卡片（广播名 `Jingjing-XXXX`），点一下连接；
   或者打开 **自动连接**（默认开，会连回上次设备）。
4. 状态变 `ready`（MTU ≥ 100）+ 桥 `已连接` 即通；设备屏幕/灯会显示连接状态。
5. 设备按键录音 → 手机桥日志出现 `语音解码 adpcm→pcm` 和 `ASR`；回复下发会走 ADPCM，设备出声。

**桥插件怎么进手机引擎**：App 每次启动引擎前把 APK assets 里的 `dsh-embodied-bridge`
写到 PRoot 的 `/opt/dsh-app/embodied/`，再生成 `embodied.patch.yml`（含随机 `wsToken`、
`host:127.0.0.1`、`discover:false`）并用 `--patch` 注入 DSH（安全模式不注入）。
所以**不需要重建手机运行时**；引擎升级也不会覆盖它。

**桥的配置**（TTS/ASR/音色/key 等）：在手机浏览器打开 `http://127.0.0.1:7788/panel`
（PRoot 与手机共享回环）。手机里没有 ffmpeg：下行语音会走 ADPCM；TTS 引擎建议
`breeze`（要 key）或把 `tts` 关掉只看文字；ASR 用引擎侧 `speechToText` 插件
（App 的语音模型页可下载 SenseVoice）。

---

## 5. 设备端（固件）

```powershell
# 中文路径不能原地构建：同步到 %LOCALAPPDATA%\hubdev\v2 再 build（详见 firmware-v2 文档）
$env:IDF_TOOLS_PATH='C:\Espressif'; & 'C:\Espressif\v5.5\esp-idf\export.ps1'
Copy-Item .\firmware-v2\main\* "$env:LOCALAPPDATA\hubdev\v2\main\" -Recurse -Force
Set-Location "$env:LOCALAPPDATA\hubdev\v2"; idf.py build
# 刷机：只写 ota_1（0xe00000），分区表 0x8000 本次未改（刷机纪律见 docs/迭代-2026-11-03-*）
```

设备串口（UART0，115200）：

| 命令 | 作用 |
|---|---|
| `>link` | 显示模式（auto/ble/wifi）、两链路连接状态、MTU、RSSI、计数 |
| `>link auto\|ble\|wifi` | 切换传输模式并持久化到 NVS |
| `>stat` | 传输/链路统计（含 txDrop/rxDrop） |
| `>adpcm` | ADPCM 与桥共享向量的自检（逐条 PASS/FAIL） |
| `>help` | 命令表 |

默认 `auto`：BLE 连上就暂停 WiFi 拨号，BLE 断开自动恢复。只想用 PC 时 `>link wifi` 即回到旧行为。

---

## 6. 验证清单

本仓库内可自动跑的（2026-11-13 已跑）：

- 桥：`cd bridge && npm test`（含 `test/adpcm.test.mjs` 与 `test/loop-ble.mjs`：
  wsToken 401、BLE hello 字段、ADPCM 上行→WAV、pong 新诊断、ADPCM↔ffmpeg 参考一致）
- 固件：`idf.py build` 通过（尺寸/内存数据见交付报告；**未刷机、未真机验证**）
- 覆盖集静态检查：`node dsh-go-ble/tooling/check-native-files.mjs`、
  `node dsh-go-ble/tooling/check-channel-sync.mjs`（108 项：§10.3 方法/事件/字段 ⇄ Kotlin ⇄ Dart、
  UUID/分帧/ADPCM ⇄ 固件 ⇄ 桥、guest patch 键/监听路径/token、Manifest 权限/FGS、覆盖集清单）、
  `node dsh-go-ble/tooling/sync-embodied-assets.mjs --check`

必须在有 Flutter 的机器/真机上做的：

1. `flutter analyze` / `flutter test`（goldens 见 §2）。
2. 真机顺序：开开关 → 权限 → 通知；设备广播 → 扫描 → 连接（`ready`、`mtu≥100`、
   `bridge.connected=true`）；设备说一句 → 桥日志；回复 → 设备出声；
   引擎 stop/start → 服务自动停/起；通知 **停止/重连**；系统关蓝牙 → 设置页 `lastError`。
3. 设备端：`>link` 状态、`>adpcm` PASS、10 s 语音上行耗时、离远断开后靠近自动重连（≤10 s）。

---

## 7. 已知限制（v1 明示，不是 bug）

- **BLE 链路不加密**（无配对/绑定）：附近设备可连接并冒充手机。v2 做 LE Secure Connections
  + 配对窗口。桥侧 `wsToken` 只保护手机本机 loopback（防止同机其他 App 连桥），不保护空口。
- **Kotlin/Dart 未在本交付环境编译过**（没有 Flutter/Gradle/设备）：已做静态检查与 API 核对，
  但仍可能有编译错误；以 §2 的 `flutter analyze` 为准。
- **goldens 未重拍**：hub 多一行，`flutter test` 会红，必须先 `--update-goldens`（§2）。
- **语音依赖**：手机桥没有 ffmpeg，下行用 ADPCM（12 KB/s）；TTS 引擎需要 Breeze key 或
  `tts:false`；ASR 需要 DSH 的 `speechToText`（SenseVoice 插件，约 390 MB）。
- **单设备/单连接**：桥是单设备模型；手机同一时间只连一台鲸鲸。
- **后台保活**：靠前台服务 + 省电白名单（App 已有引导页）；被系统杀掉后 BLE 断，
  引擎重启/服务重启才恢复（v1 不自建 watchdog）。
- 设备侧 WiFi 与 BLE 共用射频：`auto` 模式 BLE 连上会暂停 WiFi 拨号，避免共存掉速。
- 模拟器没有 BLE 外设，只能看界面。

---

## 8. 排障

| 现象 | 先查 |
|---|---|
| 设置页「本机引擎未运行」 | 先启动本机引擎；BLE 网关只在引擎运行时由 `RuntimeController` 拉起 |
| 扫描不到设备 | 定位权限是否给了；设备是否已刷 BLE 固件并在广播（`>link`）；设备名是否被 `设备名前缀` 过滤 |
| 连上但 `bridge.connected=false` | 手机引擎/桥插件是否起来：`/opt/dsh-app/embodied/embodied.patch.yml` 是否存在；引擎日志里有没有 `dsh-embodied-bridge` 加载错误 |
| `lastError` 有 401 | 桥的 `wsToken` 与 App prefs 不一致（一般是引擎启动前 guest 没写入；重启引擎） |
| `MTU 过小` | 手机/设备蓝牙栈拒绝 247；换机试，或把 `MIN_MTU` 调到 80（会限制 16 KiB 消息分片数） |
| 设备上报语音很慢 | `>stat` 看 rxDrop/txDrop；BLE 实际吞吐 <12 KB/s 时会被桥判"链路差" |
| 改了桥地址不生效 | 断开重连一次（`applyConfig` 只在下次连接/重开 WS 时生效） |

---

## 9. 回滚

- 手机：`设置 › 鲸鲸蓝牙` 关开关；或在目标仓库 `git checkout -- .`（覆盖集不删文件）。
  已写入 rootfs 的 `/opt/dsh-app/embodied/` 留不留都不影响引擎（下次启动会被重写/跳过）。
- 设备：`>link wifi` 回旧链路；固件回滚按 `docs/迭代-2026-11-03-总结.md` 的刷机纪律。
- 桥：`git checkout -- bridge/`；新能力全为可选字段，旧 PC 路径行为不变。

---

## 10. 与上游的关系

dsh-Go 采用 **AGPL-3.0**（`sdk/`、`examples/` 为 MIT），名称/标识/Deepy/鲸娘素材不在开源授权内
（上游 `ASSETS.md`），且上游 `AGENTS.md` 明确**暂不接受外部 PR**。本覆盖集是**自用 fork 的补丁集**，
不是向上游提交的改动；若分发修改版，须按 AGPL 保留版权与修改声明、换掉受保护名称与素材。
