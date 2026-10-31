#Requires -Version 5.1
<#
.SYNOPSIS
  拉取固件的第三方依赖（Seeed BSP 组件 + LVGL），并打上 IDF 5.5 的 CMake 补丁。

.DESCRIPTION
  仓库里**不包含**第三方源码（LVGL、Seeed 的 BSP 组件等），只包含本项目的 `main/`。
  这个脚本把缺的两块补齐，让 `idf.py build` 能过：

    1) components/        ← Seeed-Studio/SenseCAP-Watcher-Firmware 的 8 个组件
    2) components/lvgl    ← lvgl/lvgl v8.4（Seeed 仓库里是 submodule，不含源码）
    3) 覆盖 5 个 CMakeLists ← 本仓库 patches/cmake-idf55/ 里为 IDF 5.5 改好的版本
       （上游原版在 IDF 5.5 下会报 `package_manager` / 依赖组件找不到）

  `managed_components/` 不用管：`idf.py build` 会按 main/idf_component.yml 自动拉取（8 个
  Espressif 组件，版本已锁在 dependencies.lock）。

.EXAMPLE
  # 联网：自动 clone 上游
  powershell -ExecutionPolicy Bypass -File .\install\fetch-deps.ps1

  # 离线：从已有仓库/拷贝拿（两个路径都必须是含 components/ 的仓库根）
  powershell -ExecutionPolicy Bypass -File .\install\fetch-deps.ps1 `
    -Upstream D:\refs\SenseCAP-Watcher-Firmware -LvglDir D:\refs\lvgl
#>
param(
  [string]$FirmwareDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'firmware'),
  [string]$Upstream = '',
  [string]$LvglDir = '',
  [string]$Repo = 'https://github.com/Seeed-Studio/SenseCAP-Watcher-Firmware.git',
  [string]$LvglRepo = 'https://github.com/lvgl/lvgl.git',
  [string]$LvglTag = 'v8.4.0'
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "  $m" -ForegroundColor DarkGray }
function Ok($m)   { Write-Host "✅ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "⚠️  $m" -ForegroundColor Yellow }

# 这 8 个组件来自 Seeed 的固件仓库（rlottie 本项目不用，不复制）
$COMPONENTS = @(
  'sensecap-watcher',
  'esp_io_expander_pca95xx_16bit',
  'esp_lcd_touch_chsc6x',
  'esp_jpeg_simd',
  'esp_lvgl_port',
  'knob',
  'sscma_client'
)

if (-not (Test-Path (Join-Path $FirmwareDir 'main\CMakeLists.txt'))) {
  throw "找不到固件工程：$FirmwareDir（应为发布包里的 firmware/）"
}
$dest = Join-Path $FirmwareDir 'components'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# ---------- 1. Seeed BSP 组件 ----------
Write-Host "`n=== 1/3 Seeed BSP 组件 ===" -ForegroundColor Cyan
$src = $Upstream
if (-not $src) {
  $tmp = Join-Path $env:TEMP ("seeed-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  Info "git clone --depth 1 $Repo"
  git clone --depth 1 --filter=blob:none --sparse $Repo $tmp 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "clone 失败：$Repo（也可以手动下载后用 -Upstream 指定）" }
  git -C $tmp sparse-checkout set components 2>&1 | Out-Null
  $src = $tmp
}
$srcComp = Join-Path $src 'components'
if (-not (Test-Path $srcComp)) { throw "上游里没有 components/：$srcComp" }
foreach ($c in $COMPONENTS) {
  $from = Join-Path $srcComp $c
  if (-not (Test-Path $from)) { Warn "上游缺组件 $c，跳过"; continue }
  robocopy $from (Join-Path $dest $c) /MIR /XD .git /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  Info "$c"
}
Ok "BSP 组件就绪（$($COMPONENTS.Count) 个）"

# ---------- 2. LVGL 8.4 ----------
Write-Host "`n=== 2/3 LVGL 源码 ===" -ForegroundColor Cyan
$lvDest = Join-Path $dest 'lvgl'
if ($LvglDir) {
  if (-not (Test-Path (Join-Path $LvglDir 'lvgl.h'))) { throw "不是 LVGL 源码目录（缺 lvgl.h）：$LvglDir" }
  robocopy $LvglDir $lvDest /MIR /XD .git .github /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  Info "从本地复制：$LvglDir"
} else {
  $tmpL = Join-Path $env:TEMP ("lvgl-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  Info "git clone --depth 1 -b $LvglTag $LvglRepo"
  git clone --depth 1 -b $LvglTag $LvglRepo $tmpL 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "clone 失败：$LvglRepo $LvglTag" }
  robocopy $tmpL $lvDest /MIR /XD .git .github /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  Info "已克隆 $LvglTag"
}
Ok "LVGL 就绪"

# ---------- 3. IDF 5.5 的 CMake 补丁 ----------
Write-Host "`n=== 3/3 打 IDF 5.5 补丁 ===" -ForegroundColor Cyan
$patchDir = Join-Path $FirmwareDir 'patches\cmake-idf55'
if (-not (Test-Path $patchDir)) { throw "缺补丁目录：$patchDir" }
Get-ChildItem $patchDir -Filter '*__CMakeLists.txt' | ForEach-Object {
  $comp = $_.Name -replace '__CMakeLists\.txt$', ''
  $target = Join-Path $dest "$comp\CMakeLists.txt"
  if (-not (Test-Path (Split-Path $target -Parent))) { Warn "没有 $comp，跳过补丁"; return }
  Copy-Item $_.FullName $target -Force
  Info "$comp/CMakeLists.txt 已覆盖"
}
Ok "补丁打完（5 个）"

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Write-Host "下一步："
Write-Host "  cd firmware"
Write-Host "  idf.py -B build -DIDF_TARGET=esp32s3 build     # managed_components 会自动拉取"
Write-Host "构建目录必须纯 ASCII；Windows 上推荐 %LOCALAPPDATA%\hubdev\v2 之类。"
