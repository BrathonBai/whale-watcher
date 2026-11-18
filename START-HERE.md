# 从这里开始

> 一句话：Watcher 设备 **BLE 直连手机**，手机里的 DSH 桥把设备接到 DeepSeek Harness 的会话/模型；固件已去 WiFi，语音层已切 DeepSeek 官方 ASR/TTS。

## 先看哪里

1. **项目总览 / 快速开始**：[`README.md`](README.md)
2. **协议与设计**：[`docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md`](docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md)
3. **真机结果 / 已知限制 / 回滚**：[`docs/蓝牙直连dsh-go-交付报告-2026-11-13.md`](docs/蓝牙直连dsh-go-交付报告-2026-11-13.md)
4. **固件**：`firmware-v2/`（ESP-IDF 5.5，BLE-only v0.4）
5. **桥**：`bridge/`（DSH 插件、协议、ADPCM、DeepSeek/Edge TTS、ASR）
6. **手机 App 覆盖集**：`dsh-go-ble/`（含 `apply.ps1` 与 README）
7. **协议契约**：`docs/协议-v2-契约.md`

## 当前状态

- ✅ 固件 v0.4：BLE-only，真机 BLE/桥/`say`/`shot` 跑通；`[mem] after-app` 内部 free 119 KB
- ✅ 桥：107 条测试 + 端到端/audit 通过；DeepSeek TTS 已真机出声，真实 ASR 已用 API/桥模块验证
- ✅ dsh-Go 覆盖集：可编译、安装、BLE 自动连接、桥 online
- ⬜ 设备 mic → 桥 ASR 的真机段（按设备键说话）
- ⬜ 完整语音对话（需要 dsh-Go 登录/模型 provider）
- ⬜ 官方 1.1.0 的长期适配（见 fork：https://github.com/BrathonBai/dsh-Go 的 `feat/whale-ble-gateway`）

## 历史

早期 v1/v2 的迭代、审计、踩坑记录都在 `docs/`；`docs/archive/` 里是已经不再维护的旧方案。
