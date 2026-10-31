#Requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-embodied-bridge 插件装进 DSH，并交互式配置（TTS 音色就在这里问）。

.DESCRIPTION
  · 复制 bridge/ 到 %USERPROFILE%\.dsh\plugins\dsh-embodied-bridge（已有则先备份）
  · 问你怎么出声（breeze / edge / sapi / 不出声），逐个问音色与凭据
  · 问听觉（ASR）：server / auto / off
  · 写 %USERPROFILE%\.dsh\plugins-data\embodied-bridge\config.json（**不写进插件目录**）
  · 打印面板地址与重启提示

  凭据只落在本机 config.json，不进仓库、不进发布包、不回显到日志。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-bridge.ps1
  powershell -ExecutionPolicy Bypass -File .\install-bridge.ps1 -Port 7788 -NonInteractive -TtsEngine sapi
#>
param(
  [string]$Source = (Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge'),
  [int]$Port = 7788,
  [ValidateSet('breeze', 'edge', 'sapi', 'off')]
  [string]$TtsEngine = '',
  [string]$BreezeApiKey = '',
  [string]$BreezeVoiceId = '',
  [string]$BreezeModel = 'breeze-tts-2',
  [string]$BreezeProxy = '',
  [string]$SapiVoice = '',
  [ValidateSet('auto', 'server', 'off')]
  [string]$Asr = '',
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
function Ask($q, $default) {
  if ($NonInteractive) { return $default }
  $a = Read-Host ("{0}{1}" -f $q, $(if ($default) { " [$default]" } else { '' }))
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim()
}
function NewToken { 'eb_' + ([Convert]::ToBase64String((1..18 | ForEach-Object { Get-Random -Max 256 })) -replace '\+', '-' -replace '/', '_' -replace '=', '') }

$dsh = Join-Path $env:USERPROFILE '.dsh'
$plugins = Join-Path $dsh 'plugins'
$dataDir = Join-Path $dsh 'plugins-data\embodied-bridge'
$dest = Join-Path $plugins 'dsh-embodied-bridge'

if (-not (Test-Path (Join-Path $Source 'package.json'))) {
  throw "找不到插件源码：$Source（应该在发布包的 bridge/ 目录）"
}

Write-Host "`n=== 1/4 复制插件 ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $plugins, $dataDir | Out-Null
if (Test-Path $dest) {
  $bak = "$dest.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $dest $bak -Recurse -Force
  Write-Host "已有安装，备份到 $bak" -ForegroundColor Yellow
}
robocopy $Source $dest /MIR /XD node_modules .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制失败（robocopy $LASTEXITCODE）" }
Write-Host "已安装到 $dest" -ForegroundColor Green

Write-Host "`n=== 2/4 配置 TTS（怎么出声）===" -ForegroundColor Cyan
if (-not $TtsEngine) {
  Write-Host "  1) breeze  云端,音色最好,要 API Key + Voice ID（推荐）"
  Write-Host "  2) edge    微软在线 TTS，要 Python + ffmpeg，免费但起进程"
  Write-Host "  3) sapi    Windows 自带，离线秒出，机器味"
  Write-Host "  4) off     只要画面，不出声"
  $pick = Ask "选哪个（1-4）" "1"
  $TtsEngine = @{ '1' = 'breeze'; '2' = 'edge'; '3' = 'sapi'; '4' = 'off' }[$pick]
  if (-not $TtsEngine) { $TtsEngine = 'breeze' }
}

$ttsVoice = ''
if ($TtsEngine -eq 'breeze') {
  if (-not $BreezeApiKey)   { $BreezeApiKey   = Ask "Breeze API Key（sk- 或 brz_ 开头，回车跳过=先不出声）" '' }
  if (-not $BreezeVoiceId)  { $BreezeVoiceId  = Ask "音色 Voice ID（例如 voc_xxxxxxxx）" '' }
  $BreezeModel = Ask "模型" $BreezeModel
  $BreezeProxy = Ask "走本地代理？（例如 http://127.0.0.1:7897，直连就回车）" $BreezeProxy
} elseif ($TtsEngine -eq 'edge') {
  $ttsVoice = Ask "edge 音色（如 zh-CN-XiaoxiaoNeural）" 'zh-CN-XiaoxiaoNeural'
} elseif ($TtsEngine -eq 'sapi') {
  $ttsVoice = Ask "SAPI 音色名（留空 = 系统默认）" ''
}

$asrMode = $Asr
if (-not $asrMode) {
  Write-Host "`n=== 3/4 配置 ASR（怎么听）===" -ForegroundColor Cyan
  Write-Host "  1) server  sherpa-onnx 常驻进程（推荐，~0.1 s/句）"
  Write-Host "  2) auto    先试 DSH 自带语音识别，再试命令"
  Write-Host "  3) off     设备只出声、不听"
  $pick = Ask "选哪个（1-3）" "1"
  $asrMode = @{ '1' = 'server'; '2' = 'auto'; '3' = 'off' }[$pick]
  if (-not $asrMode) { $asrMode = 'server' }
}

$asrServerCommand = ''
if ($asrMode -eq 'server') {
  $py  = Ask "Python 解释器（装了 sherpa-onnx 的那个）" ''
  $srv = Ask "asr_server.py 路径" ''
  $mdl = Ask "SenseVoice 模型目录" ''
  if ($py -and $srv -and $mdl) {
    $asrServerCommand = '"{0}" "{1}" --model "{2}" --threads 4' -f $py, $srv, $mdl
  } else {
    Write-Host "路径不全，先按 auto 处理（之后可在 config.json 里补 asrServerCommand）" -ForegroundColor Yellow
    $asrMode = 'auto'
  }
}

Write-Host "`n=== 4/4 写配置 ===" -ForegroundColor Cyan
$brain = Ask "大脑模式 session=设备有独立 DSH 会话 / llm=插件自己调模型" 'session'
$maxReply = Ask "回复字数上限" '120'

$cfg = [ordered]@{
  host = '0.0.0.0'
  port = $Port
  path = '/device'
  brain = $brain
  maxReplyChars = [int]$maxReply
  tts = ($TtsEngine -ne 'off')
  ttsEngine = $(if ($TtsEngine -eq 'off') { 'sapi' } else { $TtsEngine })
  asr = $asrMode
  imageKeep = 20
  voiceKeep = 50
  panel = $true
  panelToken = (NewToken)
}
if ($TtsEngine -eq 'breeze') {
  $cfg.breezeApiKey = $BreezeApiKey
  $cfg.breezeVoiceId = $BreezeVoiceId
  $cfg.breezeModel = $BreezeModel
  $cfg.breezeStream = $true
  $cfg.ttsPreBufferMs = 1000
  if ($BreezeProxy) { $cfg.breezeProxy = $BreezeProxy }
}
if ($ttsVoice) { $cfg.ttsVoice = $ttsVoice }
if ($asrServerCommand) { $cfg.asrServerCommand = $asrServerCommand }

$cfgPath = Join-Path $dataDir 'config.json'
$cfg | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $cfgPath -Encoding UTF8
Write-Host "配置写入 $cfgPath" -ForegroundColor Green

$ok = $true
if ($TtsEngine -eq 'breeze' -and (-not $BreezeApiKey -or -not $BreezeVoiceId)) {
  $ok = $false
  Write-Host "`n注意：Breeze 的 Key/VoiceID 没给全，现在会**无声**（ttsConfigured=false）。" -ForegroundColor Yellow
  Write-Host "      补法：重跑本脚本，或直接改上面那个 config.json 后重启 DSH。" -ForegroundColor Yellow
}

Write-Host "`n=== 装完了 ===" -ForegroundColor Cyan
Write-Host "1) 重启 DSH（插件在启动时加载；不重启看不到新代码/新配置）"
Write-Host "2) 打开面板： http://127.0.0.1:$Port/panel"
Write-Host "3) 健康检查： http://127.0.0.1:$Port/health   —— 看 device.online 和 tts.configured"
Write-Host "4) 设备侧：WiFi 配上、桥地址指到本机 $Port 端口，开机应打印『设备上线 fw=hub_v2』"
if (-not $ok) { Write-Host "`n（回到上面那条黄色提示：先把音色配齐）" -ForegroundColor Yellow }
