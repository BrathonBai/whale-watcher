#Requires -Version 5.1
<#
.SYNOPSIS
  编译并刷写鲸鲸 v2 固件（会问你 WiFi 与桥地址，写本机 wifi_local.h）。

.DESCRIPTION
  必须用**纯 ASCII 路径**做构建目录（中文路径会让 ESP-IDF 的 kconfig 生成失败）。
  默认构建目录： %LOCALAPPDATA%\hubdev\v2

  做四件事：
    1) 把 firmware/ 复制到构建目录（/MIR）
    2) 按你的回答生成 main/wifi_local.h（SSID / 密码 / 桥地址，不进发布包）
    3) idf.py build
    4) esptool 写入 0xe00000（ota_1 分区），波特率 921600

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\flash-firmware.ps1 -Ssid "MyWiFi" -WifiPass "12345678" -Port COM6
#>
param(
  [string]$Ssid = '',
  [string]$WifiPass = '',
  [string]$BridgeHost = '',
  [int]$BridgePort = 7788,
  [string]$ComPort = 'COM6',
  [string]$BuildDir = (Join-Path $env:LOCALAPPDATA 'hubdev\v2'),
  [string]$IdfPath = 'C:\Espressif\v5.5\esp-idf',
  [string]$IdfToolsPath = 'C:\Espressif',
  [string]$PyExe = 'C:\Espressif\python_env\idf5.5_py3.11_env\Scripts\python.exe',
  [int]$Baud = 921600,
  # 只做到「生成 wifi_local.h」为止，不编译不刷写（用来检查参数/路径是否正确）
  [switch]$DryRun,
  # 第三方依赖不在时，交给 fetch-deps 从哪里取（留空 = 联网 clone）
  [string]$Upstream = '',
  [string]$LvglDir = ''
)

$ErrorActionPreference = 'Stop'
function Ask($q, $default) {
  $a = Read-Host ("{0}{1}" -f $q, $(if ($default) { " [$default]" } else { '' }))
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim()
}

$src = Join-Path (Split-Path -Parent $PSScriptRoot) 'firmware'
if (-not (Test-Path (Join-Path $src 'CMakeLists.txt'))) { throw "找不到固件源码：$src" }

# 第三方组件不在（GitHub 仓库版就是这种情况）→ 先补依赖
if (-not (Test-Path (Join-Path $src 'components\sensecap-watcher\CMakeLists.txt'))) {
  Write-Host "`n第三方组件不在，先拉依赖（LVGL + Seeed BSP）…" -ForegroundColor Yellow
  $fetch = Join-Path $PSScriptRoot 'fetch-deps.ps1'
  if (-not (Test-Path $fetch)) { throw "缺 install/fetch-deps.ps1；或用 with-deps 发布包" }
  $fetchArgs = @('-FirmwareDir', $src)
  if ($Upstream) { $fetchArgs += @('-Upstream', $Upstream) }
  if ($LvglDir) { $fetchArgs += @('-LvglDir', $LvglDir) }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $fetch @fetchArgs
  if (-not (Test-Path (Join-Path $src 'components\sensecap-watcher\CMakeLists.txt'))) {
    throw "依赖还没补上：请手动跑 install\fetch-deps.ps1（可加 -Upstream/-LvglDir 走离线）"
  }
}

# 纯 ASCII 校验（这是硬性要求，中文路径会让 kconfig 生成失败）
if ($BuildDir -match '[^\x20-\x7E]') {
  throw "构建目录必须是纯 ASCII：$BuildDir（例如 C:\Users\你\AppData\Local\hubdev\v2 这种含中文的路径不行，改用 C:\hub\v2）"
}
if (-not (Test-Path $IdfPath)) {
  throw "找不到 ESP-IDF：$IdfPath（用 -IdfPath 指定，例如 C:\Espressif\v5.5\esp-idf）"
}
if (-not (Test-Path $PyExe)) {
  $PyExe = Ask "找不到 IDF 的 python，请给路径（里面有 esptool）" ''
  if (-not (Test-Path $PyExe)) { throw "python 不可用：$PyExe" }
}

Write-Host "`n=== 1/4 网络参数 ===" -ForegroundColor Cyan
if (-not $Ssid) { $Ssid = Ask "WiFi 名称 (SSID)" '' }
if (-not $WifiPass) { $WifiPass = Ask "WiFi 密码（开放网络直接回车）" '' }
if (-not $BridgeHost) {
  $guess = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Select-Object -First 1 -ExpandProperty IPAddress)
  $BridgeHost = Ask "跑 DSH 的这台电脑的局域网 IP（设备要连它）" $guess
}
if (-not $Ssid) { throw "WiFi 没给，设备连不上" }
if (-not $BridgeHost) { throw "桥地址没给" }

Write-Host "`n=== 2/4 同步到构建目录（必须 ASCII） ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
robocopy $src $BuildDir /MIR /XD build .git /XF sdkconfig.old /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制失败（robocopy $LASTEXITCODE）" }
Write-Host "源码 -> $BuildDir" -ForegroundColor Green

Write-Host "`n=== 3/4 写 wifi_local.h ===" -ForegroundColor Cyan
$hdr = @"
// 由 install/flash-firmware.ps1 生成（不要提交、不要外发）
#define HUB_WIFI_LOCAL_SSID "$Ssid"
#define HUB_WIFI_LOCAL_PASS "$WifiPass"
#define HUB_BRIDGE_URL_LOCAL "ws://${BridgeHost}:${BridgePort}/device"
"@
$hdrPath = Join-Path $BuildDir 'main\wifi_local.h'
Set-Content -LiteralPath $hdrPath -Value $hdr -Encoding UTF8
Write-Host "写入 $hdrPath" -ForegroundColor Green

if ($DryRun) {
  Write-Host "`n[DryRun] 到此为止：没有编译、没有刷写。" -ForegroundColor Yellow
  Write-Host "  检查生成的头文件：$hdrPath"
  Write-Host "  确认无误后去掉 -DryRun 重跑即可。"
  return
}

Write-Host "`n=== 4/4 编译 + 刷写 ===" -ForegroundColor Cyan
$env:IDF_TOOLS_PATH = $IdfToolsPath
$env:IDF_PATH = $IdfPath
& (Join-Path $IdfPath 'export.ps1') *> $null
Push-Location $BuildDir
try {
  idf.py build
  if ($LASTEXITCODE -ne 0) { throw "编译失败（看上面报错）" }
  $bin = Join-Path $BuildDir 'build\hub_v2.bin'
  if (-not (Test-Path $bin)) { throw "没有产物：$bin" }
  & $PyExe -m esptool --chip esp32s3 -p $ComPort -b $Baud --before default_reset --after hard_reset write_flash 0xe00000 $bin
  if ($LASTEXITCODE -ne 0) { throw "刷写失败（串口对吗？$ComPort）" }
} finally { Pop-Location }

Write-Host "`n=== 刷完了 ===" -ForegroundColor Cyan
Write-Host "1) 串口 115200 打开（不要用会拉 DTR/RTS 的工具，否则会自动复位）："
Write-Host "     python .\install\serial_tap.py --port $ComPort --seconds 30"
Write-Host "   期望看到： WiFi 省电 → 关 / 网络就绪 / ws: 已连接 ${BridgeHost}:${BridgePort}"
Write-Host "   设备上线后桥的 /health 里 device.online=true，fw=hub_v2 ver=0.2"
Write-Host "2) 如果一直连不上：确认电脑防火墙放行 $BridgePort/tcp 与 $($BridgePort+1)/udp（桥用 UDP 广播被设备发现）"
Write-Host "3) 麦克风/喇叭自检：按一下设备上的按键说话，桥会把语音落盘并识别"
