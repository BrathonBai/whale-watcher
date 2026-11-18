# build-v2.ps1 - build firmware-v2 (ESP32-S3 / ESP-IDF 5.5) from the ASCII build dir.
#
# Why this script exists:
#   * the repo path contains non-ASCII characters, so ESP-IDF cannot build in-place;
#   * the canonical build dir is %LOCALAPPDATA%\hubdev\v2 (a copy of firmware-v2 sources),
#     and its sdkconfig is NEWER than the repo sdkconfig.defaults (coredump/opus/host
#     configs were tuned there), so it must be treated as the runtime baseline;
#   * this script keeps the two in sync (sources + the BLE/NimBLE keys) so `idf.py build`
#     in the build dir picks up the BLE feature without clobbering local tuning.
#
# Usage (from anywhere):
#   pwsh -File firmware-v2/tools/build-v2.ps1
#   pwsh -File firmware-v2/tools/build-v2.ps1 -SizeComponents     # also print size-components
#
# Requirements: ESP-IDF 5.5 at C:\Espressif\v5.5\esp-idf with IDF_TOOLS_PATH=C:\Espressif,
# and the build dir already created by copying firmware-v2 (see docs/蓝牙直连... §12.1).

param(
    [string]$BuildDir = "$env:LOCALAPPDATA\hubdev\v2",
    [string]$IdfPath = 'C:\Espressif\v5.5\esp-idf',
    [string]$ToolsPath = 'C:\Espressif',
    [switch]$SizeComponents
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # ...\firmware-v2
if (-not (Test-Path (Join-Path $repoRoot 'main\app_main.cc'))) {
    throw "firmware-v2 not found (expected main/app_main.cc under $repoRoot)"
}
if (-not (Test-Path (Join-Path $BuildDir 'sdkconfig'))) {
    throw "build dir not found: $BuildDir (copy firmware-v2 there first, see spec 12.1)"
}

# ---------------------------------------------------------------- 1) source sync
Write-Host "[build-v2] sync sources: $repoRoot\main -> $BuildDir\main"
Copy-Item (Join-Path $repoRoot 'main\*') (Join-Path $BuildDir 'main\') -Recurse -Force

# ------------------------------------------------- 2) sync NimBLE keys in sdkconfig
# The build-dir sdkconfig is the runtime baseline; append-only, idempotent.
$sdkconfig = Join-Path $BuildDir 'sdkconfig'
$marker = '# === BLE / NimBLE (firmware-v2 link_ble, appended by build-v2.ps1) ==='
$text = [System.IO.File]::ReadAllText($sdkconfig)
if ($text -notlike "*$marker*") {
    $lines = @(
        '',
        $marker,
        'CONFIG_BT_ENABLED=y',
        'CONFIG_BT_NIMBLE_ENABLED=y',
        '# CONFIG_BT_BLUEDROID_ENABLED is not set',
        'CONFIG_BT_CONTROLLER_ENABLED=y',
        'CONFIG_BT_NIMBLE_ROLE_PERIPHERAL=y',
        '# CONFIG_BT_NIMBLE_ROLE_CENTRAL is not set',
        '# CONFIG_BT_NIMBLE_ROLE_OBSERVER is not set',
        '# CONFIG_BT_NIMBLE_ROLE_BROADCASTER is not set',
        'CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU=247',
        'CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1',
        'CONFIG_BT_NIMBLE_HOST_TASK_STACK_SIZE=4096',
        'CONFIG_BT_NIMBLE_NVS_PERSIST=y',
        'CONFIG_BT_CTRL_BLE_MAX_ACT=2'
    )
    [System.IO.File]::AppendAllText($sdkconfig, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[build-v2] appended NimBLE keys to sdkconfig"
} else {
    Write-Host "[build-v2] sdkconfig already has NimBLE keys"
}

# ---------------------------------------------------------------- 3) build
$env:IDF_TOOLS_PATH = $ToolsPath
. (Join-Path $IdfPath 'export.ps1')
Set-Location $BuildDir
Write-Host "[build-v2] idf.py build in $BuildDir"
idf.py build
if ($LASTEXITCODE -ne 0) { throw "idf.py build failed ($LASTEXITCODE)" }

if ($SizeComponents) {
    idf.py size-components
}
Write-Host "[build-v2] done: $BuildDir\build\hub_v2.bin"
