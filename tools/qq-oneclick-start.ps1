# qq-oneclick-start.ps1
# ---------------------------------------------------------------------------
# QQ 桥接「一键启动 + 自检」引擎。
# 双击 tools\一键启动并自检.bat 即为本脚本；也可直接命令行调用。
#
# 它做四件事：
#   1. 按依赖顺序把 DSH / SnowLuma / QQ 桥接拉起来（缺什么起什么，在跑的不动）
#   2. 把当前 DSH 端点（端口 + token）同步进 qq-bridge\config.json
#   3. 用浏览器打开 DSH 网页端 + QQ 桥接控制台（都带 token，免手输）
#   4. 打印一份诚实的自检报告，并写入 tools\runtime\oneclick-last-run.log
#
# 三条设计约束（都是实际踩过的坑）：
#   * 不用 Get-CimInstance/WMI 判定存活：某些上下文里 WMI 会被拒绝，扫描失败
#     返回空结果会被误判成"健康"（旧启动器就因此报过假绿灯）。本脚本一律用
#     TCP 连接 + HTTP 状态码 + 日志尾部来判定，拿不到证据就报"未通过"。
#   * DSH 每次重启都会换随机端口：所以每次运行都要重新解析 manager.log 并同步
#     配置，否则桥接会连着一个已经死掉的端口。
#   * 判定"桥接已连上"时，只看最后一次「桥接已启动」之后的日志，避免把上一次
#     启动遗留的旧日志当成当前状态。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File qq-oneclick-start.ps1
# 可选开关：
#   -CheckOnly   只自检：不启动任何进程、不改配置、不开浏览器
#   -NoOpen      正常启动+自检，但不打开浏览器
#   -Restart     先把 QQ 桥接和 SnowLuma 停掉再重新拉起
#
# 编码要求：本文件必须保存为 UTF-8 with BOM。
#   Windows PowerShell 5.1 读无 BOM 的 .ps1 时会按系统 ANSI 代码页(cp936)解析，
#   中文会变乱码甚至打断语法。若你编辑后中文变成乱码，请确认编辑器存了 BOM。
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$NoOpen,
  [switch]$Restart,
  [int]$DshTimeoutSec = 120,
  [int]$SnowTimeoutSec = 60,
  [int]$BridgeTimeoutSec = 60
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

# -- paths -------------------------------------------------------------------
$ToolsDir    = $PSScriptRoot
$BridgeDir   = Split-Path -Parent $ToolsDir
$Workspace   = Split-Path -Parent $BridgeDir
$StateDir    = Join-Path $BridgeDir 'state'
$RuntimeDir  = Join-Path $ToolsDir 'runtime'
$ConfigFile  = Join-Path $BridgeDir 'config.json'
$ServicesF   = Join-Path $ToolsDir 'services.json'
$InitFile    = Join-Path $RuntimeDir 'init.json'
$ManagerLog  = Join-Path $env:APPDATA 'DSH\manager.log'
$PluginLog   = Join-Path $env:USERPROFILE '.dsh\profiles\web\state\qq-mode-plugin.log'
$ReportFile  = Join-Path $RuntimeDir 'oneclick-last-run.log'
$HistoryFile = Join-Path $RuntimeDir 'oneclick-history.log'
$SnowPidFile = Join-Path $RuntimeDir 'snowluma-pid.txt'

if (-not (Test-Path $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null }

# -- services.json 是唯一数据源；init.json 作兜底 -----------------------------
$Svc = $null
if (Test-Path $ServicesF) {
  try { $Svc = Get-Content -LiteralPath $ServicesF -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $Svc = $null }
}
if (-not $Svc -and (Test-Path $InitFile)) {
  try { $Svc = Get-Content -LiteralPath $InitFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $Svc = $null }
}

$NodeExe     = 'node'
$DshExe      = 'D:\DSH\DSH.exe'
$SnowLumaDir = 'C:\SnowLuma'
$PortSnowHttp = 3000; $PortSnowWs = 3001; $PortSnowWeb = 5099
$PortConsole  = 3100; $PortDshMgr = 3780
if ($Svc) {
  if ($Svc.nodeExe)     { $NodeExe = [string]$Svc.nodeExe }
  if ($Svc.dshExe)      { $DshExe = [string]$Svc.dshExe }
  if ($Svc.snowLumaDir) { $SnowLumaDir = [string]$Svc.snowLumaDir }
  if ($Svc.ports) {
    if ($Svc.ports.snowlumaApi)  { $PortSnowHttp = [int]$Svc.ports.snowlumaApi }
    if ($Svc.ports.snowlumaWs)   { $PortSnowWs = [int]$Svc.ports.snowlumaWs }
    if ($Svc.ports.snowlumaWeb)  { $PortSnowWeb = [int]$Svc.ports.snowlumaWeb }
    if ($Svc.ports.bridgeConsole){ $PortConsole = [int]$Svc.ports.bridgeConsole }
    if ($Svc.ports.dshLauncher)  { $PortDshMgr = [int]$Svc.ports.dshLauncher }
  }
}
if (-not (Test-Path $NodeExe)) { $NodeExe = 'node' }

# -- output ------------------------------------------------------------------
$script:Report = New-Object System.Collections.ArrayList
$script:Pass = 0; $script:Fail = 0; $script:Warn = 0

function Out-Line([string]$Text) {
  Write-Output $Text
  [void]$script:Report.Add($Text)
}
function Section([string]$Text) {
  Out-Line ''
  Out-Line ("[{0}]" -f $Text)
}
function Add-Check([string]$Name, [string]$State, [string]$Detail, [string]$Hint) {
  $mark = '[OK]  '
  if ($State -eq 'fail') { $mark = '[FAIL]'; $script:Fail++ }
  elseif ($State -eq 'warn') { $mark = '[WARN]'; $script:Warn++ }
  else { $script:Pass++ }
  $line = "      $mark $Name"
  if ($Detail) { $line = "$line`：$Detail" }
  Out-Line $line
  if ($Hint -and $State -ne 'ok') { Out-Line "             -> $Hint" }
}

# -- low level probes (no WMI anywhere) --------------------------------------
function Test-Tcp([int]$Port, [int]$TimeoutMs = 600) {
  if ($Port -le 0) { return $false }
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne($TimeoutMs) -and $client.Connected) { return $true }
    return $false
  } catch { return $false } finally { try { $client.Close() } catch {} }
}

function Wait-Port([int]$Port, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Tcp $Port) { return $true }
    Start-Sleep -Milliseconds 900
  }
  return (Test-Tcp $Port)
}

function Wait-PortFree([int]$Port, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Tcp $Port)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (-not (Test-Tcp $Port))
}

function Read-Tail([string]$Path, [int]$Lines = 80) {
  if (-not (Test-Path $Path)) { return @() }
  try { return @(Get-Content -LiteralPath $Path -Tail $Lines -Encoding UTF8 -ErrorAction Stop) } catch { return @() }
}

function Test-Http([string]$Url, $Headers, [int]$TimeoutSec = 6) {
  $result = [pscustomobject]@{ ok = $false; code = 0; body = ''; error = '' }
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    $req.Timeout = $TimeoutSec * 1000
    $req.ReadWriteTimeout = $TimeoutSec * 1000
    $req.AllowAutoRedirect = $true
    # DSH 的 ?token= 是「303 重定向 + Set-Cookie」流程：不带 CookieContainer 时
    # 跟随重定向会丢掉 cookie，最后落在未认证的 "/" 上拿到 401（假失败）。
    $req.CookieContainer = New-Object System.Net.CookieContainer
    $req.Proxy = $null
    $req.UserAgent = 'qq-oneclick-start'
    if ($Headers) { foreach ($k in $Headers.Keys) { $req.Headers[$k] = [string]$Headers[$k] } }
    $resp = $req.GetResponse()
    $result.code = [int]$resp.StatusCode
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $result.body = $reader.ReadToEnd()
    $reader.Close(); $resp.Close()
    $result.ok = ($result.code -ge 200 -and $result.code -lt 400)
  } catch [System.Net.WebException] {
    $r = $_.Exception.Response
    if ($r) { try { $result.code = [int]$r.StatusCode } catch {} }
    $result.error = $_.Exception.Message
  } catch { $result.error = $_.Exception.Message }
  return $result
}

function Get-DshEndpoint {
  $ep = [pscustomobject]@{ port = 0; token = ''; url = ''; ok = $false }
  if (-not (Test-Path $ManagerLog)) { return $ep }
  try {
    $line = Get-Content -LiteralPath $ManagerLog -Tail 400 -Encoding UTF8 -ErrorAction SilentlyContinue |
            Select-String 'dsh web: http' | Select-Object -Last 1
    if ($line) {
      $m = [regex]::Match($line.Line, 'http://127\.0\.0\.1:(?<port>\d+)/?\?token=(?<token>[A-Za-z0-9_\-]+)')
      if ($m.Success) {
        $ep.port = [int]$m.Groups['port'].Value
        $ep.token = $m.Groups['token'].Value
        $ep.url = 'http://127.0.0.1:{0}/?token={1}' -f $ep.port, $ep.token
        $ep.ok = $true
      }
    }
  } catch {}
  return $ep
}

# 只替换 JSON 里某个字符串字段的值，其余字节原样保留（避免 ConvertTo-Json 重排/丢中文）。
function Set-JsonField([string]$Text, [string]$Key, [string]$Value) {
  $m = [regex]::Match($Text, '"' + [regex]::Escape($Key) + '"\s*:\s*"(?<v>[^"]*)"')
  if (-not $m.Success) { return [pscustomobject]@{ text = $Text; old = $null; changed = $false } }
  $g = $m.Groups['v']
  $old = $g.Value
  if ($old -eq $Value) { return [pscustomobject]@{ text = $Text; old = $old; changed = $false } }
  $new = $Text.Substring(0, $g.Index) + $Value + $Text.Substring($g.Index + $g.Length)
  return [pscustomobject]@{ text = $new; old = $old; changed = $true }
}

function Start-Detached([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [string]$OutLog, [string]$ErrLog) {
  return Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
                       -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
}

function Stop-PortOwner([int]$Port, [string]$Label) {
  $killed = $false
  try {
    $conns = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    foreach ($owner in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
      $pid2 = [int]$owner
      if ($pid2 -gt 0) {
        try {
          Stop-Process -Id $pid2 -Force -ErrorAction Stop
          Out-Line ("      已停止 {0}（PID {1}，端口 {2}）" -f $Label, $pid2, $Port)
          $killed = $true
        } catch {
          Out-Line ("      [WARN] 停止 {0}（PID {1}）失败：{2}" -f $Label, $pid2, $_.Exception.Message)
        }
      }
    }
  } catch {
    Out-Line ("      [WARN] 无法枚举端口占用（{0} {1}）：{2}" -f $Label, $Port, $_.Exception.Message)
  }
  return $killed
}

function Get-DefaultBrowserExe {
  try {
    $prog = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction Stop).ProgId
    if ($prog) {
      $cmd = (Get-ItemProperty ("HKLM:\SOFTWARE\Classes\{0}\shell\open\command" -f $prog) -ErrorAction Stop).'(default)'
      if ($cmd -match '^\s*"([^"]+)"') { return $Matches[1] }
      if ($cmd -match '^\s*([A-Za-z]:\\[^\s]+\.exe)') { return $Matches[1] }
    }
  } catch {}
  return $null
}

# 先用默认浏览器 exe 直接拉起（最确定），再退回 ShellExecute / cmd start。
function Open-Url([string]$Url) {
  $exe = Get-DefaultBrowserExe
  if ($exe -and (Test-Path $exe)) {
    try { [void](Start-Process -FilePath $exe -ArgumentList $Url -PassThru -ErrorAction Stop); return "browser:$([System.IO.Path]::GetFileName($exe))" } catch {}
  }
  try { [void](Start-Process $Url -ErrorAction Stop); return 'shell' } catch {}
  try { [void](& cmd.exe /c start '' $Url); return 'cmd-start' } catch {}
  return $null
}

# -- banner ------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Out-Line '============================================================'
Out-Line '  QQ 桥接 一键启动 + 自检'
Out-Line ("  {0}" -f $stamp)
if ($CheckOnly) { Out-Line '  模式：只自检（不启动、不改配置、不开浏览器）' }
elseif ($NoOpen) { Out-Line '  模式：启动 + 自检（不打开浏览器）' }
Out-Line '============================================================'

# -- 0. 环境 ----------------------------------------------------------------
Section '0/6 环境'
$nodeOk = $false
try { $null = & $NodeExe --version 2>$null; $nodeOk = ($LASTEXITCODE -eq 0) } catch { $nodeOk = $false }
Add-Check 'Node 运行时' $(if ($nodeOk) { 'ok' } else { 'fail' }) $NodeExe $(if ($nodeOk) { '' } else { '检查 tools\services.json 里的 nodeExe 是否正确' })

$snowEntry = Join-Path $SnowLumaDir 'index.mjs'
Add-Check 'SnowLuma 入口' $(if (Test-Path $snowEntry) { 'ok' } else { 'fail' }) $snowEntry $(if (Test-Path $snowEntry) { '' } else { 'SnowLuma 未安装或路径变了，改 tools\services.json 的 snowLumaDir' })

$bridgeEntry = Join-Path $BridgeDir 'src\bridge.js'
Add-Check '桥接入口' $(if (Test-Path $bridgeEntry) { 'ok' } else { 'fail' }) $bridgeEntry ''

$cfg = $null
if (Test-Path $ConfigFile) {
  try { $cfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $cfg = $null }
}
Add-Check '桥接配置 config.json' $(if ($cfg) { 'ok' } else { 'fail' }) $ConfigFile $(if ($cfg) { '' } else { 'config.json 缺失或不是合法 JSON' })

$token = ''
if ($cfg -and $cfg.consoleToken) { $token = [string]$cfg.consoleToken }
if (-not $token) {
  $tf = Join-Path $StateDir 'console-token'
  if (Test-Path $tf) { $token = (Get-Content -LiteralPath $tf -Raw -Encoding UTF8).Trim() }
}

# -- 1. DSH -----------------------------------------------------------------
Section '1/6 DSH（插件宿主）'
$ep = Get-DshEndpoint
Add-Check 'DSH 端点（manager.log）' $(if ($ep.ok) { 'ok' } else { 'fail' }) $(if ($ep.ok) { $ep.url } else { '没找到 "dsh web: http" 记录' }) $(if ($ep.ok) { '' } else { 'DSH 可能从未启动过：先手动打开 D:\DSH\DSH.exe' })

$dshUp = $false
if ($ep.ok) {
  $dshUp = Test-Tcp $ep.port
  if ($dshUp) {
    $r = Test-Http $ep.url $null 8
    Add-Check ("DSH 网页端 :{0}" -f $ep.port) $(if ($r.ok) { 'ok' } else { 'fail' }) ("HTTP {0}" -f $r.code) $(if ($r.ok) { '' } else { '端口在但不响应：看 DSH 窗口是否卡住' })
    $dshUp = $r.ok
  } else {
    Add-Check ("DSH 端口 :{0}" -f $ep.port) 'fail' 'TCP 不通' 'DSH 网页端进程不在，下面会尝试拉起'
    $dshUp = $false
  }
}

if (-not $dshUp -and -not $CheckOnly) {
  Out-Line '      正在启动 DSH…'
  $mgrUp = Test-Tcp $PortDshMgr
  if ($mgrUp) {
    Out-Line ("      [WARN] DSH 管理器在跑（:{0}）但网页端不可用；尝试拉起，若失败请在 DSH 窗口里点「重启」" -f $PortDshMgr)
  }
  if (-not (Test-Path $DshExe)) {
    Add-Check 'DSH 启动' 'fail' ("找不到 {0}" -f $DshExe) '检查 tools\services.json 的 dshExe'
  } else {
    try {
      $shell = New-Object -ComObject WScript.Shell
      [void]$shell.Run(('"{0}"' -f $DshExe), 1, $false)
    } catch {
      Out-Line ("      [WARN] 启动 DSH 失败：{0}" -f $_.Exception.Message)
    }
    $deadline = (Get-Date).AddSeconds($DshTimeoutSec)
    $newEp = $ep
    while ((Get-Date) -lt $deadline) {
      $newEp = Get-DshEndpoint
      if ($newEp.ok -and (Test-Tcp $newEp.port)) { break }
      Start-Sleep -Milliseconds 1500
    }
    if ($newEp.ok -and (Test-Tcp $newEp.port)) {
      $ep = $newEp
      Add-Check 'DSH 启动' 'ok' ("网页端 :{0}" -f $ep.port) ''
      $dshUp = $true
    } else {
      Add-Check 'DSH 启动' 'fail' ("等待 {0}s 仍不可用" -f $DshTimeoutSec) '手动打开 D:\DSH\DSH.exe；若窗口已存在请点「重启网页端」'
    }
  }
}

# -- 2. 端点同步 -------------------------------------------------------------
Section '2/6 同步 DSH 端点到桥接配置'
if (-not $ep.ok) {
  Add-Check 'config.json → DSH 端点' 'fail' '没有可用的 DSH 端点，跳过' ''
} else {
  $wantUrl = 'http://127.0.0.1:{0}' -f $ep.port
  $curUrl = ''
  if ($cfg -and $cfg.dsh -and $cfg.dsh.baseUrl) { $curUrl = [string]$cfg.dsh.baseUrl }
  $curTok = ''
  if ($cfg -and $cfg.dsh -and $cfg.dsh.authToken) { $curTok = [string]$cfg.dsh.authToken }
  if ($curUrl -eq $wantUrl -and $curTok -eq $ep.token) {
    Add-Check 'config.json → DSH 端点' 'ok' ("已是最新（{0}）" -f $wantUrl) ''
  } elseif ($CheckOnly) {
    Add-Check 'config.json → DSH 端点' 'fail' ("配置为 {0}，当前 DSH 是 {1}" -f $curUrl, $wantUrl) '只自检模式不会改动；去掉 -CheckOnly 重跑即可自动同步'
  } else {
    try {
      $raw = [System.IO.File]::ReadAllText($ConfigFile, [System.Text.Encoding]::UTF8)
      $step1 = Set-JsonField $raw 'authToken' $ep.token
      $step2 = Set-JsonField $step1.text 'baseUrl' $wantUrl
      if (-not $step2.changed -and -not $step1.changed) {
        Add-Check 'config.json → DSH 端点' 'fail' '没能在 config.json 里定位 baseUrl/authToken 字段' '手动检查 config.json 的 dsh 段'
      } else {
        [System.IO.File]::WriteAllText($ConfigFile, $step2.text, (New-Object System.Text.UTF8Encoding($false)))
        $again = $null
        try { $again = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
        $verifyOk = ($again -and $again.dsh.baseUrl -eq $wantUrl -and $again.dsh.authToken -eq $ep.token)
        if ($verifyOk) {
          $cfg = $again
          Add-Check 'config.json → DSH 端点' 'ok' ("{0} -> {1}" -f $curUrl, $wantUrl) ''
        } else {
          Add-Check 'config.json → DSH 端点' 'fail' '写入后回读校验不通过' '用 git/备份对比 config.json，必要时跑 _handoff-qq-bridge\sync-dsh-endpoint.ps1'
        }
      }
    } catch {
      Add-Check 'config.json → DSH 端点' 'fail' $_.Exception.Message '检查 config.json 是否被占用或只读'
    }
  }
}

# -- 3. SnowLuma -------------------------------------------------------------
Section '3/6 SnowLuma（QQ 协议网关）'
if ($Restart -and -not $CheckOnly) {
  Out-Line '      按 -Restart 要求先停止 SnowLuma…'
  [void](Stop-PortOwner $PortSnowWs 'SnowLuma')
  [void](Wait-PortFree $PortSnowWs 15)
}

$qqCount = @(Get-Process -Name QQ -ErrorAction SilentlyContinue).Count
Add-Check 'QQ 客户端' $(if ($qqCount -gt 0) { 'ok' } else { 'warn' }) ("{0} 个进程" -f $qqCount) 'QQ 没登录时 SnowLuma 起来了也接管不到账号'

$snowUp = (Test-Tcp $PortSnowWs)
if ($snowUp) {
  Add-Check ("SnowLuma WS :{0}" -f $PortSnowWs) 'ok' 'TCP 通' ''
} elseif ($CheckOnly) {
  Add-Check ("SnowLuma WS :{0}" -f $PortSnowWs) 'fail' 'TCP 不通' '去掉 -CheckOnly 重跑即可自动拉起'
} else {
  Out-Line '      正在启动 SnowLuma…'
  $snowOut = Join-Path $RuntimeDir 'snowluma-out.log'
  $snowErr = Join-Path $RuntimeDir 'snowluma-err.log'
  try {
    $p = Start-Detached -FilePath $NodeExe -Arguments @('.\index.mjs') -WorkingDirectory $SnowLumaDir -OutLog $snowOut -ErrLog $snowErr
    try { [System.IO.File]::WriteAllText($SnowPidFile, [string]$p.Id, (New-Object System.Text.UTF8Encoding($false))) } catch {}
    if (Wait-Port $PortSnowWs $SnowTimeoutSec) {
      Add-Check ("SnowLuma WS :{0}" -f $PortSnowWs) 'ok' '已就绪' ''
      $snowUp = $true
    } else {
      $errTail = (Read-Tail $snowErr 6) -join ' / '
      Add-Check ("SnowLuma WS :{0}" -f $PortSnowWs) 'fail' ("等待 {0}s 未就绪" -f $SnowTimeoutSec) ("看 {0}；常见原因：QQ 未登录、端口被占、SnowLuma 目录无写权限" -f $snowErr)
      if ($errTail) { Out-Line ("      错误输出：{0}" -f $errTail) }
    }
  } catch {
    Add-Check ("SnowLuma WS :{0}" -f $PortSnowWs) 'fail' $_.Exception.Message '检查 nodeExe / snowLumaDir 路径'
  }
}

if (Test-Tcp $PortSnowHttp) { Add-Check ("SnowLuma HTTP :{0}" -f $PortSnowHttp) 'ok' 'TCP 通' '' }
else { Add-Check ("SnowLuma HTTP :{0}" -f $PortSnowHttp) 'fail' 'TCP 不通' '与 WS 同进程，WS 通了 HTTP 一般也通；不通看 snowluma-err.log' }
if (Test-Tcp $PortSnowWeb) { Add-Check ("SnowLuma WebUI :{0}" -f $PortSnowWeb) 'ok' 'TCP 通' '' }
else { Add-Check ("SnowLuma WebUI :{0}" -f $PortSnowWeb) 'warn' 'TCP 不通' '只有用 WebUI 扫码/管理时才需要' }

# QQ 接管：直接问 SnowLuma 的 OneBot 接口要账号信息——这比 grep 日志可靠得多，
# 一次调用同时证明了「SnowLuma 活着」「QQ 在线」「账号已登录」。
$snowLog = Join-Path $SnowLumaDir ('logs\snowluma-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))
$onebot = Test-Http ("http://127.0.0.1:{0}/get_login_info" -f $PortSnowHttp) $null 6
$onebotObj = $null
if ($onebot.ok) { try { $onebotObj = $onebot.body | ConvertFrom-Json } catch {} }
if ($onebotObj -and $onebotObj.status -eq 'ok' -and $onebotObj.data) {
  Add-Check 'QQ 在线（OneBot get_login_info）' 'ok' ("{0}（{1}）" -f $onebotObj.data.nickname, $onebotObj.data.user_id) ''
} else {
  # 退一步：翻更多行日志找最后一次 [Hook]（刚启动时 OneBot 可能还没就绪）
  $hookLine = @(Read-Tail $snowLog 3000 | Where-Object { $_ -match '\[Hook\]' } | Select-Object -Last 1)
  if ($hookLine.Count -gt 0 -and $hookLine[0] -match 'pipe connected|login detected|health armed') {
    Add-Check 'QQ 在线（OneBot get_login_info）' 'warn' ("接口没答（HTTP {0}），但日志里 Hook 正常：{1}" -f $onebot.code, $hookLine[0].Trim()) 'SnowLuma 可能刚起来，稍后重跑'
  } else {
    Add-Check 'QQ 在线（OneBot get_login_info）' 'fail' ("HTTP {0} {1}" -f $onebot.code, $onebot.error) '确认 QQ 已登录且 SnowLuma 已接管；必要时重启 SnowLuma'
  }
}

# -- 4. QQ 桥接 --------------------------------------------------------------
Section '4/6 QQ 桥接'
if ($Restart -and -not $CheckOnly) {
  Out-Line '      按 -Restart 要求先停止 QQ 桥接…'
  [void](Stop-PortOwner $PortConsole 'QQ 桥接')
  [void](Wait-PortFree $PortConsole 15)
}

$bridgeUp = Test-Tcp $PortConsole
if ($bridgeUp) {
  Add-Check ("桥接控制台 :{0}" -f $PortConsole) 'ok' 'TCP 通' ''
} elseif ($CheckOnly) {
  Add-Check ("桥接控制台 :{0}" -f $PortConsole) 'fail' 'TCP 不通' '去掉 -CheckOnly 重跑即可自动拉起'
} else {
  # 清掉上次异常退出留下的死锁（PID 已不存在时桥接自己也会清，这里先清更干净）
  $lockFile = Join-Path $StateDir 'bridge.lock'
  if (Test-Path $lockFile) {
    $lockPid = 0
    try { $lockPid = [int]((Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8).Trim()) } catch {}
    $alive = $false
    if ($lockPid -gt 0) { $alive = [bool](Get-Process -Id $lockPid -ErrorAction SilentlyContinue) }
    if (-not $alive) {
      try { Remove-Item -LiteralPath $lockFile -Force -ErrorAction Stop; Out-Line ("      已清理残留锁 bridge.lock（PID {0} 不存在）" -f $lockPid) } catch {}
    }
  }
  if (-not (Test-Tcp $PortSnowWs)) {
    Add-Check ("桥接控制台 :{0}" -f $PortConsole) 'fail' 'SnowLuma WS 不通，先修 SnowLuma' '桥接依赖 SnowLuma 的 WS 端口'
  } else {
    Out-Line '      正在启动 QQ 桥接…'
    $bOut = Join-Path $RuntimeDir 'bridge-new-out.log'
    $bErr = Join-Path $RuntimeDir 'bridge-new-err.log'
    try {
      $p = Start-Detached -FilePath $NodeExe -Arguments @('src\bridge.js') -WorkingDirectory $BridgeDir -OutLog $bOut -ErrLog $bErr
      if (Wait-Port $PortConsole $BridgeTimeoutSec) {
        Add-Check ("桥接控制台 :{0}" -f $PortConsole) 'ok' '已就绪' ''
        $bridgeUp = $true
      } else {
        $tail = (Read-Tail $bErr 6) -join ' / '
        Add-Check ("桥接控制台 :{0}" -f $PortConsole) 'fail' ("等待 {0}s 未就绪" -f $BridgeTimeoutSec) ("看 {0} 与 state\bridge.log" -f $bErr)
        if ($tail) { Out-Line ("      错误输出：{0}" -f $tail) }
      }
    } catch {
      Add-Check ("桥接控制台 :{0}" -f $PortConsole) 'fail' $_.Exception.Message '检查 nodeExe 与 src\bridge.js'
    }
  }
}

# -- 5. 链路自检 -------------------------------------------------------------
Section '5/6 链路自检'
if ($bridgeUp) {
  # 只看最后一次「桥接已启动」之后的日志，避免把上一轮的旧记录当成现状
  $tail = Read-Tail (Join-Path $StateDir 'bridge.log') 250
  $lastStart = -1
  for ($i = 0; $i -lt $tail.Count; $i++) { if ($tail[$i] -like '*桥接已启动*') { $lastStart = $i } }
  $scope = @()
  if ($lastStart -ge 0 -and $lastStart -lt $tail.Count) { $scope = @($tail[$lastStart..($tail.Count - 1)]) }

  if ($scope.Count -eq 0) {
    Add-Check '桥接 → SnowLuma' 'warn' '日志里没有找到本次启动记录' '看 state\bridge.log 尾部'
    Add-Check '桥接 → DSH' 'warn' '日志里没有找到本次启动记录' '看 state\bridge.log 尾部'
  } else {
    $linkSnow = @($scope | Where-Object { $_ -like '*SnowLuma 已连接*' }).Count -gt 0
    $linkDsh = @($scope | Where-Object { $_ -like '*DSH 已就绪*' }).Count -gt 0
    Add-Check '桥接 → SnowLuma' $(if ($linkSnow) { 'ok' } else { 'fail' }) $(if ($linkSnow) { '已连接' } else { '日志里没有「已连接」' }) 'SnowLuma 挂了或 WS 地址变了'
    Add-Check '桥接 → DSH' $(if ($linkDsh) { 'ok' } else { 'fail' }) $(if ($linkDsh) { '已就绪' } else { '日志里没有「DSH 已就绪」' }) '多半是 DSH 端口/token 变了：确认第 2 步同步成功，或重启桥接'
  }

  # 控制台 API：能拿到状态才算真通
  $st = Test-Http ("http://127.0.0.1:{0}/api/status" -f $PortConsole) @{ 'x-console-token' = $token } 6
  if ($st.ok) {
    $obj = $null
    try { $obj = $st.body | ConvertFrom-Json } catch {}
    if ($obj) {
      $detail = '模式 {0}；角色 {1}；DSH就绪 {2}；暂停 {3}' -f $obj.mode, $obj.role, $obj.dshReady, $obj.socialV2Paused
      Add-Check '控制台 API /api/status' 'ok' $detail ''
    } else {
      Add-Check '控制台 API /api/status' 'warn' 'HTTP 200 但返回不是 JSON' '控制台可能正在启动，稍后重跑'
    }
  } else {
    Add-Check '控制台 API /api/status' 'fail' ("HTTP {0} {1}" -f $st.code, $st.error) ("令牌不对？state\console-token 与控制台设置要一致")
  }
} else {
  Add-Check '桥接 → SnowLuma' 'fail' '桥接未运行，无法判定' ''
  Add-Check '桥接 → DSH' 'fail' '桥接未运行，无法判定' ''
  Add-Check '控制台 API /api/status' 'fail' '桥接未运行，无法判定' ''
}

# DSH 侧插件注册情况：只做提醒，不影响桥接本身
if (Test-Path $PluginLog) {
  $pl = @(Read-Tail $PluginLog 2)
  if ($pl.Count -gt 0 -and $pl[-1] -match 'settings service unavailable') {
    Add-Check 'DSH 侧 qq-mode 插件' 'warn' '未注册（settings service unavailable）' 'DSH 设置里没有 QQ 控制台卡片；控制台请用 :3100 这个页面'
  } elseif ($pl.Count -gt 0) {
    Add-Check 'DSH 侧 qq-mode 插件' 'ok' $pl[-1].Trim() ''
  }
}

# -- 6. 打开页面 -------------------------------------------------------------
Section '6/6 打开页面'
$consoleUrl = ''
if ($token) { $consoleUrl = 'http://127.0.0.1:{0}/?token={1}' -f $PortConsole, $token }
else { $consoleUrl = 'http://127.0.0.1:{0}/' -f $PortConsole }

if ($NoOpen -or $CheckOnly) {
  Out-Line ("      （未打开）DSH   ：{0}" -f $(if ($ep.ok) { $ep.url } else { '不可用' }))
  Out-Line ("      （未打开）控制台：{0}" -f $consoleUrl)
} else {
  if ($dshUp -and $ep.ok) {
    $how = Open-Url $ep.url
    Add-Check '打开 DSH 网页端' $(if ($how) { 'ok' } else { 'fail' }) $(if ($how) { $how } else { '调用浏览器失败' }) '手动把上面那行 URL 粘到浏览器'
  } else {
    Add-Check '打开 DSH 网页端' 'fail' 'DSH 未就绪，跳过' ''
  }
  if ($bridgeUp) {
    $how2 = Open-Url $consoleUrl
    Add-Check '打开桥接控制台' $(if ($how2) { 'ok' } else { 'fail' }) $(if ($how2) { $how2 } else { '调用浏览器失败' }) '手动把下面那行 URL 粘到浏览器'
  } else {
    Add-Check '打开桥接控制台' 'fail' '桥接未就绪，跳过' ''
  }
}

# -- summary -----------------------------------------------------------------
$total = $script:Pass + $script:Fail + $script:Warn
Out-Line ''
Out-Line '============================================================'
Out-Line ("  自检结果：{0} 项通过 / {1} 项未通过 / {2} 项提醒（共 {3} 项）" -f $script:Pass, $script:Fail, $script:Warn, $total)
Out-Line ("  DSH    ：{0}" -f $(if ($ep.ok) { $ep.url } else { '不可用' }))
Out-Line ("  控制台 ：{0}" -f $consoleUrl)
Out-Line ("  报告   ：{0}" -f $ReportFile)
if ($script:Fail -gt 0) {
  Out-Line ''
  Out-Line '  未通过项请看上面带 [FAIL] 的行与 -> 后面的处理建议。'
}
Out-Line '============================================================'

try { [System.IO.File]::WriteAllText($ReportFile, (($script:Report -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false))) } catch {}
try {
  $hist = "[{0}] pass={1} fail={2} warn={3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $script:Pass, $script:Fail, $script:Warn
  Add-Content -LiteralPath $HistoryFile -Value $hist -Encoding UTF8
} catch {}

if ($script:Fail -gt 0) { exit 1 }
exit 0
