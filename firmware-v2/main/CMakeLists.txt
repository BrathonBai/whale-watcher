cmake_minimum_required(VERSION 3.16)
# 2026-11-13 v0.4：设备固件**取消 WiFi / PC 桥，只保留 BLE**（用户要求）。
# 删除 net_wifi / ws_client / ws_frame / bridge_find / nvs_creds 及 WiFi 编译宏；
# 传输门面 link 现在只起 NimBLE（link_ble.cc）。
idf_component_register(SRCS "app_main.cc" "app_ui.cc" "adpcm.cc" "audio.cc" "audio_dec.cc" "board_lcd.cc" "camera.cc" "clip_player.cc" "console.cc" "input.cc" "led.cc" "link.cc" "link_ble.cc" "mp3_player.cc" "proto.cc" "render.cc" "storage.cc" "pet_voice.cc" "text_draw.cc" "touch_input.cc"
                       INCLUDE_DIRS "."
                       REQUIRES minimp3 micro-opus esp_timer esp_event esp_partition sensecap-watcher
                                nvs_flash esp_driver_i2s esp_driver_gpio
                                esp_driver_spi esp_driver_ledc esp_lcd esp_lcd_touch esp_lcd_touch_spd2010 esp_driver_sdmmc
                                sdmmc fatfs vfs
                                # 2026-11-13：NimBLE（sdkconfig 里 CONFIG_BT_NIMBLE_ENABLED）+ 串口行命令
                                bt esp_driver_uart esp_driver_usb_serial_jtag)
# micro-opus：vendored 组件在 ../components/micro-opus（v0.4.1，来源/裁剪见其 VENDORED.md）。
# 只用到上游 libopus 的 C API（opus_decoder_create/opus_decode）；Ogg 容器层未使用，
# 但组件会整体编译（含编码器），后续若要省 flash 可裁 sources.cmake（见迭代文档）。
# 三段动画内嵌（和 v1 一致：idle/look/wave）
target_add_binary_data(${COMPONENT_LIB} "pet_idle.bin" BINARY)
target_add_binary_data(${COMPONENT_LIB} "pet_look.bin" BINARY)
target_add_binary_data(${COMPONENT_LIB} "pet_wave.bin" BINARY)
# 2026-11-03 摸摸头互动动画（v1 归档同格式素材：happy/tickle/shy）
target_add_binary_data(${COMPONENT_LIB} "pet_happy.bin" BINARY)
target_add_binary_data(${COMPONENT_LIB} "pet_tickle.bin" BINARY)
target_add_binary_data(${COMPONENT_LIB} "pet_shy.bin" BINARY)
# 2026-11-04 摸摸头本地短音效（24 kHz/mono/s16le，tools/make_pet_voice.py 生成）
target_add_binary_data(${COMPONENT_LIB} "voice_pet_hey.pcm" BINARY)
target_add_binary_data(${COMPONENT_LIB} "voice_pet_nice.pcm" BINARY)
target_add_binary_data(${COMPONENT_LIB} "voice_pet_again.pcm" BINARY)
target_add_binary_data(${COMPONENT_LIB} "voice_pet_itch.pcm" BINARY)
target_add_binary_data(${COMPONENT_LIB} "voice_pet_best.pcm" BINARY)

# 逐帧音频探针（默认关）：排查"卡顿是链路慢还是设备慢"时开成 1
set(HUB_AUDIO_PROBE 0 CACHE STRING "逐帧打印音频到达/入队耗时（1=开）")
target_compile_definitions(${COMPONENT_LIB} PRIVATE HUB_AUDIO_PROBE=${HUB_AUDIO_PROBE})
