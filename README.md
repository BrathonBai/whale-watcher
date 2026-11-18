# 鲸鲸 · 具身 Watcher

给 DeepSeek Harness 做一个能看、能听、能说的硬件端：**SenseCAP Watcher（ESP32-S3，412×412 圆屏，麦克风 / 喇叭 / 摄像头）**。
设备通过 BLE 连接手机上的 DSH 宿主，由 `bridge/` 插件把设备接到 DSH 会话与模型。

## 组成

| 路径 | 内容 |
|---|---|
| `firmware-v2/` | ESP-IDF 5.5 固件：BLE 传输、ADPCM 音频、屏幕 UI、摄像头；`main/` 为自有代码，`components/` / `managed_components/` 为随仓库携带的依赖 |
| `bridge/` | DSH 插件 `dsh-embodied-bridge`：WebSocket 设备协议、音频上下行、TTS/ASR、设备工具与面板 |
| `docs/` | 协议、圆屏显示、排障与硬件说明文档 |

## 快速开始

### 固件

前置：ESP-IDF **5.5**、Python 环境、SenseCAP Watcher、USB 串口。

```powershell
cd firmware-v2
idf.py set-target esp32s3
idf.py build
python -m esptool --chip esp32s3 -p COM6 -b 921600 write_flash 0x200000 build\hub_v2.bin
```

构建与烧录的更多说明见 `firmware-v2/README.md`。

### 桥 / DSH 插件

```powershell
cd bridge
npm test
# 安装为 DSH 插件；语音需要 DeepSeek API key（不配置则自动回退旧引擎）
$env:DEEPSEEK_API_KEY = "<your-key>"
```

`bridge/` 是一个标准 DSH Host bundle。可在 DSH 的 **Plugins → Add plugin** 选择该目录，或让 `plugin_manager`
的 `install_bundle` 指向该目录；也可以 `cd bridge && npm pack` 后安装本地 tarball。
插件启动后默认监听 `127.0.0.1:7788`，面板 `/panel`，健康检查 `/health`。

## 加入 DSH 插件社区

- GitHub topic：**[dsh-plugin](https://github.com/topics/dsh-plugin)** · `deepseek-harness` · `cordis`
- 插件打包产物：[`dsh-embodied-bridge-0.4.0.tgz`](https://github.com/BrathonBai/whale-watcher/releases/tag/dsh-embodied-bridge-v0.4.0)
- 设备固件与插件协议分别见 `firmware-v2/` 和 `bridge/README.md`

## 文档

- 设备 ⇄ 桥的协议契约：`docs/协议-v2-契约.md`
- 412 圆屏 UI 模板：`docs/圆屏显示模板-412.md`
- 排障手册：`docs/故障手册-2026-10-31.md`

## 第三方

`firmware-v2/components`、`managed_components` 包含 vendored 第三方依赖（Seeed BSP、LVGL、Espressif 组件、micro-opus 等），
来源与许可见各组件目录及 `THIRD_PARTY.md`。
