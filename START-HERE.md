# 具身 Agent — 状态日志（START HERE）

> **先读 [`README.md`](README.md)。** 那是项目地图：四层判据（当前项目 / 参考 / 历史 / 归档）、
> 跨工作区的三处活代码、阅读顺序、常用命令。本文件是**按时间累积的状态日志**，最新在最上面；
> §2/§3 里"当前状态"与目录树会过时，结构以 `README.md` 为准。

> **2026-11-13（BLE 直连 dsh-Go：手机当大脑，不再必须连 PC）**
>
> 目标：鲸鲸（SenseCAP Watcher / ESP32-S3）经 **BLE** 连手机 dsh-Go，App 当透明网关把 BLE 消息
> 转给手机 PRoot 里的 DSH 引擎桥（guest 插件注入，**不重建运行时**）。WiFi/PC 链路保留，设备
> `>link auto|ble|wifi` 仲裁。
>
> 设计/协议：[`docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md`](docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md)；
> 交付报告：[`docs/蓝牙直连dsh-go-交付报告-2026-11-13.md`](docs/蓝牙直连dsh-go-交付报告-2026-11-13.md)；
> 手机覆盖集：[`dsh-go-ble/`](dsh-go-ble/README.md)。
>
> 验证到哪：固件 `idf.py build` **通过**（最终 bin 6,945,552 B / sha256 `B16096…FD43` / 分区余 45%）；
> 桥 `npm test` 逐文件全绿（新增 ADPCM 与 ffmpeg 参考逐采样 0 差异、wsToken、BLE 端到端）；
> 覆盖集 45 文件 + `apply.ps1` 幂等实测。
>
> **2026-11-13 晚已上真机**（Watcher + Pixel 6；手机用无线 adb `172.16.2.46:40209`；先用自写
> BLE 探针 `_lab/bleprobe/probe.apk` 验证设备侧，再装真 App）：广播 `Jingjing-ACB2` → 连接 →
> MTU 247 → CCCD → `hello(ver 0.3, transport=ble, uplink=adpcm, mtu=247)` → pong → `say/face` →
> ADPCM 下行解码 0 失败 → `shot` 后回 `image`+2836 B JPEG（手机侧 TX 分帧重组正确）。真机修掉：
> BLE+WiFi 同开 OOM 重启循环（改 **Auto = BLE 优先，BLE 失败才 WiFi**，单栈）、无 TF 卡时 mp3 白占
> 24 KB 内部 RAM 导致拍照 SPI 失败、订阅前 hello 丢失（CCCD 打开后立刻补发）。
>
> **22:00 起又跑通「真 App」**：本机装 Flutter 3.47.7 + Android SDK 36 + JDK21 + Gradle 9.3.1
> （NDK 自动装，下载走本机代理 7897），把覆盖集应用到 dsh-Go 1.0.16、`flutter analyze` 0 error、
> 构建 arm64 debug APK（独立包名 `…dsh_app.blelab`，**不覆盖**已装官方 1.0.15）并装到 Pixel 6：
> 引导/运行时解压 851 MB →「设置 › 能力 › 鲸鲸蓝牙」开关 → BLE 自动连接（MTU 247/PHY 2M/CCCD）→
> 手机 PRoot 引擎里的桥 `device.online=true` → 桥 `/say` 设备出声、`/shot` 设备拍照 3239 B 经 BLE
> 回传到桥。又修掉 3 个 App 侧真机 Bug：`onMtuChanged` 覆盖内递归调同名私有函数（worker 静默死、
> MTU 恒 0）、`requestMtu` 与 `discoverServices` 并发顺序、CCCD 后即时 hello 在桥 WS open 前丢失
> （8 KB 缓冲回放，实测 `flushed 1 early bridge message(s)`，桥立即 online）。
>
> **最终收尾（按用户确认）**：旧官方 1.0.15 无数据，已卸载；现在手机上是**官方包名
> `io.github.ccch1mneyyy.dsh_app` 的 1.0.16 debug 版**（带「鲸鲸蓝牙」，versionCode 11132251，
> 运行时重解压 851 MB），再次验证 BLE 连接、桥 online、`/say`、`/shot` 全通。
>
> **23:25 固件 v0.4（用户要求）：移除 WiFi、只保留 BLE，配网向导改蓝牙配对。** 删除
> `net_wifi/ws_client/ws_frame/bridge_find/nvs_creds/wifi_local`，`link` 单 BLE 门面，
> `>link auto|ble|wifi` → `>link`/`>link reconnect`；开机第一屏/菜单「蓝牙」显示
> `Jingjing-ACB2` + 打开手机 App 的鲸鲸蓝牙。bin **6,505,872 B**（sha256 `8ED62B…0D7B`），
> `[mem] after-app 内部 free=119,215 B`（原 34.7 KB），刷机后 BLE/桥/`say`/`shot` 复验通过。
> **已完成实现 + 真实 key 验证**：桥的 TTS/ASR 已切到 **DeepSeek 官方 ASR/TTS API**；
> 真实 key 已配置到手机桥，**TTS 已真机出声**（串口：PCM 218,880 B 收齐 → `audio_end` →
> 播放完毕，`lastEngine=deepseek`）；ASR API 与桥模块已用真实音频验证。
> **下一步**：按一下设备按键说一句，测设备 mic→桥 ASR；之后 App 登录/模型 provider 才能
> 完成「说话→ASR→模型→TTS→出声」。**仍待**：goldens/`flutter test`、PC⇄手机会话互通
> （「远程主机」，非账号同步）。报告 §3.4–§3.7/§7/§8/§10。
>
> 关键决策：BLE 空口 v1 **不加密**（v2 做 LE SC 绑定，已在契约 §8 明示风险）；ADPCM 块以 ffmpeg 实测为准
> （1024 B / 2041 采样，头和 `samples` 字段见契约 §6）；手机桥 `wsToken` 防同机其它 App 连 127.0.0.1:7788。

> **2026-11-04 晚（产品化差距审计 · 桌面陪伴鲸鲸）**
>
> 目标从「可行性验证」转为「产品化」，先把差距审清楚：三份证据级分审计（设备/固件 50 条 ·
> 云桥/大脑 50 条 · 产品/商业 66 条）+ 一份合并总览。一句话结论：**技术链路"能演"，产品化约完成两成**——
> 缺的不是功能，是消费品化五件事：**出厂能力**（配网/身份/OTA/回滚/电源）、**可安装**（现在要装
> DSH+Python+1.23GB 模型+自备 key）、**陪伴行为**（12 条端到端 0 条）、**可卖**（定义 3 套/4 个名字/IP 无授权/无成本模型）、
> **可体验**（首音≈7s、不能打断、断网无屏显、无恢复出厂）。
>
> 先看 [`docs/产品化-Gap-审计-2026-11-04.md`](docs/产品化-Gap-审计-2026-11-04.md)；分审计在 `docs/product-gap/`（01 设备 · 02 大脑 · 03 产品商业）。
>
> 三个待拍决策：① **卖什么形态**（建议先 20 台内测版、验证前不开模）；② **大脑放哪**（首版 PC 一键安装、量产迁云）；
> ③ **不可逆基线**（电源形态/Secure Boot/SN 规则/配网形态/OTA 通道）首批投产前冻结。
>
> ⚠️ 两件应立即处理：**Breeze key 明文**在 `plugins-data/embodied-bridge/config.json`（历史 P0 未闭环，建议今天轮换）；
> **`brain=session` 在真实宿主启动即失败**（`宿主没有 sessionController.create`）并静默降级 `llm`，但 `/health` 仍显示
> `session`——"假健康"，会误导排障。

> **2026-11-04（触摸屏接入）**
>
> 官方规格确认屏幕是 **1.45" 412×412 电容触摸屏**（SPD2010）。v2 之前只初始化显示，触摸从未启用；
> 本轮接上：I2C1(SDA39/SCL38)、50Hz 轮询、手势 **单击=摸摸头 / 双击=再来一次 / 长按=菜单 / 上下滑=音量**，
> 触摸任务只置事件、UI 任务统一执行。固件已编译并刷入（6,518,848 B）。
>
> 实测：`SPD2010: Touch panel create success` + `tp: 触摸就绪`，但首次 `read_data` 出现 I2C NACK，
> 尚未拿到真实触摸坐标——**需要上手摸屏看 `tp: down (x,y)` 日志**再校准坐标/排查链路。
> 排查步骤与坐标事项见 [`docs/迭代-2026-11-04-触摸交互.md`](docs/迭代-2026-11-04-触摸交互.md)。
>
> ⚠️ 事故记录：刷机时 Watcher 的 CH342 串口短暂消失，误把固件写到同机 COM7 的 Waveshare ESP32-S3 板
> （app0 尾部/app1/ffat 前 4.2MB 被覆盖，该板仍能启动）。**刷机前必须认准 `USB-Enhanced-SERIAL CH342`，不能只看 COM 号。**

> **2026-11-03（第三轮迭代：摸摸头交互 + 动画性能）**
>
> ① 旋钮在"没唤出菜单"时 = **摸摸头**：来回搓 ≥2 格 / 连续搓 ≥8 格触发，随机播
> `happy/tickle/shy/wave` 一段（2.4–3.6s）+ 随机台词，冷却 2.2s；音量改到菜单里调。
> ② 动画卡顿修四根因：**删掉"说话降帧"**（互动被压到 5fps 的元凶）、截止时刻累积 + UI tick 10ms、
> 换动作不再整屏刷（旧框恢复+并集刷新）、6 段 clip **共享解码缓冲**（84→14.1 KB）。
> ③ 资产裁剪：3 段互动动画 121→48 帧，新工具 `tools/pclp_trim.py`；app **8.31→6.50 MB**。
> ④ 桥侧修"待机 pong bufMs=0 被误判为链路差 → Opus 被永久退回 PCM"。
>
> 真机验证：fps 9→**10–11**、`clip 6/9`、共享缓冲 14.1 KB、设备在线；已刷 `0x200000`。
> 详见 [`docs/迭代-2026-11-03-摸摸头与动画性能.md`](docs/迭代-2026-11-03-摸摸头与动画性能.md)。
> 旋钮手感（阈值/冷却）需要上手转一下，不合适按反馈调。

> **2026-11-03（第二轮迭代：Opus 链路 + WiFi 稳定性 + 可观测性）**
>
> 按三层清单并行落地：① 设备侧 Opus 解码（vendored micro-opus 0.4.1，PCM 环 **576 KB → 120 KB**，
> 20ms/16k 裸包，失败显式回退 PCM）；② 桥侧 Opus 编码/hello 协商/**自适应码率**（24k/16k/8k→PCM 回退，
> `/api/diag.audio` 可解释）；③ WiFi 锁 BSSID/扫描策略/连接日志 + core dump 128 KB + 栈水位/复位原因 + 说话降帧。
>
> 验证：固件 `hub_v2.bin` **4,946,432 B** 编译通过（分区表新增 coredump，**刷机需刷 0x8000 分区表**）；
> 桥 10 套件全绿（含新增 opus 26 例），已同步运行态插件（**重启 DSH 生效**）。
> 总览、刷机/回滚命令、真机验收清单与风险回退：**[`docs/迭代-2026-11-03-总结.md`](docs/迭代-2026-11-03-总结.md)**。
>
> 未做（有理由）：WiFi/LWIP 缓冲加大、AEC/VAD、PM 动态调频、camera deinit（BSP 无安全 API）、按键语义；
> 自适应阈值/真机音质需刷机后标定。

> **2026-11-02（全量代码审查 + 第一轮迭代）**
>
> 第一次对"固件 / 桥 / persona / 工程面"做四路并行审计，共 **117 条缺陷**（P0×2 / P1×25 / P2×44 / P3×46），
> 逐条带代码行与证据。总览与"已修/未修"清单：**[`docs/代码审查与迭代-2026-11-02.md`](docs/代码审查与迭代-2026-11-02.md)**；
> 原始报告在 `docs/audit/`。
>
> 本轮修掉 4 个"看起来能用、实际空转"的洞：**多句回复只念第一句**、**拍照因 imageKeep=0 保存即删除**、
> **本地台词包从不落盘**、**配置静默覆盖 + 动作接口可被网页 CSRF**；固件另修 **尾垫越界读**、
> **摄像头缓冲越界写**、**收包任务里阻塞 1.5 s**、**语音上行阻塞 UI 8–23 s** 等。
> 固件已编译（`hub_v2.bin` 4.84 MB，未刷机）；桥已同步到运行态插件，**重启 DSH 后才生效**。
> 工程面补了 **git 版本库**（此前无回滚）、镜像刷新、脚本执行策略说明。
>
> 下一步：轮换 Breeze key、刷机验证、桥侧接 `play/stop`、大脑超时、WS 鉴权（详见总览 §4）。

> **2026-10-31（鲸鲸 v2 · 看听说闭环打通，代码已归档到工作区）**
>
> 新会话读这一条就够。**完整快照**：[`snapshot-2026-10-31_鲸鲸v2/`](snapshot-2026-10-31_鲸鲸v2/)
> （源码 + 配置 + 可刷固件 + README）。**活代码**：固件 [`firmware-v2/`](firmware-v2/)，
> 桥 [`bridge/`](bridge/)（已与 `~/.dsh/plugins/dsh-embodied-bridge` 同步）。
>
> **能力**：412×412 面板 + 三段动画（fps=9）/ 旋钮+菜单 / 灯状态机 / 麦克风 10 s /
> **摄像头 HX6538 240×240 JPEG**（8 s 周期 + 说话时自动拍 + `{"t":"shot"}` 按需）/
> **Breeze TTS 流式**（`voc_8yud7hz7c9q2`，首字节 0.65 s）/ WS 双向 16 KB 帧。
>
> **三条必读教训**：① 配置三层优先级 `profile/cordis.patch.yml` > `plugins-data/config.json`
> > 插件自带 patch，音色/密钥**只写 patch 层**（今晚因此 4 次"改了没生效"）；
> ② 禁止引擎间静默换音色（`breeze` 失败曾掉到 Windows SAPI / 测试男声）；
> ③ I/O 任务禁止阻塞（播放/录音必须走环形缓冲 + 独立任务）。
>
> **构建必须用 ASCII 路径**：`%LOCALAPPDATA%\hubdev\v2`（中文路径 kconfig 失败）。
> 待办：图像直传 LLM、Opus 编码、断线重连退避、AP 配网。

> **2026-10-30 晚（设备已回到线上）**：换网络（→ `TT-W8BQ`）后设备一直离线，根因是固件
> **从没调用过 `nvs_flash_init()`**：应用 NVS 和驱动 NVS 两条读凭据的路全废，只剩编译期
> `wifi_local.h`，所以换网只能重刷；串口 `>wifi` 也因此报"保存失败"。
> 已修 + 刷到 ota_1 + 用设备自述验证：`wifi 已连 ssid="TT-W8BQ" ip=192.168.66.14 来源=应用 NVS`，
> `ws 已连 192.168.66.161:7788`。审查全记录见
> [`docs/审查-固件与桥-2026-10-30.md`](docs/审查-固件与桥-2026-10-30.md)。
> 换网现在只要串口发 `>wifi <ssid> <pass>`，不必再刷机。

> **2026-10-30 更新（桥 v0.2）**：桥从"单文件插件"改成模块化，并修掉四个真问题
> （模型四连回空 / ASR 常驻起不来 / 音频灌爆掉线 / 没有事件留存）。
> 设备对话现在进**它自己的 DSH 会话**（侧栏「具身Agent · Watcher」，能插话、共用工具）。
> 代码在 **`~/.dsh/plugins/dsh-embodied-bridge`**（不是本目录的 `bridge/`，那是个旧引用），
> 旧版备份 `dsh-embodied-bridge.bak-v0.1-20261030-130618`。
> 方法论文档：[`docs/桥-v0.2-参考-aurabot-重构.md`](docs/桥-v0.2-参考-aurabot-重构.md)。
> 生效要**重启 DSH**；验：`node test/loop.mjs`、`node test/session.mjs`、`node test/audit.mjs`、`test/fake-watcher.mjs`。

> **2026-10-28 更新**：设备侧已经落地并跑通 ——
> Watcher 上跑自研固件 **v0.6**，从 `ota_1` 启动，WiFi→`ws://192.168.0.17:7788/device`
> →`hello/welcome/face`→`>text` 上行→`think`+`say` 中文上屏。
> 代码在 `firmware/device/`，DSH 侧插件在 `bridge/`，
> 全流程与刷机纪律见 [`docs/固件-v0.6-接入大脑.md`](../embodied-watcher/docs/固件-v0.6-接入大脑.md)。
> 下文 §1–§7 是更早一轮（M0 规划时）的记录，仍然有效但优先级已变化。

> 前情：会话 `session-59a8ff8c`（12 轮，D:\DSH_workspace）已读完，完整逐字记录见
> [`_archive/session-59a8ff8c.transcript.md`](_archive/session-59a8ff8c.transcript.md)。
> 本文件是那场 12 轮对话的**结转到可执行状态**的版本。先读这里，再读 `docs/` 里的两份设计。

---

## 1. 三十秒

放弃小智（xiaozhi-esp32 v1.8.5），自研 **Hub**：一个"能力可以在运行期生长"的具身节点运行时。
设备端只做躯干与反射弧（L0 中断→动作 / L1 本地规则），云端做大脑（L2 LLM + 工具编排）。
两块实机：**SenseCAP Watcher**（眼睛+表情）+ **M5Stack Cardputer-Adv**（手+键盘+IMU）。
第一块开发板是 Cardputer，**M0 不碰 Watcher**。

---

## 2. 现在是什么状态（2026-10-26 复核，不是引用旧结论）

| 项 | 实测 | 影响 |
|---|---|---|
| Watcher 是否连着 | ❌ 只剩蓝牙 COM3/COM4，CH342 不在 | 这台机器现在拿不到设备；M0 用 Cardputer，不受影响 |
| 备份完整性 | ✅ 重算 SHA256 = `C9D12CB9…73EDBE0`，与旧记录逐字节一致 | 救砖能力已迁到本工作区 |
| 本机 ESP-IDF 工具链 | ✅ **已修**：`xtensa-esp-elf` 的 `include/libexec/picolibc/share/xtensa-esp-elf` 五个目录曾被解压成 0 字节文件（`libexec` 一坏 → 找不到 cc1）；已从本地缓存 386MB 官方 zip 重解压，`gcc 14.2.0` 编译通过 | 交接清单里"第一天就会撞上"的坑已清掉 |
| `idf.py` 全链路 | ✅ **已实测**：重建 `C:\Espressif\python_env\idf5.5_py3.11_env`（3.11.15）+ 按 constraints 装依赖；`examples/get-started/hello_world` 对 **esp32s3 编译成功**（521/521，产出 hello_world.bin） | 现在就能写 M0 固件并 `idf.py build`，不必换机器 |
| `riscv32-esp-elf` 工具链 | ❌ 同样被解压坏（含 `lib`） | 与 ESP32-S3 无关，先不管；需要 C6/C3 时再修 |
| 目标芯片 | 两块板都是 **ESP32-S3（xtensa）**，IDF v5.5 够用 | 不需要装 IDF 6.x |

---

## 3. 目录地图（2026-10-26 快照 · 已过时）

> 现行结构见 [`README.md`](README.md) §2。此树里的 `firmware/`、`bridge/` 的**主源**在
> `..\embodied-watcher\` 与 DSH 插件目录，本目录另存一份只读副本（见 [`MIRROR.md`](MIRROR.md)）；
> `proto/`、`backup/`、设备侧 `tools/` 仍只在 `..\embodied-watcher\`；
> `cloud/` 已归 `prototypes/cloud/`；上游 SDK 克隆已归 `reference/`。

```
具身Agent/
├── START-HERE.md                     ← 你在看的这份
├── docs/
│   ├── 端云具身Agent-落地设计.md        ✅ 主设计（L0/L1/L2、三任务接口、PolicyGate、M0–M6）
│   ├── 新轮子-架构设计.md               ✅ Hub 五条超越指标、能力描述符、反射弧 DSL
│   ├── 小智具身改造.md                  🟡 小智 1.8.5 实机地图（只在需要对照时看）
│   ├── 屏幕倾角补偿.md                  ✅ 屏幕歪是装配公差（树脂胶粘死），只能软件规避/补偿
│   ├── UI-设计语言.md                   ✅ 「虹膜」界面规范：旋转不变形造型 + 分状态视觉稿
│   ├── 伙伴形态-可行性.md               ✅ 派蒙/机灵能做到哪一步：12 个行为 + 硬指标 + 做不到清单
│   ├── 移交清单.md                      ✅ 硬事实速查（分区表/引脚/12 个 MCP 工具/坑）
│   └── archive/                        ❌ 两份已废文档（基于 Seeed 工厂固件，留档）
├── backup/                             ⚠️ 唯一的救生圈，别弄丢
│   ├── full_flash_32MB.bin             32MB 全片镜像（SHA256 见 SHA256.txt）
│   ├── nvsfactory.bin                  EUI / 云端凭据（200KB）
│   ├── nvs_orig.bin                    现有 NVS，含 WiFi（860KB）
│   ├── nvs_new.bin                     含 ota_url 的备用件（**从未刷入**）
│   └── SHA256.txt
├── design/                             界面视觉稿（渲染器 + 9 态 PNG + 联排 + 动效 GIF）
│   ├── ui_mock.py                      改数字即出图，4× 超采样
│   ├── preview/                        交互原型（单文件 HTML，http://127.0.0.1:8713/）
│   │   └── sense.html                  感知端：真摄像头 + 真麦克风 → ws://127.0.0.1:8711
│   └── out/                            idle / listen / think / speak / say / notice / menu / offline / calib / eye
├── cloud/                              最小感知型 Agent（WebSocket + 知觉状态机）
│   ├── agent.py                        感知 → 状态机 → 事件；语义留空钩子
│   ├── test_client.py                  无设备端到端自测（5 项断言）
│   └── README.md                       怎么跑、边界、为什么这样切
├── proto/schema.json                   设备 ⇄ 云 的单一事实源
├── prototypes/                         上一轮跑过的原型，不是最终架构，参考用
│   ├── embodied/gateway.py             Seeed 固件时代的视觉网关（含 mock 模式）+ ota_stub.py
│   ├── mcp-bridge/                     外挂 MCU 侧边车的 MCP 桥协议 + MicroPython 固件
│   └── scripts/                        dump/inspect/nvs 工具
└── _archive/session-59a8ff8c.*         上一场对话的逐字记录（raw + 可读版）
```

不在本目录的公开仓库（用时再 clone，别拷进来）：

```powershell
git clone --depth 1 https://github.com/78/xiaozhi-esp32          # 小智固件（读代码取证用）
git clone --depth 1 https://github.com/Seeed-Studio/OSHW-SenseCAP-Watcher   # 硬件图纸（含 47MB 3D 外壳）
```

---

## 4. 硬事实（已实测，别再查第二遍）

分区表、引脚、12 个 MCP 工具、Cardputer 规格 → 见 [`docs/移交清单.md`](../embodied-watcher/docs/移交清单.md) 第 5 节。

三条最容易重犯的：

1. **`ota_1` 是空的**（0xe00000，0xCC 填充）。改 Watcher 固件前必须先把分区表改成 A/B 双 12MB 槽，
   否则每次刷机都是单点。`backup/full_flash_32MB.bin` 是唯一救砖手段。
2. **`--after no-reset` 会把芯片留在下载模式**：黑屏、无串口，看起来像砖。所有串口操作收尾一律
   `--after hard-reset`。同理，CH342 消失先查是不是插在背面那个只供电的 USB-C、或用了充电线。
3. **浮点做 XOR+RLE 没意义**；IMU 摘要用 int16(mg) → delta → zigzag varint。
   PolicyGate 只"拒绝"也不够，必须带 `max_on_ms` 看门狗强制关断。
4. **屏幕歪是物理约束**（2026-10-26 拆机确认：树脂胶粘死，无安装位，不可调）。
   MADCTL 只有 0/90/180/270 + 镜像，2~3° 只能软件规避：
   默认走**放射布局**（零代价），要长文本再单块旋转 + 触摸反向补偿。
   量角工具 [`tools/measure_tilt.py`](../embodied-watcher/tools/measure_tilt.py)（自检误差 0.03°），
   方法与代价见 [`docs/屏幕倾角补偿.md`](../embodied-watcher/docs/屏幕倾角补偿.md)。

---

## 5. 待决策（挡在 M0 前面的就这四个）

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 语音闭环从哪起 | 先用现成 ASR/TTS/LLM 只搭管道，端侧不跑模型 |
| 2 | 协议 | 自定 JSON-RPC + 二进制音频帧，**不兼容小智 WS 协议**（省得被绑住） |
| 3 | Watcher 何时进项目 | M0 之后、且分区表改成双槽之后 |
| 4 | 工具链 | 已在本机修好（见 §2），不必换机器 |

---

## 6. M0 定义（唯一该先做的事）

**目标**：Cardputer 上跑通 Hub 内核骨架 —— EventBus + 两个内置能力（IMU / 键盘）+ 控制台事件流。

**验收**（可观测，不靠"看起来好了"）：
- 摇一下板子 → 串口打出 `ext.imu.moved`，同时本地 `/debug` 页出现同一条事件；
- 按一个键 → 打出 `key.press` 带键值；
- 空跑 CPU 占用 < 5%。

**M0 的代码边界**（只写这些）：
```
firmware/main/core/   event.h  event_bus.h/.cc  capability.h/.cc
firmware/main/tasks/  reflex_task  perception_task(空壳)  session_task(空壳)
firmware/main/boards/ board.h  cardputer/
firmware/main/app_main.cc
```
不写云、不写 LVGL、不写摄像头、不碰 Watcher。

> 判据：M0 过不了，说明"事件总线 + 能力注册"这两个抽象没设计对——那是有价值的早失败，
> 比堆到 M3 再发现要便宜得多。

---

## 7. 环境修复记录（本次，可复现）

```powershell
# 现象：xtensa-esp-elf-gcc 报 "cannot execute cc1"；目录 include/libexec/picolibc/share 是 0 字节文件
# 根因：解压器把 zip 里的目录条目写成了空文件（eim 的解开方式），工具链本体是好的
# 修复（离线，用本地缓存的 386MB 官方 zip）：
$root='C:\Espressif\tools\xtensa-esp-elf'; $ver='esp-14.2.0_20241119'
Remove-Item $root -Recurse -Force
New-Item -ItemType Directory -Force "$root\$ver" | Out-Null
python -c "import zipfile;zipfile.ZipFile(r'C:\Espressif\dist\xtensa-esp-elf-14.2.0_20241119-x86_64-w64-mingw32.zip').extractall(r'$root\$ver')"
& "$root\$ver\xtensa-esp-elf\bin\xtensa-esp-elf-gcc.exe" --version   # -> 14.2.0 ✅
```

`idf.py` 环境的日常入口（每个新 shell 一次）：

```powershell
$env:IDF_TOOLS_PATH='C:\Espressif'
& 'C:\Espressif\v5.5\esp-idf\export.ps1'
idf.py --version          # 然后把 idf.py set-target esp32s3 && idf.py build 当日常
```

补齐 `idf.py` 环境时还做了两件事（缺一步 `export.ps1` 就报错，记下来免得再踩）：

1. `C:\Espressif\espidf.constraints.v5.5.txt` 缺失 → 从 `C:\Espressif\tools\` 下复制过去；
2. 依赖必须带 constraints 装，否则 `cryptography` 装成 50.x 而 IDF 5.5 要求 `<45`：
   ```powershell
   & 'C:\Espressif\python_env\idf5.5_py3.11_env\Scripts\python.exe' -m pip install `
     -c 'C:\Espressif\espidf.constraints.v5.5.txt' `
     -r 'C:\Espressif\v5.5\esp-idf\tools\requirements\requirements.core.txt'
   ```
3. 注意：PATH 里 `python` 是 hermes 的 venv（3.11.15），会污染 IDF 的安装脚本
   （`install.ps1` 会报 "called from a virtual environment"）；建 venv 要用真实解释器
   `C:\Users\14167\AppData\Roaming\uv\python\cpython-3.11-windows-x86_64-none\python.exe`。
