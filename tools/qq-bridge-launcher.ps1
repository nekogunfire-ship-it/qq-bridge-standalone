# qq-bridge-launcher.ps1
# ---------------------------------------------------------------------------
# Core logic of the QQ-bridge one-click launcher (headless; usable from CLI).
#
# Callers:
#   * launcher.hta                            -> GUI, buttons forward to -Action
#   * OneClick-StartQQBridge.bat and friends   -> double-click, CLI output
#
# Actions (-Action):
#   status        read-only JSON status (default)
#   startAll      start in dependency order: DSH (if down) -> SnowLuma -> bridge
#   stopAll       stop bridge -> SnowLuma (DSH is left alone on purpose)
#   restartAll    stopAll + wait for ports + startAll
#   start|stop|restart  with -Target dsh|snowluma|bridge
#   syncEndpoint  run sync-dsh-endpoint.ps1 only (after DSH changed port/token)
#   logs          JSON with recent log lines (-LogName bridge|qq|launcher)
#   openDsh       open the DSH web UI using the current token
#
# Invocation:
#   powershell -NoProfile -ExecutionPolicy Bypass -File qq-bridge-launcher.ps1 -Action startAll -OutFile <path>
#   -OutFile writes the result JSON as UTF-8 (no BOM) for the HTA to read.
#   Without -OutFile the JSON goes to stdout.
#
# IMPORTANT -- THIS FILE MUST STAY PURE ASCII.
#   Windows PowerShell 5.1 reads BOM-less .ps1 files using the system ANSI code
#   page (GB2312/cp936 here), which corrupts non-ASCII literals and breaks
#   parsing. All human-facing Chinese text lives in tools/messages.json
#   (UTF-8) and is loaded through T() below.
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
  [ValidateSet(
    'status', 'startAll', 'stopAll', 'restartAll',
    'start', 'stop', 'restart',
    'syncEndpoint', 'logs', 'openDsh', 'diagnose'
  )]
  [string]$Action = 'status',

  [ValidateSet('dsh', 'snowluma', 'bridge', 'comfy')]
  [string]$Target = 'bridge',

  [ValidateSet('bridge', 'qq', 'launcher')]
  [string]$LogName = 'bridge',

  [int]$Tail = 120,

  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# -- paths -------------------------------------------------------------------
# This script lives in <workspace>\qq-bridge\tools\, so the workspace is 3 up.
$ToolsDir  = $PSScriptRoot
$BridgeDir = Split-Path -Parent $ToolsDir
$Workspace = Split-Path -Parent $BridgeDir
$StateDir  = Join-Path $BridgeDir 'state'
$Runtime   = Join-Path $ToolsDir 'runtime'
$LogFile   = Join-Path $Runtime 'launcher.log'
$InitFile  = Join-Path $Runtime 'init.json'
$MsgFile   = Join-Path $ToolsDir 'messages.json'

$Init = @{}
if (Test-Path $InitFile) {
  try { $Init = Get-Content $InitFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
$Msg = @{}
if (Test-Path $MsgFile) {
  try { $Msg = Get-Content $MsgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}

function Cfg([string]$key, $default) {
  if ($Init -and ($Init.PSObject.Properties.Name -contains $key) -and $Init.$key) { return $Init.$key }
  return $default
}

# Text lookup + {0}-style formatting for the Chinese UI strings.
function T([string]$key) {
  $text = $null
  if ($Msg -and ($Msg.PSObject.Properties.Name -contains $key)) { $text = $Msg.$key }
  if (-not $text) { return $key }
  if ($args.Count -gt 0) {
    try { return ([string]$text -f $args) } catch { return [string]$text }
  }
  return [string]$text
}

$NodeExe     = Cfg 'nodeExe' 'D:\DSH\node\node.exe'
$DshExe      = Cfg 'dshExe' 'D:\DSH\DSH.exe'
$SnowLumaDir = Cfg 'snowLumaDir' 'C:\SnowLuma'
$ComfyDir    = Cfg 'comfyDir' 'E:\comfyui'
$SyncScript  = Cfg 'syncScript' (Join-Path $Workspace '_handoff-qq-bridge\sync-dsh-endpoint.ps1')
$ManagerLog  = Join-Path $env:APPDATA 'DSH\manager.log'
$LaunchOut   = Join-Path $Runtime 'launch-out.log'
$PidFile     = Join-Path $Runtime 'launched-pids.json'
$Ports       = Cfg 'ports' ([pscustomobject]@{
  dshApi = 53151; snowlumaApi = 3000; snowlumaWs = 3001
  snowlumaWeb = 5099; bridgeConsole = 3100; dshLauncher = 3780; comfy = 8188
})

if (-not (Test-Path $NodeExe)) { $NodeExe = 'node' }
if (-not (Test-Path $Runtime)) { New-Item -ItemType Directory -Path $Runtime -Force | Out-Null }

function P([string]$name) { return [int]$Ports.$name }

# -- helpers -----------------------------------------------------------------
function Write-LauncherLog([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}

function Test-Port([int]$port, [int]$timeoutMs = 400) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne($timeoutMs) -and $client.Connected) { return $true }
    return $false
  } catch { return $false } finally { try { $client.Close() } catch {} }
}

# Find services by command line -- more reliable than a PID file, since it also
# copes with restarts and with how the process happened to be launched.
function Get-ServiceProcess([string]$pattern, [string[]]$excludePattern = @()) {
  $found = @()
  $all = @()
  try { $all = @(Get-CimInstance Win32_Process -ErrorAction Stop) }
  catch {
    $script:LastScanError = $_.Exception.Message
    Write-LauncherLog "CIM scan failed: $($_.Exception.Message)"
    return @()
  }
  $script:LastScanTotal = $all.Count
  foreach ($p in $all) {
    if (-not $p.CommandLine) { continue }
    if ($p.CommandLine -notlike $pattern) { continue }
    $skip = $false
    foreach ($ex in $excludePattern) { if ($p.CommandLine -like $ex) { $skip = $true; break } }
    if ($skip) { continue }
    $found += $p
  }
  return $found
}

# Exclude DSH's subprocess-wrapper shells: they merely mention the script path.
$BridgeExclude = @('*mcp-*', '*subprocess-local*', '*launcher.ps1*', '*-Command*')
# NOTE: a PowerShell function returning a 1-element array unrolls it to a scalar
# on the way out, and a scalar CimInstance has no usable .Count -- which silently
# broke detection. Every caller wraps with @(), which re-wraps a scalar into a
# 1-element array and collapses "no output" into Count=0. That is why these three
# helpers return the plain @(...) array and NOTHING else.
# DO NOT "fix" this by returning `, @(...)`: the unary comma survives as a
# 1-element array whose element is an empty array, so a denied/failed CIM scan
# looks like "1 process", and then [int]$procs[0].ProcessId throws
# "Cannot convert System.Object[] to System.Int32" (seen 2026-09-26, when
# Get-CimInstance returned Access Denied and stop/startAll/restartAll all died).
function Get-BridgeProc { return @(Get-ServiceProcess -pattern '*src\bridge.js*' -excludePattern $BridgeExclude) }
function Get-SnowProc   { return @(Get-ServiceProcess -pattern '*index.mjs*' -excludePattern @('*subprocess-local*', '*launcher.ps1*', '*-Command*', '*dsh*lib\bin.js*')) }

# PIDs currently LISTENING on the SnowLuma ports. Used as a fallback when the
# process scan comes up empty even though a leftover instance is holding a port.
function Get-SnowPortOwners {
  $owners = @()
  foreach ($port in @((P 'snowlumaApi'), (P 'snowlumaWs'), (P 'snowlumaWeb'))) {
    try {
      $conns = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
      foreach ($c in $conns) { if ([int]$c.OwningProcess -gt 0) { $owners += [int]$c.OwningProcess } }
    } catch {}
  }
  return @($owners | Sort-Object -Unique)
}
function Get-DshProc    { return @(Get-ServiceProcess -pattern '*dsh*lib\bin.js*web*' -excludePattern @('*subprocess-local*', '*launcher.ps1*')) }

function Read-PidFile {
  if (-not (Test-Path $PidFile)) { return @{} }
  try { return (Get-Content $PidFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return @{} }
}
function Write-PidFile($table) {
  try { $table | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $PidFile -Encoding UTF8 } catch {}
}
function Remember-Pid([string]$name, [int]$processId) {
  $table = Read-PidFile
  $table | Add-Member -NotePropertyName $name -NotePropertyValue $processId -Force
  Write-PidFile $table
}

function Start-ServiceProcess([string]$filePath, [string[]]$arguments, [string]$workingDirectory, [string]$logName = 'launch-out') {
  # Windows PowerShell 5.1 的 Start-Process 会用大小写敏感字典复制环境变量；当父进程
  # 同时有 NO_PROXY/no_proxy 时会直接抛 "Key already added"。ProcessStartInfo 的环境
  # 字典按 Windows 规则不区分大小写，不会触发这个已知问题。
  $quote = {
    param([string]$value)
    if ($value -notmatch '[\s"]') { return $value }
    return '"' + (($value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $filePath
  $psi.WorkingDirectory = $workingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  if ($arguments -and $arguments.Count) {
    $psi.Arguments = (($arguments | ForEach-Object { & $quote ([string]$_) }) -join ' ')
  }
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  if (-not $proc.Start()) { throw "failed to start $filePath" }
  Write-LauncherLog "started $logName (PID $($proc.Id)): $filePath $($psi.Arguments)"
  return $proc
}

function Stop-ProcessSafe([int]$processId, [string]$label) {
  if (-not $processId -or $processId -le 0) { return $false }
  if ($processId -eq $PID -or $processId -eq $script:CallerPid) { return $false }
  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  try {
    $proc.CloseMainWindow() | Out-Null
    if ($proc.WaitForExit(2500)) { Write-LauncherLog "stopped gracefully: $label (PID $processId)"; return $true }
  } catch {}
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
    Write-LauncherLog "force killed: $label (PID $processId)"
    return $true
  } catch {
    Write-LauncherLog "failed to stop $label (PID $processId): $($_.Exception.Message)"
    return $false
  }
}

function Stop-PortOwner([int]$port, [string]$label) {
  $conns = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  $killed = $false
  foreach ($owner in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if (Stop-ProcessSafe -processId ([int]$owner) -label "$label (port $port)") { $killed = $true }
  }
  return $killed
}

function Wait-Until([scriptblock]$condition, [int]$timeoutMs, [int]$intervalMs = 700) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    try { if (& $condition) { return $true } } catch {}
    Start-Sleep -Milliseconds $intervalMs
  }
  return $false
}

# -- DSH endpoint ------------------------------------------------------------
function Get-DshEndpoint {
  $endpoint = [ordered]@{ port = 0; token = ''; url = '' }
  try {
    if (Test-Path $ManagerLog) {
      $line = Get-Content $ManagerLog -Tail 400 -ErrorAction SilentlyContinue |
        Select-String 'dsh web: http' | Select-Object -Last 1
      if ($line) {
        $m = [regex]::Match($line.Line, 'http://127\.0\.0\.1:(?<port>\d+)/?\?token=(?<token>[A-Za-z0-9_\-]+)')
        if ($m.Success) {
          $endpoint.port  = [int]$m.Groups['port'].Value
          $endpoint.token = $m.Groups['token'].Value
          $endpoint.url   = 'http://127.0.0.1:{0}/?token={1}' -f $endpoint.port, $endpoint.token
        }
      }
    }
  } catch {}
  return $endpoint
}

# -- status ------------------------------------------------------------------
# -IncludeInfo attaches the human-readable step list collected in $info to the
# payload. The desktop UI only shows that list, which is why the useful
# diagnostics ("no QQ client detected", "WS not ready within 60s") used to stay
# invisible in bridge-watch.log while the user only saw "startup failed".
function Get-LauncherStatus {
  param([switch]$IncludeInfo)
  $bridgeProcs = @(Get-BridgeProc)
  $snowProcs   = @(Get-SnowProc)
  $dshProcs    = @(Get-DshProc)
  $endpoint    = Get-DshEndpoint
  $dshPort     = if ($endpoint.port) { $endpoint.port } else { P 'dshApi' }
  $dshPortUp   = Test-Port $dshPort
  $runtimeType = Get-RuntimeType

  $services = [ordered]@{}

  $services.dsh = [ordered]@{
    running = [bool]($dshPortUp -or $dshProcs.Count -ge 1)
    pid     = if ($dshProcs.Count -ge 1) { [int]$dshProcs[0].ProcessId } else { 0 }
    port    = $dshPort
    detail  = if ($dshPortUp) { T 'dshRunning' $dshPort } else { T 'dshPortDead' }
  }

  $snowApiUp = Test-Port (P 'snowlumaApi')
  $snowWsUp  = Test-Port (P 'snowlumaWs')
  $snowWebUp = Test-Port (P 'snowlumaWeb')
  $services.snowluma = [ordered]@{
    running = [bool](($snowApiUp -and $snowWsUp) -or $snowProcs.Count -ge 1)
    pid     = if ($snowProcs.Count -ge 1) { [int]$snowProcs[0].ProcessId } else { 0 }
    port    = P 'snowlumaApi'
    detail  = T 'snowPorts' `
      $(if ($snowApiUp) { T 'on' } else { T 'off' }) `
      $(if ($snowWsUp) { T 'on' } else { T 'off' }) `
      $(if ($snowWebUp) { T 'on' } else { T 'off' })
  }

  $consoleUp = Test-Port (P 'bridgeConsole')
  $bridgeDetail = T 'bridgeDown'
  if ($consoleUp) { $bridgeDetail = T 'bridgeConsoleUp' (P 'bridgeConsole') }
  elseif ($bridgeProcs.Count -ge 1) { $bridgeDetail = T 'bridgeConsoleDead' }
  $services.bridge = [ordered]@{
    running            = [bool]($consoleUp -or $bridgeProcs.Count -ge 1)
    pid                = if ($bridgeProcs.Count -ge 1) { [int]$bridgeProcs[0].ProcessId } else { 0 }
    port               = P 'bridgeConsole'
    detail             = $bridgeDetail
    connectedSnowluma  = $false
    connectedDsh       = $false
  }

  # What the bridge itself reports is the most trustworthy signal.
  # -Encoding UTF8 is REQUIRED: bridge.log is UTF-8, and Windows PowerShell 5.1's
  # Get-Content default code page mangles the Chinese markers so they never match.
  $logPath = Join-Path $StateDir 'bridge.log'
  if (Test-Path $logPath) {
    foreach ($l in (Get-Content $logPath -Tail 120 -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      if ($l -match (T 'logSnowConnected')) { $services.bridge.connectedSnowluma = $true }
      if ($l -match (T 'logDshReady'))     { $services.bridge.connectedDsh = $true }
    }
  }

  $qqCount = @(Get-Process -Name QQ -ErrorAction SilentlyContinue).Count
  $services.qq = [ordered]@{
    running = ($qqCount -gt 0)
    pid     = 0
    port    = 0
    detail  = if ($qqCount -gt 0) { T 'qqRunning' $qqCount } else { T 'qqDown' }
  }

  # Optional service: rendered in the UI, but never counted as a chain failure.
  $comfyUp = Test-Port (P 'comfy') 600
  $services.comfy = [ordered]@{
    running   = $comfyUp
    pid       = if ($comfyUp) { 0 } else { 0 }
    port      = P 'comfy'
    detail    = if ($comfyUp) { T 'comfyReady' (P 'comfy') } else { T 'comfyLoading' (P 'comfy') }
    optional  = $true
  }

  # ComfyUI is optional: its absence may not turn a working chain into "failed".
  $needsDsh   = ($runtimeType -ne 'direct')
  $allRunning = ($services.snowluma.running -and $services.bridge.running -and (-not $needsDsh -or $services.dsh.running))
  $healthy    = ($allRunning -and $services.bridge.connectedSnowluma -and (-not $needsDsh -or $services.bridge.connectedDsh))
  $anyRunning = ($services.dsh.running -or $services.snowluma.running -or $services.bridge.running -or $services.comfy.running)

  return [ordered]@{
    ok         = $true
    action     = $Action
    runtime    = $runtimeType
    time       = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    allRunning = $allRunning
    health     = if ($healthy) { 'healthy' } elseif ($anyRunning) { 'partial' } else { 'down' }
    services   = $services
    dshUrl     = $endpoint.url
    dshToken   = $endpoint.token
    workspace  = $Workspace
    bridgeDir  = $BridgeDir
    logs       = @{
      bridge   = (Join-Path $StateDir 'bridge.log')
      qq       = (Join-Path $StateDir 'qq-activity.log')
      launcher = $LogFile
    }
  }
}

# -- start -------------------------------------------------------------------
# -- AI runtime ---------------------------------------------------------------
# Which AI runtime is configured: 'direct' (straight to an OpenAI-compatible API)
# or 'dsh' (the default). This decides whether startAll should pull DSH up at all
# -- in direct mode the bot never goes through it.
# Same rule as the bridge: a missing/other `runtime.type` means 'dsh'.
# NOTE: only the single `type` field is read; the config is never printed
# (it holds apiKey / QQ numbers / tokens).
function Get-RuntimeType {
  # NOTE: config.json lives in the REPO root ($BridgeDir), not in $Workspace
  # -- $Workspace is the parent of the repo (see the paths block above).
  $cfgFile = Join-Path $BridgeDir 'config.json'
  if (-not (Test-Path $cfgFile)) { return 'dsh' }
  try {
    $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.runtime -and $cfg.runtime.type -eq 'direct') { return 'direct' }
  } catch { }
  return 'dsh'
}

function Start-DshService([System.Collections.ArrayList]$info) {
  $procs = @(Get-DshProc)
  $endpoint = Get-DshEndpoint
  if ($endpoint.port -and (Test-Port $endpoint.port)) {
    $null = $info.Add((T 'dshAlready' $(if ($procs.Count -ge 1) { $procs[0].ProcessId } else { 0 })))
    return $true
  }
  if ($procs.Count -ge 1) {
    $null = $info.Add((T 'dshAlready' $procs[0].ProcessId))
    return $true
  }
  if (-not (Test-Path $DshExe)) {
    $null = $info.Add((T 'dshExeMissing' $DshExe))
    return $false
  }
  $null = $info.Add((T 'dshStarting'))
  $before = (Get-DshEndpoint).url
  try {
    $shell = New-Object -ComObject WScript.Shell
    $null = $shell.Run(('"{0}"' -f $DshExe), 1, $false)
  } catch {
    $null = $info.Add((T 'dshStartFailed' $_.Exception.Message))
    return $false
  }
  $ok = Wait-Until { $u = (Get-DshEndpoint).url; $u -and $u -ne $before } -timeoutMs 120000
  if (-not $ok) {
    $null = $info.Add((T 'dshTimeout'))
    return $false
  }
  $ep = Get-DshEndpoint
  $null = $info.Add((T 'dshStarted' $ep.port))
  $null = Wait-Until { Test-Port $ep.port } -timeoutMs 60000
  return $true
}

function Start-SnowLumaService([System.Collections.ArrayList]$info) {
  $procs = @(Get-SnowProc)
  if ((Test-Port (P 'snowlumaApi')) -and (Test-Port (P 'snowlumaWs'))) {
    $null = $info.Add((T 'snowAlready' $(if ($procs.Count -ge 1) { $procs[0].ProcessId } else { 0 })))
    return $true
  }
  if (-not (Test-Path (Join-Path $SnowLumaDir 'index.mjs'))) {
    $null = $info.Add((T 'snowMissing' $SnowLumaDir))
    return $false
  }

  # An instance that is not serving OneBot is a ZOMBIE: SnowLuma only opens the
  # OneBot ports AFTER it has successfully hooked into a running QQ process, and
  # a failed hook leaves it alive but serving nothing but the WebUI.
  #
  # The old code just spawned another one on top: the zombie kept holding the
  # WebUI port, so the new instance fell back to 5100 and *also* never opened WS
  # (observed 2026-09-27: 34380 on 5099 + 8648 on 5100, two SnowLuma, zero OneBot).
  # So: clear leftovers first, then start exactly one instance.
  #
  # Do NOT gate this on process detection: our own process view is
  # context-dependent (the launcher sees 2 SnowLuma processes when the desktop
  # app calls it, and 0 when a plain sandboxed shell calls it), so a leftover
  # that is reached by port below would slip through a "did we find a proc?" check.
  if ($procs.Count -ge 1) {
    $killList = @($procs | ForEach-Object { [int]$_.ProcessId })
  } else {
    $killList = @(Get-SnowPortOwners)
  }
  if ($killList.Count -ge 1) {
    $wsPort = P 'snowlumaWs'
    $null = $info.Add((T 'snowZombie' (($killList | Sort-Object -Unique).Count) $wsPort))
    foreach ($zpid in ($killList | Sort-Object -Unique)) { [void](Stop-PidHard $zpid 'SnowLuma(zombie)') }
  }
  # Fallback for an instance that owns a port but was started outside this
  # launcher (so neither CIM nor the pid file knows about it).
  foreach ($portName in @('snowlumaApi', 'snowlumaWs', 'snowlumaWeb')) {
    if (Test-Port (P $portName) 400) {
      if (Stop-PortOwner -port (P $portName) -label 'SnowLuma(zombie)') { $null = $info.Add((T 'snowZombiePort')) }
    }
  }
  $null = Wait-PortsFree @((P 'snowlumaApi'), (P 'snowlumaWs'), (P 'snowlumaWeb')) 15000
  if (@(Get-Process -Name QQ -ErrorAction SilentlyContinue).Count -eq 0) {
    $null = $info.Add((T 'snowNoQq'))
  }
  $null = $info.Add((T 'snowStarting'))
  try {
    $proc = Start-ServiceProcess -filePath $NodeExe -arguments @('.\index.mjs') -workingDirectory $SnowLumaDir
    Remember-Pid 'snowluma' ([int]$proc.Id)
  } catch {
    $null = $info.Add((T 'snowStartFailed' $_.Exception.Message))
    return $false
  }
  if (-not (Wait-Until { Test-Port (P 'snowlumaWs') } -timeoutMs 60000)) {
    $null = $info.Add((T 'snowTimeout'))
    return $false
  }
  $null = $info.Add((T 'snowReady' (P 'snowlumaApi') (P 'snowlumaWs')))

  # "WS is listening" is not the same as "it took over the QQ account": on
  # 2026-09-27 the port came up in several runs while OneBot still could not say
  # who was logged in. Ask OneBot directly - one call proves gateway + QQ online
  # + account hooked - and say so out loud when it cannot answer.
  $login = Test-Http ("http://127.0.0.1:{0}/get_login_info" -f (P 'snowlumaApi')) $null 6
  $loginObj = $null
  if ($login.ok) { try { $loginObj = $login.body | ConvertFrom-Json } catch {} }
  if ($loginObj -and $loginObj.status -eq 'ok' -and $loginObj.data) {
    $null = $info.Add((T 'snowLoginOk' $loginObj.data.nickname $loginObj.data.user_id))
  } else {
    $null = $info.Add((T 'snowLoginBad' $login.code $login.error))
  }

  # SnowLuma logs to stdout; the hook lines tell us it re-attached to the running QQ.
  $hook = @()
  foreach ($f in @((Join-Path $Runtime 'launch-out.out.log'), (Join-Path $Runtime 'launch-out.err.log'))) {
    if (Test-Path $f) {
      $hook += @(Get-Content $f -Tail 120 -Encoding UTF8 -ErrorAction SilentlyContinue |
        Select-String 'Hook.*(login detected|pipe connected)')
    }
  }
  if ($hook.Count -ge 1) { $null = $info.Add((T 'snowHook' $hook[-1].Line.Trim())) }
  return $true
}

function Start-BridgeService([System.Collections.ArrayList]$info) {
  $procs = @(Get-BridgeProc)
  if (Test-Port (P 'bridgeConsole')) {
    $null = $info.Add((T 'bridgeAlready' $(if ($procs.Count -ge 1) { $procs[0].ProcessId } else { 0 })))
    return $true
  }
  if (-not (Test-Path (Join-Path $BridgeDir 'src\bridge.js'))) {
    $null = $info.Add((T 'bridgeMissing' $BridgeDir))
    return $false
  }
  if (-not (Test-Port (P 'snowlumaWs'))) {
    $null = $info.Add((T 'bridgeNeedsSnow' (P 'snowlumaWs')))
    return $false
  }
  $null = $info.Add((T 'bridgeStarting'))
  try {
    $proc = Start-ServiceProcess -filePath $NodeExe -arguments @('src\bridge.js') -workingDirectory $BridgeDir
    Remember-Pid 'bridge' ([int]$proc.Id)
  } catch {
    $null = $info.Add((T 'bridgeStartFailed' $_.Exception.Message))
    return $false
  }
  if (-not (Wait-Until { Test-Port (P 'bridgeConsole') } -timeoutMs 60000)) {
    $null = $info.Add((T 'bridgeTimeout'))
    return $false
  }
  $null = $info.Add((T 'bridgeReady' (P 'bridgeConsole')))

  # 400 lines, not 60: the bridge is chatty, so a freshly restarted bridge can emit
  # its connect lines and then bury them under a burst of message activity.
  $logPath = Join-Path $StateDir 'bridge.log'
  $snowOk = Wait-Until {
    (Get-Content $logPath -Tail 400 -Encoding UTF8 -ErrorAction SilentlyContinue | Select-String (T 'logSnowConnected')) -ne $null
  } -timeoutMs 15000
  if ($snowOk) { $null = $info.Add((T 'bridgeLinkSnowOk')) } else { $null = $info.Add((T 'bridgeLinkSnowBad')) }
  # The "bridge -> DSH" check only means something when DSH is the AI runtime.
  # In direct mode the bridge never connects to DSH, so waiting 25s for a
  # "DSH 已就绪" line and then telling the user to "sync the DSH endpoint" is
  # both wasted time and a false alarm -- exactly the kind of UI text that made
  # the app feel bolted to DSH.
  if ((Get-RuntimeType) -eq 'direct') {
    $null = $info.Add((T 'bridgeLinkDshNa'))
  } else {
    $dshOk = Wait-Until {
      (Get-Content $logPath -Tail 400 -Encoding UTF8 -ErrorAction SilentlyContinue | Select-String (T 'logDshReady')) -ne $null
    } -timeoutMs 25000
    if ($dshOk) { $null = $info.Add((T 'bridgeLinkDshOk')) } else { $null = $info.Add((T 'bridgeLinkDshBad')) }
  }
  return $true
}

# -- ComfyUI (optional image service) ----------------------------------------
# Started on top of the user's own E:\comfyui install, never modified by us:
# same wrapper and same flags as run_DSH.bat, minus the batch window and the
# automatic browser tab, because this one is launched by the app.
#   main_wrapper.py patches aiohttp's header limits (the DSH web proxy injects a
#   >8190-byte dsh-auth-* header and stock aiohttp answers 400 LineTooLong).
# What we deliberately do NOT do: block until 8188 answers. A cold start loads
# weights for 30-60s, and this service is optional.
function Start-ComfyService([System.Collections.ArrayList]$info) {
  if (Test-Port (P 'comfy') 1000) {
    $null = $info.Add((T 'comfyAlready' (P 'comfy')))
    return $true
  }
  $py = Join-Path $ComfyDir 'python_embeded\python.exe'
  $wrapper = Join-Path $ComfyDir 'main_wrapper.py'
  if (-not (Test-Path $py) -or -not (Test-Path $wrapper)) {
    $null = $info.Add((T 'comfyMissing' $ComfyDir))
    return $false
  }
  $null = $info.Add((T 'comfyStarting'))
  try {
    $proc = Start-ServiceProcess -filePath $py `
      -arguments @('-s', '-X', 'utf8', 'main_wrapper.py', '--windows-standalone-build',
                   '--listen', '127.0.0.1', '--disable-api-nodes', '--enable-manager') `
      -workingDirectory $ComfyDir -logName 'comfy-out'
    Remember-Pid 'comfy' ([int]$proc.Id)
    $script:ComfySpawned = $true
  } catch {
    $null = $info.Add((T 'comfyStartFailed' $_.Exception.Message))
    return $false
  }
  # A port that is still closed right after spawn is NOT a failure: the process
  # is loading weights and will bind in tens of seconds. Measure "launched" by
  # the fact that we started it, and only report readiness as a bonus.
  $warm = $false
  foreach ($i in 1..2) {
    if (Wait-Until { Test-Port (P 'comfy') 500 } -timeoutMs 5000) { $warm = $true; break }
  }
  if ($warm) { $null = $info.Add((T 'comfyReady' (P 'comfy'))) }
  else { $null = $info.Add((T 'comfyStarted' ([int]$proc.Id) (P 'comfy'))) }
  return $true
}

function Stop-ComfyService([System.Collections.ArrayList]$info) {
  $stopped = $false
  $table = Read-PidFile
  if ($table.comfy) {
    if (Stop-ProcessSafe -processId ([int]$table.comfy) -label 'ComfyUI') { $stopped = $true }
  }
  if (Test-Port (P 'comfy') 500) {
    if (Stop-PortOwner -port (P 'comfy') -label 'ComfyUI') { $stopped = $true }
  }
  if ($stopped) {
    if (Wait-PortsFree @((P 'comfy')) 10000) { $null = $info.Add((T 'comfyStopped')) }
    else { $null = $info.Add((T 'comfyStopTimeout' (P 'comfy'))) }
  } else {
    $null = $info.Add((T 'comfyWasDown'))
  }
  return $true
}

function Invoke-EndpointSync([System.Collections.ArrayList]$info) {
  if (-not (Test-Path $SyncScript)) {
    $null = $info.Add((T 'syncMissing' $SyncScript))
    return $false
  }
  $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $SyncScript 2>&1
  $text = ($raw | Out-String)
  Write-LauncherLog ('sync-dsh-endpoint: ' + ($text -replace "`r?`n", ' | '))
  if ($text -match 'VERIFY_OK') {
    $m = [regex]::Match($text, 'baseUrl\s*:\s*(?<old>\S+)\s*->\s*(?<new>\S+)')
    if ($m.Success) { $null = $info.Add((T 'syncChanged' $m.Groups['old'].Value $m.Groups['new'].Value)) }
    else { $null = $info.Add((T 'syncCurrent')) }
    return $true
  }
  $null = $info.Add((T 'syncFailed'))
  return $false
}

function Start-AllServices([System.Collections.ArrayList]$info) {
  $ok = $true
  # DSH 只在"挂 DSH"模式下才是链路的一环。直连模式下机器人不经过它 ——
  # 强行拉它既有害（拖慢一键启动、DshExe 缺失还会把整轮判失败）又没必要。
  # "不去拉"不等于"要去停"：它已经在跑就原样留着（用户可能还在用它的网页端）。
  $runtime = Get-RuntimeType
  if ($runtime -eq 'direct') {
    if (@(Get-DshProc).Count -ge 1) {
      $null = $info.Add((T 'dshKeptDirect'))
    } else {
      $null = $info.Add((T 'dshSkippedDirect'))
    }
  } else {
    if (-not (Start-DshService $info)) { $ok = $false }
    $null = $info.Add((T 'syncing'))
    if (-not (Invoke-EndpointSync $info)) { $ok = $false }
  }
  if (-not (Start-SnowLumaService $info)) { $ok = $false }
  if (-not (Start-BridgeService $info)) { $ok = $false }
  # ComfyUI is LAST and deliberately must not fail the run: it is optional (chat
  # and replies do not depend on it), and a cold start spends 30-60s loading
  # weights before port 8188 answers. Blocking here would turn "a one-click start
  # that takes a dozen seconds" into a two-minute wait for an optional service.
  $null = $info.Add((T 'beginComfy'))
  if (-not (Start-ComfyService $info)) { $ok = $ok }
  return $ok
}

# -- stop --------------------------------------------------------------------
function Stop-BridgeService([System.Collections.ArrayList]$info) {
  $stopped = $false
  $procs = @(Get-BridgeProc)
  if ($procs.Count -ge 1) {
    foreach ($p in $procs) {
      if (Stop-ProcessSafe -processId ([int]$p.ProcessId) -label 'qq-bridge') { $stopped = $true }
    }
  } else {
    $table = Read-PidFile
    if ($table.bridge) {
      if (Stop-ProcessSafe -processId ([int]$table.bridge) -label 'qq-bridge') { $stopped = $true }
    }
  }
  if (-not $stopped -and (Test-Port (P 'bridgeConsole'))) {
    $stopped = Stop-PortOwner -port (P 'bridgeConsole') -label 'qq-bridge'
  }
  if ($stopped) { $null = $info.Add((T 'bridgeStopped')) } else { $null = $info.Add((T 'bridgeWasDown')) }

  $lock = Join-Path $StateDir 'bridge.lock'
  if ($stopped -and (Test-Path $lock)) {
    $content = ''
    try { $content = (Get-Content $lock -Raw).Trim() } catch {}
    $alive = $false
    if ($content) { $alive = [bool](Get-Process -Id ([int]$content) -ErrorAction SilentlyContinue) }
    if (-not $alive) {
      try { Remove-Item $lock -Force; $null = $info.Add((T 'lockCleaned')) } catch {}
    }
  }
  return $true
}

# Kill one process with two escalating attempts: a polite close first, then a
# forced kill. Shared by the SnowLuma stop / re-spawn path so a zombie that
# ignores WM_CLOSE is still cleaned up (the old code gave up after one try and
# left the stale instance holding the WebUI port).
function Stop-PidHard([int]$processId, [string]$label) {
  if (-not $processId -or $processId -le 0) { return $false }
  if ($processId -eq $PID -or $processId -eq $script:CallerPid) { return $false }
  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  try {
    $proc.CloseMainWindow() | Out-Null
    if ($proc.WaitForExit(2500)) { Write-LauncherLog "stopped gracefully: $label (PID $processId)"; return $true }
  } catch {}
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
    Write-LauncherLog "force killed: $label (PID $processId)"
    return $true
  } catch {
    Write-LauncherLog "failed to stop $label (PID $processId): $($_.Exception.Message)"
    return $false
  }
}

function Wait-PortsFree([int[]]$ports, [int]$timeoutMs = 15000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    $busy = $false
    foreach ($p in $ports) { if (Test-Port $p 400) { $busy = $true; break } }
    if (-not $busy) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Stop-SnowLumaService([System.Collections.ArrayList]$info) {
  $stopped = $false
  foreach ($p in @(Get-SnowProc)) {
    if (Stop-ProcessSafe -processId ([int]$p.ProcessId) -label 'SnowLuma') { $stopped = $true }
  }
  if (-not $stopped) {
    $table = Read-PidFile
    if ($table.snowluma) {
      if (Stop-ProcessSafe -processId ([int]$table.snowluma) -label 'SnowLuma') { $stopped = $true }
    }
  }
  if (-not $stopped -and (Test-Port (P 'snowlumaWeb'))) {
    $stopped = Stop-PortOwner -port (P 'snowlumaWeb') -label 'SnowLuma'
  }
  # Last resort: a stale instance that owns the HTTP/WS port but was started
  # outside this launcher (so neither CIM nor the pid file knows it).
  if (-not $stopped) {
    foreach ($port in @((P 'snowlumaApi'), (P 'snowlumaWs'), (P 'snowlumaWeb'))) {
      if (Test-Port $port 400) {
        if (Stop-PortOwner -port $port -label 'SnowLuma') { $stopped = $true }
      }
    }
  }
  if ($stopped) { $null = $info.Add((T 'snowStopped')) } else { $null = $info.Add((T 'snowWasDown')) }
  return $true
}

function Stop-DshService([System.Collections.ArrayList]$info) {
  $procs = @(Get-DshProc)
  if ($procs.Count -lt 1) { $null = $info.Add((T 'dshWasDown')); return $true }
  $null = $info.Add((T 'dshStopWarn'))
  foreach ($p in $procs) { $null = Stop-ProcessSafe -processId ([int]$p.ProcessId) -label 'DSH' }
  $null = Wait-Until { -not (Test-Port (P 'dshApi') 500) } -timeoutMs 15000
  $null = $info.Add((T 'dshStopped'))
  return $true
}

function Stop-AllServices([System.Collections.ArrayList]$info) {
  $null = Stop-BridgeService $info
  $null = Stop-SnowLumaService $info
  # DSH is deliberately left running so this never closes the web session in use.
  $null = $info.Add((T 'dshKeep'))
  $null = Stop-ComfyService $info
  return $true
}

# -- logs --------------------------------------------------------------------
function Get-LogPayload {
  $path = switch ($LogName) {
    'bridge'   { Join-Path $StateDir 'bridge.log' }
    'qq'       { Join-Path $StateDir 'qq-activity.log' }
    'launcher' { $LogFile }
  }
  $lines = @()
  if (Test-Path $path) {
    $lines = @(Get-Content -LiteralPath $path -Tail $Tail -Encoding UTF8 -ErrorAction SilentlyContinue)
  } else {
    $lines = @((T 'logMissing' $path))
  }
  return [ordered]@{
    ok     = $true
    action = 'logs'
    name   = $LogName
    path   = $path
    lines  = $lines
    time   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  }
}

# -- diagnose ----------------------------------------------------------------
# Self-check: reports what the launcher actually resolved (paths, ports, config
# load, process detection). Meant for troubleshooting when status looks wrong.
function Get-Diagnose {
  $checks = New-Object System.Collections.ArrayList
  $null = $checks.Add("toolsDir    = $ToolsDir")
  $null = $checks.Add("workspace   = $Workspace")
  $null = $checks.Add("bridgeDir   = $BridgeDir")
  $null = $checks.Add("nodeExe     = $NodeExe (exists=$(Test-Path $NodeExe))")
  $null = $checks.Add("dshExe      = $DshExe (exists=$(Test-Path $DshExe))")
  $null = $checks.Add("snowLumaDir = $SnowLumaDir (exists=$(Test-Path (Join-Path $SnowLumaDir 'index.mjs')))")
  $null = $checks.Add("syncScript  = $SyncScript (exists=$(Test-Path $SyncScript))")
  $null = $checks.Add("init.json   = $InitFile (exists=$(Test-Path $InitFile), keys=$(@($Init.PSObject.Properties.Name) -join ','))")
  $null = $checks.Add("messages    = $MsgFile (exists=$(Test-Path $MsgFile), keys=$(@($Msg.PSObject.Properties.Name).Count))")
  $null = $checks.Add("T('on')     = '$(T 'on')'")
  # Which AI runtime startAll will honour: in 'direct' the bot never goes through
  # DSH, so startAll skips pulling it up (it is left running if it already is).
  $null = $checks.Add("aiRuntime   = $(Get-RuntimeType) $(if ((Get-RuntimeType) -eq 'direct') { '(startAll 不拉 DSH)' } else { '(startAll 按 DSH→SnowLuma→桥接 顺序拉)' })")

  $b = @(Get-BridgeProc)
  $null = $checks.Add("cimScan     = total=$($script:LastScanTotal) err='$($script:LastScanError)'")
  $null = $checks.Add("bridge procs= $($b.Count)" + $(if ($b.Count -ge 1) { " (pid " + (($b | ForEach-Object { $_.ProcessId }) -join ',') + ")" } else { '' }))
  $s = @(Get-SnowProc)
  $null = $checks.Add("snow procs  = $($s.Count)" + $(if ($s.Count -ge 1) { " (pid " + (($s | ForEach-Object { $_.ProcessId }) -join ',') + ")" } else { '' }))
  $d = @(Get-DshProc)
  $null = $checks.Add("dsh procs   = $($d.Count)" + $(if ($d.Count -ge 1) { " (pid " + (($d | ForEach-Object { $_.ProcessId }) -join ',') + ")" } else { '' }))

  foreach ($name in @('dshApi', 'snowlumaApi', 'snowlumaWs', 'snowlumaWeb', 'bridgeConsole')) {
    $port = P $name
    $null = $checks.Add(("port {0,-14} = {1} ({2})" -f $name, $port, $(if (Test-Port $port) { 'open' } else { 'closed' })))
  }

  $ep = Get-DshEndpoint
  $null = $checks.Add("dshEndpoint = port=$($ep.port) tokenLen=$($ep.token.Length)")
  $null = $checks.Add("managerLog  = $ManagerLog (exists=$(Test-Path $ManagerLog))")
  $null = $checks.Add("cimTotal    = $(@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue).Count)")
  $null = $checks.Add("qqProcesses = $(@(Get-Process -Name QQ -ErrorAction SilentlyContinue).Count)")
  $null = $checks.Add("powershell  = $($PSVersionTable.PSVersion)")

  return [ordered]@{
    ok     = $true
    action = 'diagnose'
    time   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    lines  = @($checks)
  }
}

# -- main --------------------------------------------------------------------
$script:CallerPid = 0
try { $script:CallerPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId } catch {}
# Set by Start-ComfyService: "we spawned it" is this action's success criterion,
# because a freshly spawned ComfyUI needs tens of seconds before it binds 8188.
$script:ComfySpawned = $false

$info = New-Object System.Collections.ArrayList
$payload = $null
$exitCode = 0

try {
  switch ($Action) {
    'status' { $payload = Get-LauncherStatus }

    'diagnose' { $payload = Get-Diagnose }

    'logs' { $payload = Get-LogPayload }

    'syncEndpoint' {
      $null = $info.Add((T 'syncing'))
      if (-not (Invoke-EndpointSync $info)) { $exitCode = 1 }
      $payload = Get-LauncherStatus
    }

    'startAll' {
      $null = $info.Add((T 'beginStart'))
      if (-not (Start-AllServices $info)) { $exitCode = 1 }
      $payload = Get-LauncherStatus -IncludeInfo
    }

    'stopAll' {
      $null = $info.Add((T 'beginStop'))
      $null = Stop-AllServices $info
      $payload = Get-LauncherStatus
    }

    'restartAll' {
      $null = $info.Add((T 'beginRestart'))
      $null = Stop-AllServices $info
      $null = $info.Add((T 'waitPorts'))
      $null = Wait-Until {
        (-not (Test-Port (P 'snowlumaWs') 300)) -and (-not (Test-Port (P 'bridgeConsole') 300))
      } -timeoutMs 20000
      Start-Sleep -Milliseconds 800
      if (-not (Start-AllServices $info)) { $exitCode = 1 }
      $payload = Get-LauncherStatus -IncludeInfo
    }

    'start' {
      $ok = switch ($Target) {
        'dsh'      { Start-DshService $info }
        'snowluma' { Start-SnowLumaService $info }
        'bridge'   { Start-BridgeService $info }
        'comfy'    { Start-ComfyService $info }
      }
      if (-not $ok) { $exitCode = 1 }
      # Report the health of the service that was actually asked for, not of the
      # whole chain: with the old code "start bridge succeeded" still exited 1
      # whenever DSH/SnowLuma happened to be down, which reads as a failure in
      # the UI even though the requested start worked.
      # ComfyUI is optional (it spends 30-60s loading weights), so a still-loading
      # ComfyUI must not be reported as a failed start either.
      $payload = Get-LauncherStatus -IncludeInfo
      $required = @()
      if ($Target -eq 'comfy') {
        # Spawning it is success; the port follows tens of seconds later.
        $required = @('comfy')
        $comfyLaunched = [bool]$script:ComfySpawned
      } else {
        $required = @('dsh', 'snowluma', 'bridge')
        $comfyLaunched = $false
      }
      $runningNow = 0
      try {
        foreach ($name in $required) {
          $prop = $payload.services.PSObject.Properties[$name]
          if ($prop -and $prop.Value.running) { $runningNow++ }
        }
      } catch { $runningNow = 0 }
      if ($exitCode -eq 0 -and $runningNow -lt 1 -and -not $comfyLaunched) { $exitCode = 1 }
    }

    'stop' {
      switch ($Target) {
        'dsh'      { $null = Stop-DshService $info }
        'snowluma' { $null = Stop-SnowLumaService $info }
        'bridge'   { $null = Stop-BridgeService $info }
        'comfy'    { $null = Stop-ComfyService $info }
      }
      $payload = Get-LauncherStatus
    }

    'restart' {
      switch ($Target) {
        'dsh'      { $null = Stop-DshService $info;      Start-Sleep -Milliseconds 800; $null = Start-DshService $info }
        'snowluma' { $null = Stop-SnowLumaService $info; Start-Sleep -Milliseconds 800; $null = Start-SnowLumaService $info }
        'bridge'   { $null = Stop-BridgeService $info;   Start-Sleep -Milliseconds 800; $null = Start-BridgeService $info }
        'comfy'    { $null = Stop-ComfyService $info;    Start-Sleep -Milliseconds 800; $null = Start-ComfyService $info }
      }
      $payload = Get-LauncherStatus
    }

    'openDsh' {
      $ep = Get-DshEndpoint
      if ($ep.url) {
        try { Start-Process $ep.url | Out-Null; $null = $info.Add((T 'browserOpened')) }
        catch { $null = $info.Add((T 'browserFailed' $_.Exception.Message)) }
      } else {
        $null = $info.Add((T 'noEndpoint'))
      }
      $payload = Get-LauncherStatus
    }
  }
} catch {
  $exitCode = 1
  $null = $info.Add((T 'actionError' $_.Exception.Message))
  Write-LauncherLog ("ERROR action=$Action -> " + $_.Exception.Message)
  try { $payload = Get-LauncherStatus } catch { $payload = [ordered]@{ ok = $false; action = $Action } }
}

if ($info.Count -and -not ($payload.PSObject.Properties.Name -contains 'info')) { $payload.info = @($info) }
if ($null -eq $payload.ok) { $payload.ok = ($exitCode -eq 0) }
$payload.exitCode = $exitCode
Write-LauncherLog "action=$Action target=$Target exit=$exitCode"

$json = $payload | ConvertTo-Json -Depth 8

if ($OutFile) {
  # UTF-8 without BOM: the HTA reads this with ADODB.Stream, so Chinese survives.
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
} else {
  Write-Output $json
}
exit $exitCode
