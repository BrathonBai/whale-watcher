# firmware/ —— 只放本项目自己的代码

```
main/                 本项目写的应用层（38 个文件）
  app_main.cc         启动顺序、任务优先级
  app_ui.cc           按键/录音/下行分发/环形缓冲写入、桌宠与对话框
  audio.cc            I2S 播放、12 s 环形缓冲、AudioTask
  camera.cc           按需拍照（不周期采集）
  proto.cc/.h         协议编解码（上行 4 / 下行 7）
  ws_client.cc/.h     WebSocket 客户端（RFC 6455，掩码、分片、kReadBuf 32 KB）
  ws_frame.cc/.h      帧编解码
  bridge_find.cc/.h   UDP 广播自动找桥
  net_wifi.cc/.h      WiFi 连接与凭据来源（NVS > wifi_local.h > -D 宏）
  nvs_creds.cc/.h     读小智时代遗留的 nvs.net80211 凭据
  board_lcd.cc        面板/背光（基于 Seeed BSP）
  render.cc / text_draw.cc / clip_player.cc   412×412 渲染、中文字形、三段动画
  input.cc/led.cc     旋钮+按键、RGB 灯
  pet_{idle,look,wave}.bin   内嵌动画（target_add_binary_data）
patches/cmake-idf55/  IDF 5.5 下必须替换的 5 个第三方 CMakeLists（见下）
patches/README.md     为什么需要这些补丁
partitions.csv        ota_0 @0x200000 / ota_1 @0xe00000（各 12 MB）
sdkconfig.defaults    工程配置基线（sdkconfig 由它生成）
sdkconfig             我们实测过的完整配置（可直接用）
main/idf_component.yml 8 个 Espressif 组件（版本已锁）
dependencies.lock     上述组件的解析结果
```

**这些依赖已经随仓库提供**（`components/` 7 个 BSP 组件 + LVGL 8.4；`managed_components/` 8 个
Espressif 组件），所以 clone 下来直接 `idf.py build` 即可，**不需要联网也不需要补依赖**：

| 依赖 | 来源 | 谁在用 |
| --- | --- | --- |
| `components/sensecap-watcher`、`esp_io_expander_pca95xx_16bit`、`esp_lcd_touch_chsc6x`、`esp_jpeg_simd`、`esp_lvgl_port`、`knob`、`sscma_client` | [Seeed-Studio/SenseCAP-Watcher-Firmware](https://github.com/Seeed-Studio/SenseCAP-Watcher-Firmware) 的 `components/` | 屏/触摸/音频/IO 扩展/摄像头 |
| `components/lvgl` | [lvgl/lvgl](https://github.com/lvgl/lvgl) **v8.4.0** | 412×412 渲染 |
| `managed_components/*`（8 个） | Component Registry（版本见 `dependencies.lock`） | codec / LCD touch / LED 等 |

> 想升级或重新取上游：`install/fetch-deps.ps1` 会重新克隆并自动打下面的补丁。
> 它也会覆盖 `components/`，所以平时**不用跑**。

## 为什么要 5 个补丁

上游组件的 CMakeLists 是给老 IDF 写的，在 **IDF 5.5** 下会失败：

| 组件 | 上游写法的问题 | 补丁做的事 |
| --- | --- | --- |
| `knob` | `include(package_manager)` / `cu_pkg_define_version()` 在 5.5 已移除 | 注释掉，版本宏本地定义 |
| `sensecap-watcher` | 依赖 `esp_lcd_spd2010`、`esp_io_expander` 等未声明 | 显式 `idf_component_get_property` + `target_link_libraries` |
| `esp_lcd_touch_chsc6x` | 依赖 `espressif__esp_lcd_touch` 未声明 | 同上，并加 `-Wno-incompatible-pointer-types` |
| `esp_lvgl_port` | 可选依赖判断用的是旧组件名 | 补 `espressif__` 前缀判断 |
| `sscma_client` | IDF 6 分支的 `espressif__cjson` 判断缺失 | 补版本判断 |

`fetch-deps.ps1` 会在复制完组件后用 `patches/cmake-idf55/*__CMakeLists.txt` 覆盖对应文件。
若你想自己从上游重来一遍（而不是用仓库里已打补丁的版本），按这个顺序：

```powershell
# 1) 可选：重新取依赖并打补丁
powershell -ExecutionPolicy Bypass -File ..\install\fetch-deps.ps1
```

## 构建（clone 下来就能编）

```powershell
cd firmware
idf.py -B C:\hub\build -DIDF_TARGET=esp32s3 build
```

> 构建目录必须纯 ASCII（中文路径会让 kconfig 生成失败）；改完要刷机见 `install/flash-firmware.ps1`。
