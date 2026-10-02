# dsh-restart-guard.ps1
# ---------------------------------------------------------------------------
# Stop automation from killing the DSH web session the user is looking at.
#
# WHY: every DSH restart drops the browser session and moves the GUI to a NEW
# random port + token, so the tab the user has open is dead. The user sees
# "the manager says running but my page disconnected".
#
# WHAT IT DOES
#   1. finds the newest DSH session log (session.jsonl*) and its age;
#   2. if it was written within -IdleMinutes (default 5), the session is LIVE:
#      the guard REFUSES to restart and exits 3 (override with -Force);
#   3. otherwise it may restart: with -Restart it POSTs /api/restart to the
#      manager and waits until a new URL shows up.
#
# USAGE
#   powershell -File tools\dsh-restart-guard.ps1                 # just report
#   powershell -File tools\dsh-restart-guard.ps1 -Restart        # restart if idle
#   powershell -File tools\dsh-restart-guard.ps1 -Restart -Force # restart anyway
#
# EXIT CODES
#   0 = allowed / restarted        3 = refused (session looks live)
#   4 = manager not reachable      5 = restart requested but never came up
#
# ASCII ONLY: Windows PowerShell 5.1 decodes a BOM-less .ps1 with the ANSI code
# page, which would corrupt non-ASCII literals (see restart-bridge-and-dsh.ps1).
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  [string]$Root = '',
  [int]$ManagerPort = 0,
  [int]$IdleMinutes = 5,
  [switch]$Force,
  [switch]$Restart,
  [int]$ReadyTimeoutSec = 60
)

$ErrorActionPreference = 'Continue'

function Say([string]$m) { Write-Host $m }

if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if ($ManagerPort -le 0) {
  try {
    $svc = Get-Content -LiteralPath (Join-Path $Root 'tools\services.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $ManagerPort = [int]$svc.ports.dshLauncher
  } catch { $ManagerPort = 3780 }
}
if ($ManagerPort -le 0) { $ManagerPort = 3780 }

# -- 1) how old is the newest DSH session log? ------------------------------
$dshHome = $env:DSH_HOME
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$sessions = Join-Path $dshHome 'sessions'

$newest = $null
try {
  if (Test-Path $sessions) {
    # NOTE: the live file is "session.v4.jsonl.zstd" (version segment in the
    # middle), so a plain 'session.jsonl*' filter matches nothing - keep the
    # wildcards loose.
    $newest = Get-ChildItem -LiteralPath $sessions -Recurse -File -Filter 'session*jsonl*' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
  }
} catch {}

$ageMin = $null
if ($newest) { $ageMin = [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalMinutes, 1) }

Say "DSH_HOME      : $dshHome"
if ($newest) {
  Say ("newest session: " + $newest.FullName)
  Say ("written       : " + $newest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') + "  (" + $ageMin + " min ago)")
} else {
  Say 'newest session: (none found - treating as idle)'
}
Say ("idle threshold: $IdleMinutes min")

$live = ($null -ne $ageMin) -and ($ageMin -lt $IdleMinutes)

if ($live -and -not $Force) {
  Say ''
  Say '[REFUSED] a DSH session was active moments ago - the user is probably looking at that page.'
  Say '          Restarting now would disconnect it and move the GUI to a new port.'
  Say '          Wait for it to go idle, or re-run with -Force when the user agrees.'
  exit 3
}
if ($live) { Say ''; Say '[WARN] session looks live but -Force was given - continuing.' }

# -- 2) current instance (informational) ------------------------------------
function Get-ManagerState([int]$port) {
  try { return Invoke-RestMethod ("http://127.0.0.1:$port/api/state") -TimeoutSec 6 -ErrorAction Stop } catch { return $null }
}

$state = Get-ManagerState $ManagerPort
if ($null -eq $state) {
  Say ''
  Say "[ERROR] DSH manager not reachable on port $ManagerPort - is DSH-X running?"
  exit 4
}
$before = ''
if ($state.running -and $state.running.url) { $before = [string]$state.running.url }
Say ("manager state : " + $(if ($state.running) { 'running' } else { 'stopped' }) + "  " + $before)

if (-not $Restart) {
  Say ''
  Say '[OK] restart would be allowed (no -Restart given, nothing changed).'
  exit 0
}

# -- 3) restart and wait for the new URL -----------------------------------
Say ''
Say '[6/6] restarting the DSH web child via the manager (the page will move to a new port)...'
$posted = $false
foreach ($uri in @("http://127.0.0.1:$ManagerPort/api/restart", 'http://127.0.0.1:3780/api/restart')) {
  try {
    $r = Invoke-WebRequest $uri -Method POST -TimeoutSec 25 -UseBasicParsing -ErrorAction Stop
    Say ("      accepted: $uri (HTTP " + $r.StatusCode + ')')
    $posted = $true
    break
  } catch {
    Say ("      [warn] $uri failed: " + $_.Exception.Message)
  }
}
if (-not $posted) { Say '[ERROR] could not reach any restart endpoint.'; exit 4 }

$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 1200
  $s2 = Get-ManagerState $ManagerPort
  if ($s2 -and $s2.running -and $s2.running.url -and ([string]$s2.running.url -ne $before)) {
    Say ("      back up: " + $s2.running.url)
    Say '      open the new URL (the old tab cannot reconnect - new port + new token).'
    exit 0
  }
}
Say "[ERROR] no new URL after $ReadyTimeoutSec s - check the manager window / manager.log."
exit 5
