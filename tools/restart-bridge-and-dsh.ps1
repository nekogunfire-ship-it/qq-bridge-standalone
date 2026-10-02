# restart-bridge-and-dsh.ps1
# ---------------------------------------------------------------------------
# Make code changes to the QQ bridge / MCP tools actually take effect.
#
# WHY A RESTART IS NEEDED:
#   * src/bridge.js gains HTTP routes that a running process has already
#     loaded -> the bridge must be restarted.
#   * Adding/removing MCP TOOLS additionally needs a DSH restart:
#     @deepseek-ai/dsh-mcp-client holds its stdio connection inside
#     ctx.effect(() => dispose, "mcp-client.connection"), i.e. for the whole
#     Host lifetime, so tools/list cannot see new tools until DSH respawns it.
#     That step is OPT-IN here (-RestartDsh), because it disconnects the web
#     GUI and is pointless once the tool list is already loaded.
#
# WHY DSH IS NOT RESTARTED BY DEFAULT:
#   The project's own launcher keeps it alive on purpose ("DSH is deliberately
#   left running so this never closes the web session in use"), and restarting
#   it on every run just drops the user's web session for no benefit.
#
# WHY NOT JUST tools\qq-bridge-launcher.ps1 -Action restartAll:
#   Same reason - Stop-AllServices never stops DSH, so restartAll alone cannot
#   re-mount MCP tools. This script delegates the bridge restart to that same
#   authoritative launcher (single source of truth for stop/start and for ports
#   from tools\services.json) and only adds the DSH step when asked.
#
# WHY NOT restart.bat's old WMI approach:
#   Its Get-CimInstance-based process scan returns nothing under a restricted
#   token, and the launcher's own Stop-PortOwner fallback then never fires
#   either. The old behaviour was therefore "restart reports success while the
#   old bridge keeps port 3100 and the new instance dies with EADDRINUSE".
#   This script stops the port owner FIRST, deterministically.
#
# ASCII ONLY (Windows PowerShell 5.1 decodes BOM-less .ps1 with the ANSI code
# page, which would corrupt non-ASCII literals).
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  [string]$Root = '',
  [int]$ConsolePort = 0,      # 0 = read from tools\services.json
  [int]$ManagerPort = 0,      # 0 = read from tools\services.json
  [int]$ReadyTimeoutSec = 60,
  [switch]$DryRun,            # verify the script and the wrapper work, change nothing
  [switch]$RestartDsh,        # opt-in: also restart DSH (only needed when the MCP tool LIST changed)
  [switch]$Force,             # with -RestartDsh: restart even if a DSH session looks live
  [switch]$SkipDshRestart     # legacy alias; same meaning as the default now
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
# The .bat passes "%~dp0.." which resolves fine but prints as "...\tools\.." -
# normalize it so the paths shown to the user are clean and comparable.
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$ToolsDir = Join-Path $Root 'tools'
$StateDir = Join-Path $Root 'state'
$Launcher = Join-Path $ToolsDir 'qq-bridge-launcher.ps1'
$Services = Join-Path $ToolsDir 'services.json'
$LockFile = Join-Path $StateDir 'bridge.lock'
$TokenFile = Join-Path $StateDir 'console-token'
$LogFile = Join-Path $StateDir 'bridge.log'
$RuntimeDir = Join-Path $ToolsDir 'runtime'
# Initialised up front so the summary can read it even when step 6 is skipped.
$dshOk = $false
# 是否真的观察到桥接重启（由日志里的「桥接已启动」计数判定，见第 3 步）。
$bridgeRestarted = $false

function Say([string]$m) { Write-Host $m }

# Ports come from the single source of truth rather than being hardcoded here.
if ($ConsolePort -le 0 -or $ManagerPort -le 0) {
  try {
    $svc = Get-Content -LiteralPath $Services -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ConsolePort -le 0) { $ConsolePort = [int]$svc.ports.bridgeConsole }
    if ($ManagerPort -le 0) { $ManagerPort = [int]$svc.ports.dshLauncher }
  } catch {
    if ($ConsolePort -le 0) { $ConsolePort = 3100 }
    if ($ManagerPort -le 0) { $ManagerPort = 3780 }
  }
}

function Test-Port([int]$port, [int]$timeoutMs = 700) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne($timeoutMs) -and $client.Connected) { return $true }
    return $false
  } catch { return $false } finally { try { $client.Close() } catch {} }
}

# Deterministic port-owner discovery: Get-NetTCPConnection first, netstat as the
# fallback for environments where the cmdlet is unavailable.
function Get-PortOwnerPids([int]$port) {
  $pids = New-Object System.Collections.Generic.List[int]
  try {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
    foreach ($c in $conns) { if ($c.OwningProcess -gt 0) { $pids.Add([int]$c.OwningProcess) } }
  } catch {
    try {
      $pattern = ':' + $port + '\s+.*LISTENING\s+(\d+)'
      foreach ($line in (netstat -ano | Select-String -Pattern $pattern)) {
        $m = [regex]::Match($line.Line, $pattern)
        if ($m.Success) { $pids.Add([int]$m.Groups[1].Value) }
      }
    } catch {}
  }
  return ($pids | Sort-Object -Unique)
}

function Stop-PidSafe([int]$procId) {
  try {
    Stop-Process -Id $procId -Force -ErrorAction Stop
    return $true
  } catch {
    try {
      & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
      return ($LASTEXITCODE -eq 0)
    } catch { return $false }
  }
}

function Read-ConsoleToken {
  try {
    if (Test-Path $TokenFile) { return (Get-Content -LiteralPath $TokenFile -Raw).Trim() }
  } catch {}
  return ''
}

Say ''
Say '=== QQ 桥接 + DSH 重启（让新增的画图工具生效）==='
Say ("    桥接控制台端口: $ConsolePort | DSH 管理器端口: $ManagerPort")
Say ("    仓库根目录: $Root")
Say ''
Say '    为什么要同时重启两个：'
Say '      * 桥接要重新加载 src\bridge.js，才有 /api/socialV2/send-image 端点；'
Say '      * DSH 的 MCP 连接挂在 Host 生命周期上（dsh-mcp-client 用 ctx.effect 持有），'
Say '        只有重启 DSH 才会重新 spawn MCP server、挂上新的画图工具。'
Say '    重启期间 QQ 消息由桥接入队，DSH 回来后自动补投，不会丢消息。'
if ($DryRun) {
  Say ''
  Say '    *** DryRun 模式：只做检查，不停进程、不启动、不重启 DSH ***'
}

# -- 1) free the console port deterministically -----------------------------
Say ''
Say '[1/6] 释放桥接控制台端口（端口优先，不用 WMI）...'
$owners = @(Get-PortOwnerPids $ConsolePort)
if ($owners.Count -eq 0) {
  Say "      端口 $ConsolePort 空闲"
} elseif ($DryRun) {
  foreach ($procId in $owners) { Say "      [DryRun] 端口 $ConsolePort 被 PID $procId 占用，本应停止它" }
} else {
  foreach ($procId in $owners) {
    Say ("      端口 $ConsolePort 被 PID $procId 占用 -> 正在停止")
    if (Stop-PidSafe $procId) { Say '      已停止' } else { Say "      [warn] 无法停止 PID $procId" }
  }
}
# A stale lock would make the new instance exit with "already running".
if (-not $DryRun) {
  Start-Sleep -Seconds 2
  if (Test-Path $LockFile) { Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue }
}
if (-not (Test-Port $ConsolePort 500)) { Say '      控制台端口已释放' }
else { Say '      [warn] 控制台端口仍在响应 —— 下一步启动可能失败' }

# -- 2) restart bridge (+SnowLuma) through the authoritative launcher -------
Say ''
Say '[2/6] 通过权威启动器重启桥接（tools\qq-bridge-launcher.ps1 -Action restartAll）...'
# 记录重启前的启动次数，作为"是否真的重启了"的判据（见第 3 步）。
$BridgeStartups = 0
try {
  if (Test-Path $LogFile) {
    $BridgeStartups = @(Select-String -LiteralPath $LogFile -Pattern '桥接已启动' -Encoding UTF8 -ErrorAction SilentlyContinue).Count
  }
} catch {}
if ($DryRun) {
  Say '      [DryRun] 跳过启动器调用'
} elseif (Test-Path $Launcher) {
  # 不能用 & / Invoke-WebRequest 同步等待：启动器会拉起 SnowLuma 与桥接，
  # 这些子进程会继承 stdout 管道，于是父进程读管道一直等不到 EOF ——
  # 表现为「卡在这一步」，而实际上启动器早已成功结束（launcher.log 里有 exit=0）。
  # 因此改为非阻塞启动 + 轮询进程状态 + 超时保护，输出走文件而不是管道。
  $launcherOut = Join-Path $RuntimeDir 'restart-launcher.out.log'
  $launcherErr = Join-Path $RuntimeDir 'restart-launcher.err.log'
  $launcherExit = -1
  $started = $false
  try {
    $proc = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Launcher, '-Action', 'restartAll') `
      -WorkingDirectory $Root -WindowStyle Minimized -PassThru `
      -RedirectStandardOutput $launcherOut -RedirectStandardError $launcherErr -ErrorAction Stop
    $started = $true
    $deadline = (Get-Date).AddSeconds(180)
    while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 1000 }
    if ($proc.HasExited) {
      $launcherExit = $proc.ExitCode
      Say ("      启动器退出码: " + $launcherExit)
    } else {
      Say '      [warn] 启动器 180 秒未退出 —— 不再阻塞，继续下一步（结果仍会校验）'
    }
  } catch {
    Say ('      [error] 启动启动器失败: ' + $_.Exception.Message)
  }
  # 展示启动器尾部输出；它的进度同样记录在 tools\runtime\launcher.log
  if ($started -and (Test-Path $launcherOut)) {
    $lines = @(Get-Content -LiteralPath $launcherOut -Tail 12 -Encoding UTF8 -ErrorAction SilentlyContinue)
    foreach ($line in $lines) {
      $s = ([string]$line).Trim()
      if ($s -and $s -notmatch '^[\{\}\[\]]' -and $s.Length -lt 200) { Say ("      | " + $s) }
    }
  }
} else {
  Say ("      [warn] 找不到启动器: $Launcher —— 回退到 start.bat")
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start.bat' -WorkingDirectory $Root -WindowStyle Minimized -ErrorAction Stop
    Say '      已拉起 start.bat'
  } catch { Say ('      [error] ' + $_.Exception.Message) }
}

# -- 3) wait for the console ------------------------------------------------
Say ''
Say '[3/6] 等待桥接控制台就绪...'
$token = Read-ConsoleToken
$headers = @{}
if ($token) { $headers['x-console-token'] = $token }
$ready = $false
if ($DryRun) {
  try {
    $r = Invoke-WebRequest ("http://127.0.0.1:$ConsolePort/api/status") -Headers $headers -TimeoutSec 4 -UseBasicParsing -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true }
  } catch {}
  Say ("      [DryRun] 单次探测结果: " + $(if ($ready) { '控制台在响应' } else { '无响应' }))
} else {
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest ("http://127.0.0.1:$ConsolePort/api/status") -Headers $headers -TimeoutSec 4 -UseBasicParsing -ErrorAction Stop
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 1200 }
  }
}
if ($ready) { Say '      控制台可访问' } else { Say "      [warn] $ReadyTimeoutSec 秒内未就绪 —— 见 $LogFile" }

# 关键校验：控制台"可访问"并不能证明发生过重启 —— 旧进程照样能响应，
# 于是脚本会报成功而代码其实没换。判据用桥接日志里**新的**「桥接已启动」记录。
#
# 注意：新进程写完这一行需要时间，必须**轮询**而不是读一次就下结论 ——
# 早期版本单次读取，在新进程还没落盘时就报 FAIL，造成过一次误报（还把原因
# 错归为"权限不足"，而用户本来就在管理员终端里、重启其实成功了）。
$startupsAfter = 0
if (-not $DryRun) {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    try {
      $startupsAfter = @(Select-String -LiteralPath $LogFile -Pattern '桥接已启动' -Encoding UTF8 -ErrorAction SilentlyContinue).Count
    } catch { $startupsAfter = 0 }
    if ($startupsAfter -gt $BridgeStartups) { break }
    Start-Sleep -Milliseconds 1000
  }
  Say ("      启动记录: 重启前 $BridgeStartups 条 -> 现在 $startupsAfter 条")
  if ($startupsAfter -le $BridgeStartups) {
    Say '      [FAIL] 30 秒内没看到新的「桥接已启动」记录 —— 桥接可能没有真正重启。'
    Say '             常见原因：结束旧进程被拒绝（旧桥接若以更高权限运行，'
    Say '             普通权限下 Stop-Process / taskkill 会报 Access denied）。'
    Say '             可尝试：用「以管理员身份运行」重跑，或在任务管理器里结束该 node 进程后重跑。'
    Say '             注意：仅凭本项不足以断定失败 —— 若下面第 4 步的端点探针通过，说明新代码其实已生效。'
    $script:bridgeRestarted = $false
  } else {
    $script:bridgeRestarted = $true
  }
}

# -- 4) prove the new route is loaded --------------------------------------
Say ''
Say '[4/6] Verifying the new /api/socialV2/send-image route is loaded...'
# A registered route answers with a business error code (400/403); a missing one
# falls through to the bridge 404 handler. That difference is the signal.
$routeOk = $false
if ($ready -and $token) {
  $probeHeaders = @{ 'x-console-token' = $token; 'content-type' = 'application/json' }
  $body = '{"key":"group:0","path":""}'
  for ($i = 0; $i -lt 15; $i++) {
    try {
      $r = Invoke-WebRequest ("http://127.0.0.1:$ConsolePort/api/socialV2/send-image") -Method POST -Headers $probeHeaders -Body $body -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
      Say ('      unexpected HTTP ' + $r.StatusCode)
      break
    } catch {
      $code = 0
      try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      if ($code -eq 400 -or $code -eq 403) { $routeOk = $true; break }
      Start-Sleep -Milliseconds 1000
    }
  }
}
if ($routeOk) { Say '      新端点已加载 —— 新代码已生效' }
elseif (-not $token) { Say '      [warn] 读不到控制台令牌，无法验证端点' }
else { Say '      [warn] 端点看起来仍未加载 —— 桥接可能还是旧进程' }

# 端点探针能返回业务错误码（400/403）就证明**新代码确实在跑** —— 这是比日志
# 计数更硬的判据，因此把它作为「是否重启成功」的最终依据，覆盖第 3 步的结论。
if (-not $DryRun -and $routeOk) { $script:bridgeRestarted = $true }

# -- 5) confirm the QQ side is actually connected --------------------------
Say ''
Say '[5/6] 检查桥接 <-> SnowLuma 连接...'
# A bridge can answer HTTP while its QQ websocket is dead; that state looks "up"
# to a port probe but silently stops handling messages.
$connected = $false
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  try {
    if (Test-Path $LogFile) {
      $tail = Get-Content -LiteralPath $LogFile -Tail 150 -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($tail | Select-String -SimpleMatch -Pattern 'SnowLuma' -Quiet) { $connected = $true; break }
    }
  } catch {}
  Start-Sleep -Milliseconds 1500
}
if ($connected) { Say '      日志里看到 SnowLuma 连接记录' }
else { Say '      [warn] 日志里还没看到 SnowLuma 连接 —— 桥接可能没在处理 QQ 消息' }

# -- 6) restart DSH so MCP tools are re-mounted ----------------------------
Say ''
if ($DryRun) {
  Say '[6/6] [DryRun] 跳过 DSH 重启'
} elseif ($RestartDsh) {
  Say '[6/6] 按要求重启 DSH web 子进程（-RestartDsh）...'
  Say '      注意：本网页界面会断开，并在新端口重开。'
  $dshOk = $false
  # Guard first: restarting DSH disconnects the page the user is looking at and
  # moves the GUI to a new random port + token. Refuse while a session log was
  # written recently; override with -Force. See tools\dsh-restart-guard.ps1.
  $guard = Join-Path $ToolsDir 'dsh-restart-guard.ps1'
  if (Test-Path $guard) {
    $guardArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $guard,
      '-Root', $Root, '-ManagerPort', $ManagerPort, '-Restart')
    if ($Force) { $guardArgs += '-Force' }
    & powershell.exe @guardArgs
    if ($LASTEXITCODE -eq 0) { $dshOk = $true }
    elseif ($LASTEXITCODE -eq 3) { Say '      [REFUSED] a DSH session looks live - re-run with -Force to override.' }
  } else {
  # Preferred: the DSH-X manager restarts only the dsh child, keeping the
  # manager (and its window) alive.
  foreach ($uri in @("http://127.0.0.1:$ManagerPort/api/restart", "http://127.0.0.1:3780/api/restart")) {
    try {
      $r = Invoke-WebRequest $uri -Method POST -TimeoutSec 25 -UseBasicParsing -ErrorAction Stop
      Say ("      已接受重启请求：$uri（HTTP " + $r.StatusCode + '）')
      $dshOk = $true
      break
    } catch {
      Say ("      [warn] $uri 失败：" + $_.Exception.Message)
    }
  }
  }
  if (-not $dshOk) {
    # Fallback: the launcher knows how to stop AND start the DSH web child.
    Say '      回退到：qq-bridge-launcher.ps1 -Action restart -Target dsh'
    try {
      $out2 = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Launcher -Action restart -Target dsh 2>&1
      foreach ($line in @($out2)) {
        $s = ([string]$line).Trim()
        if ($s -and $s -notmatch '^[\{\}\[\]]' -and $s.Length -lt 200) { Say ("      | " + $s) }
      }
      Say '      已通过启动器尝试重启 DSH。'
    } catch {
      Say ('      [warn] 启动器重启 DSH 失败：' + $_.Exception.Message)
      Say '      请手动重开 DSH-X（桌面快捷方式）。'
    }
  }
} else {
  # Deliberately NOT restarting DSH by default: this script exists to reload
  # src\bridge.js, and the project's own launcher keeps DSH alive on purpose
  # ("DSH is deliberately left running so this never closes the web session in
  # use"). Restarting it on every run disconnects the user's web GUI for no
  # benefit once the MCP tool list is already loaded.
  Say '[6/6] 默认不重启 DSH（避免打断你正在用的网页端）。'
  Say '      只有在你新增/删除了 MCP 工具、需要 DSH 重新挂载工具面时，'
  Say '      才需要重启它：右键本 .bat → 编辑，或在命令行加 -RestartDsh。'
  $dshOk = $true
}

Say ''
Say '=== 结果小结 ==='
Say ("  桥接是否真的重启                    : " + $(if ($DryRun) { '已跳过（DryRun）' } elseif ($bridgeRestarted) { '是 ✓（端点探针已确认新代码在跑）' } else { '未确认 ✗ —— 见上面的 [FAIL] 提示' }))
Say ("  桥接新端点 /api/socialV2/send-image : " + $(if ($DryRun) { '已跳过（DryRun）' } elseif ($routeOk) { '已加载 ✓' } else { '未确认 ✗' }))
Say ("  桥接 -> SnowLuma 连接               : " + $(if ($DryRun) { '仅探测' } elseif ($connected) { '已连接 ✓' } else { '未确认 ✗' }))
Say ("  DSH 重启                            : " + $(if ($DryRun) { '已跳过（DryRun）' } elseif ($RestartDsh) { if ($dshOk) { '已请求 ✓（本网页端会断开并换端口重开）' } else { '未确认 ✗ 请手动重开 DSH-X' } } else { '不需要（默认不动 DSH，网页端保持连接）' }))
Say ''
if ($DryRun) {
  Say '  结论：DryRun 通过 —— 脚本本身能正常执行、中文输出正常。真实重启请去掉 -DryRun。'
} elseif (-not $bridgeRestarted) {
  Say '  结论：桥接没有真正重启，新代码未生效。请按上面的提示以管理员身份重跑。'
} elseif ($routeOk -and $connected) {
  Say '  结论：可以用了。去 QQ 里发一句「画只小鲸鱼」试试。'
} else {
  Say '  结论：有一步没确认成功，把上面整段输出发给我。'
}
Say ''
Say '=== 排查命令（在 qq-bridge 目录下执行）==='
Say '  node scripts\restart-status.mjs          一行判定：新代码是否加载 / 消息是否还在流动'
Say '  node scripts\test-comfy-tools.mjs        工具注册 + 真机出图'
Say '  node scripts\test-send-image-fence.mjs   发图路径围栏'
Say '  state\bridge.log                         桥接日志'
Say '  ComfyUI 需保持运行（127.0.0.1:8188）'
Say '  需要 DSH 重新挂载 MCP 工具时：本脚本加 -RestartDsh'
