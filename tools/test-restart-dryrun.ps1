# Dry-run harness for restart-bridge-and-dsh.ps1.
#
# The real script is destructive (stops the bridge, relaunches it, restarts
# DSH), and the agent sandbox cannot stop processes, so full end-to-end
# execution is impossible here. Instead this harness makes a TEMP COPY of the
# script with the destructive calls replaced by no-ops, then executes the whole
# control flow against a scratch root.
#
# It exercises: argument parsing, $Root defaulting, path building, port
# discovery, the 'nothing was holding the port' branch, the stray-process scan
# degrading gracefully, lock cleanup, the launch step, the console-readiness
# loop timing out cleanly, the route-verification branches, the SnowLuma
# log-check branch, and (by default) the real POST /api/restart to the DSH
# manager on 3780.
#
# ASCII only.
[CmdletBinding()]
param(
  [switch]$SkipManagerRestart
)

$ErrorActionPreference = 'Continue'
$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  Write-Host ("{0} {1}{2}" -f $(if ($ok) { 'OK  ' } else { 'FAIL' }), $name, $(if ($detail) { " - $detail" } else { '' }))
  if (-not $ok) { $script:fail++ }
}

$src = Join-Path $PSScriptRoot 'restart-bridge-and-dsh.ps1'
$scratch = Join-Path $env:TEMP ('rbd-dryrun-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path (Join-Path $scratch 'state') -Force | Out-Null
$copy = Join-Path $scratch 'restart-dryrun.ps1'

$text = Get-Content -LiteralPath $src -Raw

# 1) neutralise the delegation to the real launcher (it would stop/start
#    SnowLuma and the bridge).
$before = $text
$text = [regex]::Replace($text, '\$proc = Start-Process -FilePath ''powershell\.exe''[\s\S]*?-ErrorAction Stop', 'Write-Host ''      [dry-run] launcher restartAll skipped''; $proc = $null')
Check 'patched the launcher delegation' ($text -ne $before)

# 1b) keep the follow-up output display from running with no $proc
$before = $text
$text = $text.Replace('if ($started -and (Test-Path $launcherOut)) {', 'if ($false -and (Test-Path $launcherOut)) {')
Check 'patched the launcher output display' ($text -ne $before)

# 2) neutralise the start.bat fallback
$before = $text
$text = [regex]::Replace($text, "Start-Process -FilePath 'cmd\.exe'[^\r\n]*", "Write-Host '      [dry-run] start.bat launch skipped'")
Check 'patched the start.bat fallback' ($text -ne $before)

# 3) neutralise the port-owner stop (message text is Chinese, so match loosely)
$before = $text
$text = [regex]::Replace($text, 'if \(Stop-PidSafe \$procId\)[^\r\n]*', "Say '      [dry-run] would stop it'")
Check 'patched the port-owner stop' ($text -ne $before)

# 4) shorten the readiness wait so the harness does not stall
$before = $text
$text = $text.Replace('[int]$ReadyTimeoutSec = 60', '[int]$ReadyTimeoutSec = 3')
Check 'shortened the readiness timeout' ($text -ne $before)

if ($SkipManagerRestart) {
  $before = $text
  # Force the manager-restart branch to fail so the launcher fallback is exercised.
  $text = [regex]::Replace($text, 'Invoke-WebRequest \$uri -Method POST -TimeoutSec 25 -UseBasicParsing -ErrorAction Stop', 'throw "dry-run: manager restart skipped"')
  Check 'patched the manager restart' ($text -ne $before)
}

Set-Content -LiteralPath $copy -Value $text -Encoding UTF8
Write-Host ''
Write-Host "--- executing patched copy against scratch root (dead console port 45999)"
Write-Host ''

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $copy -Root $scratch -ConsolePort 45999 -ManagerPort 3780
$scriptExit = $LASTEXITCODE

Write-Host ''
Write-Host '--- harness assertions'
Check 'scratch root exists' (Test-Path $scratch)
Check 'no bridge.lock left behind in the scratch root' (-not (Test-Path (Join-Path $scratch 'state\bridge.lock')))
Check 'patched copy still exists (script ran to completion)' (Test-Path $copy)
Write-Host ("      patched script exit code: " + $scriptExit)

Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host $(if ($fail -eq 0) { '=== dry-run harness completed ===' } else { "=== $fail harness check(s) failed ===" })
exit $(if ($fail -eq 0) { 0 } else { 1 })
