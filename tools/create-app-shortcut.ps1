# 为「QQ 桥接控制台」（桌面版）创建桌面快捷方式。
#
# ⚠️ 关键一：快捷方式**必须走 start.mjs**，不能直接指向 electron.exe。
#   直接跑 electron.exe 会绕过 start.mjs，而它负责两件必不可少的事：
#     ① 清理 userData 里的缓存子目录；② 用 --user-data-dir 指向项目内的 state\electron-profile。
#   跳过它们就会重现「窗口一闪即退」—— 实测直接跑 electron.exe 退出码 -2147483645，
#   且 state\desktop.log **没有任何新行**（= Electron 在加载应用代码前就已退出）。
#
# 关键二：用 `WindowStyle = 7`（最小化）避免控制台闪出，而不是绕一层 VBS。
#   曾尝试 VBS + WScript.Shell.Run(..., 0, False) 隐藏窗口，但 VBS 需 UTF-16 LE + BOM，
#   且在该环境下 cscript 报错无输出、难以可靠诊断（已放弃该路线并删除相关文件）。
#   现在的做法：目标 node.exe、参数 start.mjs、窗口最小化 —— 启动链路完整，
#   控制台只是收进任务栏不抢焦点，而且这条路径**可被自动化测试验证**。
#
# 可重复运行：已存在则覆盖。
param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$ShortcutName = 'QQ 桥接控制台',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$desktopDir = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktopDir "$ShortcutName.lnk"

if ($Remove) {
  if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force; Write-Host "已删除快捷方式：$lnkPath" }
  else { Write-Host "快捷方式不存在，无需删除：$lnkPath" }
  exit 0
}

$appDir = Join-Path $Root 'desktop'
$startScript = Join-Path $appDir 'start.mjs'
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'

$node = @('D:\DSH\node\node.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) { $node = 'node.exe' }

if (-not (Test-Path $startScript)) { Write-Error "找不到启动脚本：$startScript" }
if (-not (Test-Path $electron)) {
  Write-Error "找不到 Electron：$electron`n请先在 desktop 目录执行 npm install（约 150MB，只需一次）。"
}

$iconCandidates = @(
  (Join-Path $Root 'assets\dsh-0.1.13.ico'),
  'D:\DSH\assets\dsh.ico',
  'D:\DSH\assets\icon.ico'
)
$iconPath = $iconCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $node
$lnk.Arguments = "`"$startScript`""
$lnk.WorkingDirectory = $appDir
$lnk.Description = 'QQ 桥接控制台：一键启停 QQ 机器人服务、自动检查、内嵌网页控制台'
$lnk.WindowStyle = 7
if ($iconPath) { $lnk.IconLocation = "$iconPath,0" }
$lnk.Save()

# ── 设置「以管理员身份运行」标志 ─────────────────────────────────────────────
# 为什么必须提权：本机实测（2026-09-25）非提权上下文**无法执行 electron.exe**——
#   · `electron.exe --version` 退出码 0x80000003（2147483651），零输出；
#     连 ELECTRON_RUN_AS_NODE=1 的纯 Node 模式也可执行失败
#   · 同一上下文里 cmd.exe / node.exe 都正常 → 只有 electron.exe 被拒
#   · 管理员身份下一切正常（实测应用窗口与托盘成功创建）
#   · 已排除：Smart App Control（值为 0=关闭）、CodeIntegrity 事件、Defender（未运行）
# 因此快捷方式必须以管理员身份运行，否则用户双击只会看到"没反应"。
#
# 实现：WScript.Shell 的 Shortcut 对象**不暴露**这个属性，只能改 .lnk 二进制头：
#   ShellLinkHeader 的 LinkFlags 是 offset 0x14 起 4 字节，其中 RunAsAdmin 为
#   第 2 字节（offset 0x15）的 bit5（0x20）。
$bytes = [System.IO.File]::ReadAllBytes($lnkPath)
$bytes[0x15] = $bytes[0x15] -bor 0x20
[System.IO.File]::WriteAllBytes($lnkPath, $bytes)
$runAsAdmin = [bool]([System.IO.File]::ReadAllBytes($lnkPath)[0x15] -band 0x20)

Write-Host "已创建桌面快捷方式："
Write-Host "  位置    : $lnkPath"
Write-Host "  目标    : $node"
Write-Host "  参数    : `"$startScript`"   （净化环境变量 -> 清理缓存 -> 指定 userData -> 启动 Electron）"
Write-Host "  工作目录: $appDir"
Write-Host "  窗口样式: 最小化（7）"
Write-Host "  管理员  : $(if ($runAsAdmin) { '是（RunAsAdmin 标志已设置，双击会弹 UAC）' } else { '否 —— 设置失败！' })"
if ($iconPath) { Write-Host "  图标    : $iconPath" } else { Write-Host "  图标    : (未找到 .ico，使用默认)" }
Write-Host ''
Write-Host '提示：关闭窗口 = 收进托盘；要完全退出，右键托盘图标选「退出」，'
Write-Host '      或点应用内右栏「应用」区的「✕ 退出应用」。'
Write-Host '      若窗口没出现，双击桌面的「诊断-桌面版打不开」。'
