# 把 dsh-go-ble 覆盖集应用到一份 dsh-Go 源码树上。
#
# 用法（PowerShell 5.1+ / 7 均可）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-go-ble\apply.ps1 -Target C:\path\to\dsh-go
#   powershell ... -File .\dsh-go-ble\apply.ps1 -Target ... -Check    # 只比对，不写
#   powershell ... -File .\dsh-go-ble\apply.ps1 -Target ... -DryRun   # 打印将要做的事
#   powershell ... -File .\dsh-go-ble\apply.ps1 -Target ... -Force    # 目标文件既不是上游也不是本补丁时仍然覆盖
#
# 覆盖集只包含「新增文件 + 被替换文件的完整内容」，不删目标里的任何文件。
# 应用后用 git diff 就能看清全部改动；回滚 = git checkout .
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [switch]$Check,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$overlay = Join-Path $here 'files'
$manifestPath = Join-Path $here 'files-manifest.json'

if (-not (Test-Path $overlay)) { throw "覆盖集目录不存在：$overlay" }
if (-not (Test-Path $manifestPath)) { throw "缺 files-manifest.json，先运行 node .\dsh-go-ble\tooling\make-manifest.mjs" }

$target = (Resolve-Path $Target).Path
$pubspec = Join-Path $target 'app\pubspec.yaml'
if (-not (Test-Path $pubspec)) { throw "目标不像 dsh-Go 源码树（缺 app\pubspec.yaml）：$target" }
if (-not ((Get-Content $pubspec -Raw) -match '(?m)^name:\s*dsh_app\s*$')) { throw "目标 app\pubspec.yaml 不是 dsh_app，拒绝应用：$pubspec" }

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
function Get-Sha256([string]$path) { (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant() }

$stats = @{ same = 0; added = 0; updated = 0; drift = @(); blocked = @() }
foreach ($e in $manifest.entries) {
  $src = Join-Path $overlay $e.path
  $dst = Join-Path $target $e.path
  $overlaySha = Get-Sha256 $src
  if ($overlaySha -ne $e.overlaySha256) { throw "覆盖集与 manifest 不一致（先重跑 make-manifest.mjs）：$($e.path)" }

  if (-not (Test-Path $dst)) {
    $stats.added++
    if (-not $Check -and -not $DryRun) {
      New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
      Copy-Item $src $dst
    }
    continue
  }
  $dstSha = Get-Sha256 $dst
  if ($dstSha -eq $overlaySha) { $stats.same++; continue }
  if ($e.kind -eq 'added') {
    # 目标里已存在同路径文件（上游未来版本自己加的同名文件，或上一次 apply 留下的旧版）：
    # 默认按 drifted 处理；-Force 时显式覆盖（迭代覆盖集内容时需要）。
    if ($Force) {
      $stats.updated++
      if (-not $Check -and -not $DryRun) { Copy-Item $src $dst -Force }
      continue
    }
    $stats.drift += $e.path
    continue
  }
  if ($dstSha -eq $e.upstreamSha256 -or $Force) {
    $stats.updated++
    if (-not $Check -and -not $DryRun) { Copy-Item $src $dst -Force }
    continue
  }
  $stats.drift += $e.path
}

Write-Host "目标：$target"
Write-Host "覆盖集：$($manifest.counts.total) 个文件（新增 $($manifest.counts.added) / 替换 $($manifest.counts.replaced)）"
Write-Host "结果：已一致 $($stats.same)，将新增 $($stats.added)，将替换 $($stats.updated)，漂移 $($stats.drift.Count)"
if ($stats.drift.Count) {
  Write-Host ''
  Write-Host '以下文件在目标里既不是上游原版、也不是本补丁（可能上游版本不同，或你本地改过）：'
  foreach ($p in $stats.drift) { Write-Host "  ? $p" }
  Write-Host '确认要覆盖请加 -Force；否则先 diff 看看目标改了什么。'
}
if ($Check) {
  if ($stats.drift.Count) { exit 1 }
  Write-Host '检查通过（目标与覆盖集一致或可安全应用）。'
  exit 0
}
if ($DryRun) { Write-Host '（DryRun：没有写任何文件）'; exit 0 }

Write-Host ''
Write-Host '已应用。接下来（必须）：'
Write-Host '  1) cd app && flutter pub get && flutter analyze'
Write-Host '  2) flutter test --update-goldens test/settings test/shell test/landscape   # hub 多一行，goldens 必变'
Write-Host '  3) flutter test'
Write-Host '  4) 生成 APK：bash tooling/build-apk.sh -f arm64   （需要 runtime/out/arm64 运行时资产，见 README）'
Write-Host '回滚：在目标仓库 git checkout -- .  （覆盖集不删文件）'
if ($stats.drift.Count) { exit 1 }
