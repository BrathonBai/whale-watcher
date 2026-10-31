cmake_minimum_required(VERSION 3.16)
idf_component_register(SRCS "app_main.cc" "app_ui.cc" "audio.cc" "board_lcd.cc" "bridge_find.cc" "camera.cc" "clip_player.cc" "input.cc" "led.cc" "net_wifi.cc" "nvs_creds.cc" "proto.cc" "render.cc" "text_draw.cc" "ws_client.cc" "ws_frame.cc"
                       INCLUDE_DIRS ".")
# 三段动画内嵌（和 v1 一致：idle/look/wave）
target_add_binary_data(${COMPONENT_LIB} "pet_idle.bin" BINARY)
target_add_binary_data(${COMPONENT_LIB} "pet_look.bin" BINARY)
target_add_binary_data(${COMPONENT_LIB} "pet_wave.bin" BINARY)

# ---------------------------------------------------------------------------
# WiFi 凭据**不进源码**。优先级（高 → 低）：
#   ① 设备 NVS（串口 `>wifi SSID PASS` 配过的）
#   ② main/wifi_local.h（本机文件，已被 .gitignore 忽略，模板见 wifi_local.h.example）
#   ③ 本处 -D 宏（idf.py -DHUB_WIFI_SSID=... -DHUB_WIFI_PASS=... build）
# 三者都没有时设备会打印"没有任何 WiFi 凭据"并停在待机界面。
# ---------------------------------------------------------------------------
set(HUB_WIFI_SSID "" CACHE STRING "WiFi SSID（留空 = 用设备 NVS 或 wifi_local.h）")
set(HUB_WIFI_PASS "" CACHE STRING "WiFi 密码")
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    CONFIG_HUB_WIFI_SSID="${HUB_WIFI_SSID}"
    CONFIG_HUB_WIFI_PASS="${HUB_WIFI_PASS}")

# 逐帧音频探针（默认关）：排查"卡顿是链路慢还是设备慢"时开成 1
set(HUB_AUDIO_PROBE 0 CACHE STRING "逐帧打印音频到达/入队耗时（1=开）")
target_compile_definitions(${COMPONENT_LIB} PRIVATE HUB_AUDIO_PROBE=${HUB_AUDIO_PROBE})

# 桥地址在 wifi_local.h 里（HUB_BRIDGE_URL_LOCAL）。设备开机还会 UDP 广播找桥，
# 所以换网后即使 IP 变了也能自己找到；没有该文件时靠广播 + 默认端口。
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/wifi_local.h")
    message(STATUS "hub: 找到 main/wifi_local.h（本机 WiFi + 桥地址）")
else()
    message(STATUS "hub: 没有 main/wifi_local.h —— 将只靠设备 NVS 凭据 + 开机广播找桥")
endif()
