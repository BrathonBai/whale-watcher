# dsh-Go 原生侧：鲸鲸蓝牙（BLE 网关）

本目录是 `dsh-go-ble` 修改集中 **Android 原生侧** 的新增代码（协议见
`docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md` §4 / §10）。覆盖到 dsh-Go 源码树后与
`runtime/` 下三个替换文件、`MainActivity.kt`、`AndroidManifest.xml` 一起生效。

## 类职责

| 文件 | 职责 |
|---|---|
| `EmbodiedPrefs.kt` | SharedPreferences `embodied_ble`：`bridgeUrl`（默认 `ws://127.0.0.1:7788/device`）、`token`（32 hex，首次随机生成）、`autoConnect`、`devicePrefix`、`lastAddress`、`enabled`（默认 false）。token 由本类生成并持久化，`EmbodiedGuest` 和网关共用。 |
| `EmbodiedFraming.kt` | §4 分帧/重组，纯 Kotlin（不依赖 Android）。`EmbodiedFraming.encode` 切帧；`EmbodiedReassembler` 严格顺序重组、丢帧计数、3 s 超时、每类 1 条在途消息。text 4096 / binary 16384 / frag_total ≤ 255。 |
| `EmbodiedWebSocket.kt` | 手写最小 WS 客户端：`java.net.Socket` + HTTP Upgrade（校验 `Sec-WebSocket-Accept`）、客户端必掩码、text/binary/ping/pong/close、服务端分片重组。只支持 `ws://`（桥在回环，无 wss）。 |
| `EmbodiedGateway.kt` | 进程内单例网关：BLE central 状态机（scan→connect→requestMtu(247)→discover→notify+CCCD→WS→ready）、双向转发、4 片/连接事件写 DOWN（`onCharacteristicWrite` 配速 + 12 ms 兜底定时器）、1/2/5/10 s 退避、计数器、`status` 快照。**所有 GATT 操作在单线程 Executor 上串行**。 |
| `EmbodiedBleService.kt` | 前台服务（`specialUse`）：通知「鲸鲸蓝牙」+ 状态行，action 停止 / 重连；`syncEngine()` 由 `RuntimeController` 调用，引擎 running 且开关 on 时启动，引擎 stopped 时停止。 |
| `EmbodiedBlePlugin.kt` | `FlutterPlugin` + `ActivityAware`：MethodChannel `dsh/embodied_ble`、EventChannel `dsh/embodied_ble/events`；`ACCESS_FINE_LOCATION` 权限申请（复用 `VoicePlugin` 的 `RequestPermissionsResultListener` 模式）；adapter off / 权限缺失返回可读错误。 |

替换文件（不在本目录，见修改集对应路径）：

- `runtime/EmbodiedGuest.kt`：照 `AppAuthGuest` 把 `flutter_assets/assets/engine/embodied/` 递归拷到
  `/opt/dsh-app/embodied/`，生成 token，写 `embodied.patch.yml`（§10.1），`launchArg()` 注入 `--patch`。
- `runtime/DshProcess.kt`：组合参数处追加 embodied overlay（`embodiedOverlay` 参数；仅正常启动、
  非 safe mode、patch 文件存在时）。
- `runtime/RuntimeController.kt`：引擎启动前写 guest；`setPhase()` 里同步网关 engine 状态并按需启停
  前台服务。
- `MainActivity.kt`：注册 `EmbodiedBlePlugin`。权限回调不需要 MainActivity 手写转发：
  `FlutterActivity` 已把 `onRequestPermissionsResult` 转给 `ActivityPluginBinding` 注册的监听者。
- `AndroidManifest.xml`：删掉 `BLUETOOTH` 的 `tools:node="remove"`，新增
  `BLUETOOTH` / `BLUETOOTH_ADMIN` / `ACCESS_FINE_LOCATION`，新增 `EmbodiedBleService` 声明。

## 线程与事件模型

- 公共方法任意线程可调；状态改动全部投递到 `embodied-gatt` 单线程 Executor。
- 网关事件（`status` / `scan` / `log`）统一在主线程分发给监听者，因此 EventChannel 的
  `EventSink.success` 与前台服务通知更新都在主线程，不需要额外 post。
- `status` 快照里的计数字节按 **桥负载字节** 计（不含 7 字节 BLE 头）；`txDrop`/`rxDrop` 按
  「丢弃的消息/包」计数。计数字段自 `start()` 起累计。
- 页面若需实时计数，请定时调用 `status`（事件只在链路状态变化时推送，避免每包都发 Channel）。

## 与 spec 的补充约定（未改协议，只是未写死的细节）

1. `status.ble.device` 在未连接时为 `null`（不是空对象）。
2. `ble.state` 语义：`connecting` 覆盖 connect/MTU/discover/CCCD 全过程；CCCD 写入成功即
   `ready`。`bridge.connected` 独立表示 WS。只有两者都就绪才转发。
3. `bridge.reconnects` 计 WS 重连次数（含 BLE 链路重建后重新打开 WS）。
4. `configure {enabled:true}` 与 `start` 等价（都会申请定位权限并启动服务）；
   `configure` 的 `enabled` 未给出时只保存地址/前缀并 `applyConfig()`，不会因缺权限而启动服务。
5. 通知 action「停止」会把 `enabled` 一并置 false（下次引擎启动不会自动再起服务）。
6. `scan` 在服务未启动时也可用（只列设备，报告后即止，不进入网关状态机）；`connect` 要求服务
   已启动（`start` / `configure{enabled:true}` 之后），否则 `{ok:false}` 且 `lastError` 可读。
7. 蓝牙名匹配：`devicePrefix` 为空时接受任何广播本服务的设备；非空时按前缀（忽略大小写）匹配。
8. MTU < 100 视为不可用（16 KiB 消息放不进 255 片），会断开并按退避重连并报
   `lastError = "MTU 过小 (N)，至少需要 100"`。
9. 通知文案在 Kotlin 里中英双语硬编码（`AppStrings.isEnglish`），未进 `strings.xml`：
   spec §10.5 明确 v1 不引入 l10n 生成链，避免动资源文件与生成物。

## 明确未验证（本机没有 Flutter / Gradle / 真机）

- 未编译：本修改集没有任何 `flutter analyze` / `gradle assemble` 结果。**必须在有 Flutter 的机器上
  先编译**，再谈真机。
- 未跑 Android 单元测试：上游 `src/test` 里的 JVM 测试没有覆盖这些新类； `ProcessLaunchGuardTest`
  会扫描应用源码中 `ProcessBuilder` 的使用，本次新增文件没有引入新的进程启动，理论上不受影响，
  但同样未运行。
- 未真机验证：BLE 扫描/连接/MTU/CCCD/通知/前台服务/后台保活全部未在设备上跑过。
  真机步骤见 `dsh-go-ble/README.md`（T5 汇总）与本文末尾。
- 未验证项清单：`requestMtu(247)` 在目标机型上的实际协商值；`WRITE_TYPE_NO_RESPONSE` 是否回调
  `onCharacteristicWrite`（两种路径都实现了，任一到即工作）；`specialUse` FGS 在国产 ROM 上的
  后台启动限制；App 与 PRoot 共享 127.0.0.1 的实际连通性（spec §14 已给结论，但未在本机复测）。

## 真机最小验收步骤（原生侧）

1. 打开设置页开关 → 系统弹定位权限 → 允许；状态 `service=running`，通知「鲸鲸蓝牙」出现。
2. 设备上电广播 `Jingjing-XXXX`；页面扫描能看到该设备；连接后 `ble.state=ready`、
   `device.mtu≥100`、`bridge.connected=true`。
3. 通知 停止 → 服务与 BLE 断开；重开开关能恢复。
4. 引擎停止（设置页停引擎）→ 通知消失、`status.engine=stopped`；重新启动引擎且开关 on → 服务自动
   回来、`status.engine=running`。
5. 关蓝牙 → `status.adapter=off`，`start` 返回 `ok=false` 且 `lastError` 可读。
