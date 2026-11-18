# 鲸鲸 · 具身 Watcher（BLE-only 固件 + DSH 桥 + dsh-Go 接入）

给 DeepSeek Harness 做一个能看、能听、能说的硬件端：**SenseCAP Watcher（ESP32-S3，412×412 圆屏，mic / 喇叭 / 摄像头）**。
设备以 **BLE 直连手机**（不再依赖 WiFi），手机里的 DSH 桥接插件负责「设备 ⇄ DSH 会话 / LLM」，手机 App 侧有原生 BLE 网关和设置页。

> 2026-11-18 状态：**固件 v0.4（BLE-only）已真机跑通**；桥已接入 **DeepSeek 官方 ASR/TTS API**；dsh-Go 覆盖集可编译/安装；完整语音对话还差账号登录与设备 mic 上行实测。

## 当前能力

- **设备**：BLE GATT peripheral（`Jingjing-ACB2`，MTU 247），自定义 7 字节分帧；上行/下行 24 kHz 单声道 ADPCM；摄像头 JPEG 分块回传；屏幕桌宠动画/字幕/触摸/按键。
- **固件 v0.4**：已移除 WiFi/WS，内部 free **119 KB**（v0.3 为 34.7 KB），bin 6.5 MB；配网向导改为「蓝牙配对」。
- **桥**：`bridge/` 是 DSH 插件，负责 hello/pong、音频上下行、TTS/ASR、工具与面板；语音层已切 DeepSeek 官方 API（有 `DEEPSEEK_API_KEY` 时默认 DeepSeek，否则回退旧引擎）。
- **手机 App**：`dsh-go-ble/` 是 dsh-Go 1.0.16 覆盖集（原生 BLE 前台服务 + Flutter 设置页 + guest 注入 + 桥 assets）；官方 1.1.0 的适配分支见下方「跟随上游」。

## 目录

| 路径 | 内容 |
|---|---|
| `firmware-v2/` | ESP-IDF 5.5 固件（`hub_v2`）：BLE 传输/编解码/UI/音频/摄像头；`main/` 是自有代码，`components/` + `managed_components/` 为随仓库 vendored 依赖 |
| `bridge/` | DSH 插件 `dsh-embodied-bridge`：WebSocket 服务、设备协议、ADPCM、DeepSeek/Edge TTS、DeepSeek/DSH ASR、面板 |
| `dsh-go-ble/` | dsh-Go 覆盖集（Kotlin BLE 网关 + Flutter 设置页 + guest 注入 + 桥 assets）、`apply.ps1`、manifest、构建/测试说明 |
| `docs/` | 设计/协议/交付报告/迭代/踩坑；建议先看 `docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md` 与 `docs/蓝牙直连dsh-go-交付报告-2026-11-13.md` |
| `START-HERE.md` | 简短的阅读入口与当前状态 |

## 快速开始

### 1. 编译 / 刷固件

前置：ESP-IDF **5.5**、Python 环境、SenseCAP Watcher、USB 串口。

```powershell
# 仓库已 vendored components/managed_components；直接构建
cd firmware-v2
idf.py set-target esp32s3
idf.py build
# 刷到 ota_0（分区表未动）
python -m esptool --chip esp32s3 -p COM6 -b 921600 write_flash 0x200000 build\hub_v2.bin
```

> Windows 路径若含中文，建议把 `firmware-v2` 复制到 ASCII 路径再构建（CMake/kconfig 对非 ASCII 路径不稳）。
> 构建细节、内存坑、sdkconfig 注意事项见 `docs/蓝牙直连dsh-go-交付报告-2026-11-13.md`。

### 2. 装桥 / 跑测试

```powershell
cd bridge
npm test
# 把 bridge/ 作为 DSH 插件安装/加载；DeepSeek 语音需要环境变量：
$env:DEEPSEEK_API_KEY = "sk-..."
```

桥也能在 PC 上独立运行（供调试）：默认监听 `127.0.0.1:7788`，面板 `http://127.0.0.1:7788/panel`，健康检查 `/health`。
没有 key 时 TTS/ASR 自动回退到旧 Edge/DSH 引擎；强制回退见 `bridge/README.md`。

### 3. 手机 App 接入

当前提供 **dsh-go-ble 覆盖集**（基于官方 1.0.16，改包后使用本地签名）：

```powershell
.\dsh-go-ble\apply.ps1 -Target <dsh-Go 源码目录>
# 再按 dsh-go-ble/README.md 构建 APK；安装后 设置 › 能力 › 鲸鲸蓝牙
```

> 注意：覆盖集是「改官方 APK 后重签」，因此和官方 release 签名不一致，装官方新版前需要卸载。
> 长期方案：`dsh-go-ble` 的更新版拆成「官方 App 保持原版 + 标准 DSH 插件 + 独立 BLE 网关 App」，见 `docs/` 与上游 issue。

## 跟随上游 dsh-Go

- Fork：https://github.com/BrathonBai/dsh-Go
- 适配分支：`feat/whale-ble-gateway`
- `main` 每天自动 merge `ccch1mneyyy/dsh-Go:main`（`.github/workflows/sync-upstream.yml`）；上游暂不接受外部 PR，相关讨论在 issue [#1487](https://github.com/ccch1mneyyy/dsh-Go/issues/1487)。

## 协议与证据

- 协议：`docs/协议-v2-契约.md`（由 `bridge/tools/gen-contract-doc.mjs` 生成）
- 设计：`docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md`
- 交付/真机验证：`docs/蓝牙直连dsh-go-交付报告-2026-11-13.md`（§3.6 固件 v0.4、§3.7 DeepSeek 语音、§3.8 UI）
- 固件构建/内存/已知坑：同交付报告与 `docs/迭代-*`

## 安全与隐私

- 仓库**不含** API key、WiFi 密码、设备序列号、真实对话或本机路径。
- 桥的 `plugins-data/`、`config.json`、固件 `wifi_local.h` 等本机文件已被 `.gitignore` 排除。
- 设备 BLE 空口目前**未加密/未绑定**，只适合个人开发环境；生产需加 LE Secure Connections。

## 第三方

`firmware-v2/components`、`managed_components` 为 vendored 第三方依赖（Seeed BSP、LVGL、Espressif 组件、micro-opus 等），来源/许可见各组件目录与 `THIRD_PARTY.md`。
