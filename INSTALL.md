# 安装详解

两条线：**电脑侧装桥**、**设备侧刷固件**。顺序无所谓，但两端参数要对上（端口、局域网 IP）。

---

## 一、电脑侧：装 DSH 插件

### 1. 跑脚本

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install-bridge.ps1
```

脚本会做四件事，并且**每一项都会问你**：

| 步骤 | 会问什么 | 说明 |
| --- | --- | --- |
| 复制插件 | — | 到 `%USERPROFILE%\.dsh\plugins\dsh-embodied-bridge`，已存在会先备份 |
| **TTS** | 引擎 + 音色 + 凭据 | **必须你选**，见下一节 |
| ASR | server / auto / off | 选 server 要给 python + `asr_server.py` + 模型目录 |
| 写配置 | 端口 / 大脑模式 / 回复字数 | 落到 `%USERPROFILE%\.dsh\plugins-data\embodied-bridge\config.json` |

### 2. TTS 怎么选（这就是"问音色"的地方）

| 引擎 | 好处 | 代价 | 需要填 |
| --- | --- | --- | --- |
| `breeze` | 音色最好、支持指令式表演 | 要联网、要 Key | API Key、**Voice ID**（`voc_xxxxxxxx`）、模型（默认 `breeze-tts-2`）、可选代理 |
| `edge` | 免费、音色自然 | 要 Python + ffmpeg，起两个进程 | 音色名，如 `zh-CN-XiaoxiaoNeural` |
| `sapi` | 离线、秒出 | 机器味 | 音色名（可空） |
| `off` | — | 不出声 | — |

> **Voice ID 不是模型名**：`breeze-tts-2` 是模型，`voc_xxxxxxxx` 才是音色。只有模型没有音色 → 没声音，
> `/health` 里 `tts.configured=false`。先拿不到音色就用 `sapi` 把链路跑通，之后再换。

### 3. 配置优先级（改了没生效先看这里）

```
lib/config.js 的 DEFAULTS  ←  plugins-data/embodied-bridge/config.json  ←  profiles/<名字>/cordis.patch.yml
                                    （脚本写这里）                        （最高，覆盖一切）
```

- 插件自带 `bridge/cordis.patch.yml`（`insert` 一个条目，给默认 host/port/brain），装完即生效。
- 如果你自己的 `~/.dsh/profiles/<名字>/cordis.patch.yml` 里有 `id: embodied-bridge` 的条目，
  **它会盖掉 config.json**。改完要看 `http://127.0.0.1:7788/health` 的 `config` 字段（运行时真值）。
- **改完必须完整重启 DSH**：插件是 ESM，热重载不会重新加载。

### 4. 验证

```powershell
Invoke-RestMethod http://127.0.0.1:7788/health | ConvertTo-Json -Depth 4
```

期望：`ver=2`、`device.online=true`（设备在线时）、`tts.configured=true`、`asr.serverReady=true`（选了 server 时）。

---

## 二、设备侧：刷固件

### 0. 前置

- ESP-IDF **5.5**，默认在 `C:\Espressif\v5.5\esp-idf`（`-IdfPath` 可改）
- esptool：IDF 自带，默认 `C:\Espressif\python_env\idf5.5_py3.11_env\Scripts\python.exe`（`-PyExe` 可改）
- 设备插 USB，确认串口号（设备管理器 / `Get-CimInstance Win32_SerialPort`）

### 1. 跑脚本

```powershell
powershell -ExecutionPolicy Bypass -File .\install\flash-firmware.ps1 -ComPort COM6
```

会问：WiFi SSID / 密码 / 「跑 DSH 的那台电脑的局域网 IP」（脚本会自动猜一个，确认即可）。

然后它做：

1. 把 `firmware/` 同步到构建目录 `%LOCALAPPDATA%\hubdev\v2`（**必须纯 ASCII**，中文路径会让 kconfig 生成失败）
2. 生成 `main/wifi_local.h`（凭据只在本机；模板见 `firmware/main/wifi_local.h.example`）
3. `idf.py build`
4. `esptool write_flash 0xe00000 build\hub_v2.bin`（刷到 `ota_1`，不影响 `ota_0` 的旧固件）

### 2. 看启动日志（115200）

```powershell
python .\install\serial_tap.py --port COM6 --seconds 30
```

期望依次出现：

```
音频就绪 24000 Hz / 音量 ...
WiFi 省电 → 关 (WIFI_PS_NONE): ESP_OK
网络就绪
ws: 已连接 <你的IP>:7788/device
已发 hello
```

桥那边同时出现 `设备上线 fw=hub_v2 board=watcher ver=0.2 cam=1 240x240`。

> 不要用会拉 DTR/RTS 的串口工具看日志，否则一开就复位设备；`serial_tap.py` 已经处理了这一点。

### 3. 连不上怎么办

| 现象 | 处理 |
| --- | --- |
| 日志停在「没有任何 WiFi 凭据」 | `wifi_local.h` 没生成或为空：重跑脚本，或用 `idf.py -DHUB_WIFI_SSID=... -DHUB_WIFI_PASS=... build` |
| 有 IP 但连不上桥 | 电脑防火墙放行 `7788/tcp` 与 `7789/udp`；确认 IP 是**电脑的局域网 IP**而不是 127.0.0.1 |
| 反复重连 | 看是不是 WiFi 省电没关（日志那行 `WIFI_PS_NONE: ESP_OK`）或路由器开了 AP 隔离 |
| 换了网络 | 设备开机先 UDP 广播找桥，一般能自己找到；不行就重刷（改 IP） |

---

## 三、装 skill（可选，给 agent 看）

把 `skills/dsh-embodied-bridge/` 整个目录复制到 `%USERPROFILE%\.dsh\skills\`：

```powershell
Copy-Item .\skills\dsh-embodied-bridge -Destination "$env:USERPROFILE\.dsh\skills\" -Recurse -Force
```

之后在 DSH 里说「把这台设备接进来」之类的，agent 会按 SKILL.md 的步骤走，并且**先问你 TTS 音色**。

---

## 四、日常操作

| 想做什么 | 怎么做 |
| --- | --- |
| 让它说话 | 面板点「说」，或 `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7788/say -ContentType application/json -Body '{"text":"你好"}'` |
| 换表情 | `POST /api/face {"mood":"happy"}`（8 种见 `/moods`） |
| 拍一张 | `POST /shot` → 返回落盘路径；面板 `/shot.jpg` 直接预览 |
| 看存储 | `/health` 的 `storage`：图片保留 20 张、语音 50 段，自动删最旧 |
| 量链路带宽 | `POST /api/linktest?seconds=3`，对照串口 `音频头`→`音频收尾` 的耗时 |
| 改配置 | 改 `plugins-data/embodied-bridge/config.json` 后重启 DSH；或面板 `/api/config`（本机） |

## 五、卸载

```powershell
Remove-Item "$env:USERPROFILE\.dsh\plugins\dsh-embodied-bridge" -Recurse -Force
Remove-Item "$env:USERPROFILE\.dsh\plugins-data\embodied-bridge" -Recurse -Force   # 连历史和存储一起删
```

设备侧要回退，就把旧固件刷回 `ota_0`（本包只写 `ota_1`，原厂/旧固件还在）。
