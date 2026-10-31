# 第三方组件与许可证

> 仓库里 **vendored 了第三方依赖**，目的是 clone 下来就能编译（`firmware/components/` 与
> `firmware/managed_components/`）。它们**不是本项目的代码**，版权归各上游，遵循各自许可证；
> 二次分发请保留各目录内的 license 文件。想换成上游最新版，用 `install/fetch-deps.ps1`。

本仓库的**自有代码**（`firmware/main/`、`bridge/`、`install/`、`docs/`）是 MIT，见 `LICENSE`。

## firmware/components/（来自 Seeed-Studio/SenseCAP-Watcher-Firmware）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| `sensecap-watcher` | Seeed 官方 BSP（屏/电源/音频/IO 扩展） | Apache-2.0（`license.txt`） |
| `esp_lcd_touch_chsc6x` | 触摸驱动 | Apache-2.0 |
| `esp_io_expander_pca95xx_16bit` | IO 扩展芯片 | Apache-2.0 |
| `esp_jpeg_simd` | JPEG 解码（含预编译库，发布包**只保留 esp32s3**） | Apache-2.0 |
| `esp_lvgl_port` | LVGL 与 LCD 的胶水层 | Apache-2.0 |
| `knob` | 旋钮（iot_knob，版本宏改为本地定义） | Apache-2.0 |
| `sscma_client` | 摄像头模组通信 | Apache-2.0 |

## firmware/components/lvgl/

**LVGL 8.4.0**（`LVGL_VERSION_MAJOR 8` / `MINOR 4`），MIT，来自 [lvgl/lvgl](https://github.com/lvgl/lvgl)。
Seeed 仓库里它是 submodule，所以用 `fetch-deps.ps1` 单独克隆 `v8.4.0`。
发布包为瘦身**删掉了 `demos/`（57 MB 资源）与 `docs/`**：LVGL 的 CMake 会把 `demos` 当 include 目录，
所以保留了一个只含说明文件的空目录。

## firmware/managed_components/（IDF Component Manager 拉取后 vendored）

`espressif/button`、`cmake_utilities`、`esp_codec_dev`、`esp_io_expander`、
`esp_lcd_spd2010`、`esp_lcd_touch`、`esp_lcd_touch_spd2010`、`led_strip`
—— 均为 **Apache-2.0**，版本见 `firmware/main/idf_component.yml` 与 `firmware/dependencies.lock`。

## 运行时依赖（不随仓库分发）

| 依赖 | 用途 | 许可证 |
| --- | --- | --- |
| ESP-IDF 5.5 | 构建框架 | Apache-2.0 |
| Node.js / DSH | 桥的运行宿主 | 各自许可 |
| sherpa-onnx + SenseVoice 模型 | 本地语音识别（可选） | Apache-2.0 |
| Breeze TTS / edge-tts / Windows SAPI | 语音合成（可选引擎） | 各自服务条款 |

## 音频/表情素材

`firmware/main/pet_*.bin` 是自绘桌宠的三段动画（idle/look/wave），由项目作者生成。
`docs/images/` 下的设备与界面截图由项目作者拍摄/截图。
