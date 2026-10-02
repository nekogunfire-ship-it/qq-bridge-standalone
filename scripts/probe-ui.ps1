# probe-ui.ps1 —— 提权跑一次 UI 探针，把界面截图与几何数据落盘。
#
# 为什么需要提权：本机 electron.exe 只能以管理员身份运行（非提权一律 0x80000003、零输出，
# 连 --version 都失败）。所以这个脚本自己检查权限，必要时用 -Verb RunAs 重启自身。
#
# 做什么：
#   1. 置 QB_UI_PROBE=1（desktop/main.mjs 见到它就进入探针模式）
#   2. 用 desktop/start.mjs 拉起应用（它负责净化环境变量、清缓存、指定 userData）
#   3. 探针自动：切到三个分区各截一张图 + 采集几何/DOM/依赖装配，然后退出
#   4. 打印最新报告
#
# 用法:  powershell -ExecutionPolicy Bypass -File scripts\probe-ui.ps1
# 产物:  state\ui-probe\<时间戳>\  (overview.png / monitor.png / settings.png / report.txt / report.json)

[CmdletBinding()]
param(
  [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# ── 1. 权限检查 ──────────────────────────────────────────────────────────────
$isAdmin = $false
try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch {}
if (-not $isAdmin) {
  if ($NoElevate) {
    Write-Host "❌ 未提权，且指定了 -NoElevate。electron.exe 在非提权下无法运行。" -ForegroundColor Red
    exit 1
  }
  Write-Host "需要管理员权限（本机 electron.exe 只能提权运行）。正在请求提权…" -ForegroundColor Yellow
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    ) -ErrorAction Stop
    Write-Host "已发起提权请求（会弹 UAC）。请在管理员窗口里查看结果。" -ForegroundColor Cyan
    exit 0
  } catch {
    Write-Host "❌ 提权失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "   请右键本脚本 → 以管理员身份运行。" -ForegroundColor Yellow
    exit 1
  }
}

Write-Host "=== UI 探针 ===" -ForegroundColor Cyan
Write-Host "  仓库：$Root"
Write-Host "  模式：QB_UI_PROBE=1（截图 + 几何采集后自动退出）"
Write-Host ""

# ── 2. 记录探针前已有的产物，便于之后挑出新的 ────────────────────────────────
$probeRoot = Join-Path $Root 'state\ui-probe'
$before = @()
if (Test-Path $probeRoot) { $before = @(Get-ChildItem $probeRoot -Directory | Select-Object -ExpandProperty Name) }

# ── 3. 拉起应用（探针会自己退出）────────────────────────────────────────────
$env:QB_UI_PROBE = '1'
$startScript = Join-Path $Root 'desktop\start.mjs'
if (-not (Test-Path $startScript)) {
  Write-Host "❌ 找不到 $startScript" -ForegroundColor Red
  exit 1
}

# 关键：探针必须用**独立的 userData 目录**。
#   main.mjs 用了 app.requestSingleInstanceLock()，共用 userData 时第二个实例会被
#   直接拒掉（实测症状：desktop.log 只有一行"启动中"就再无下文，探针目录根本不产生）。
#   这里用纯 ASCII 的临时目录，顺带避开"中文路径下 Electron 静默失败"这个已知坑。
$probeUserData = Join-Path $env:TEMP 'qb-ui-probe-profile'
if (Test-Path $probeUserData) { Remove-Item $probeUserData -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $probeUserData -Force | Out-Null
Write-Host "  探针用 userData：$probeUserData（独立，避开单实例锁）"

Write-Host "正在启动 Electron（探针跑完会自动退出，约 20~40 秒）…" -ForegroundColor Yellow
$env:QB_USER_DATA_DIR = $probeUserData
& node $startScript
$code = $LASTEXITCODE
Remove-Item Env:\QB_UI_PROBE -ErrorAction SilentlyContinue
Remove-Item Env:\QB_USER_DATA_DIR -ErrorAction SilentlyContinue
Remove-Item $probeUserData -Recurse -Force -ErrorAction SilentlyContinue

# ── 4. 找最新产物 ───────────────────────────────────────────────────────────
$after = @()
if (Test-Path $probeRoot) { $after = @(Get-ChildItem $probeRoot -Directory | Select-Object -ExpandProperty Name) }
$new = $after | Where-Object { $before -notcontains $_ }

Write-Host ""
if (-not $new) {
  Write-Host "⚠️ 没有产生新的探针目录 —— Electron 可能根本没启动起来。" -ForegroundColor Yellow
  Write-Host "   start.mjs 退出码：$code"
  $log = Join-Path $Root 'state\desktop.log'
  if (Test-Path $log) {
    Write-Host "   state\desktop.log 末尾 15 行："
    Get-Content $log -Tail 15 | ForEach-Object { Write-Host "     $_" }
  }
  exit 1
}

$latest = $new | Sort-Object -Descending | Select-Object -First 1
$dir = Join-Path $probeRoot $latest
Write-Host "✅ 探针完成：$dir" -ForegroundColor Green
Write-Host ""

Write-Host "--- 截图 ---"
Get-ChildItem $dir -Filter *.png | ForEach-Object {
  Write-Host ("   {0}  {1} KB" -f $_.Name, [math]::Round($_.Length / 1KB, 1))
}
Write-Host ""

$report = Join-Path $dir 'report.txt'
if (Test-Path $report) {
  Write-Host "--- 报告（report.txt）---"
  Get-Content $report -Encoding UTF8 | ForEach-Object { Write-Host $_ }
} else {
  Write-Host "⚠️ 没有 report.txt，看 report.json" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "退出码：$code"
