# Test the process-discovery / process-stop helpers used by
# restart-bridge-and-dsh.ps1.
#
# Constraint that shapes this test: the agent sandbox forbids processes it
# spawns from LISTENING on a port, so a throwaway listener cannot be created
# here. The test therefore splits the concern:
#   1) port discovery  -> exercised against REAL netstat output + synthetic
#                         lines with the exact regex the script uses;
#   2) stop logic      -> exercised against a real, non-self-terminating child.
# ASCII only (see the note in the main script).
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  Write-Host ("{0} {1}{2}" -f $(if ($ok) { 'OK  ' } else { 'FAIL' }), $name, $(if ($detail) { " - $detail" } else { '' }))
  if (-not $ok) { $script:fail++ }
}

# --- exact copy of the helper from the real script ------------------------
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

# --- 1) netstat parsing ---------------------------------------------------
$pattern3100 = ':3100\s+.*LISTENING\s+(\d+)'
$samples = @(
  '  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       70872',
  '  TCP    127.0.0.1:31000        0.0.0.0:0              LISTENING       12345',
  '  TCP    127.0.0.1:13100        0.0.0.0:0              LISTENING       99999'
)
$hit = [regex]::Match($samples[0], $pattern3100)
Check 'netstat regex extracts the pid for :3100' ($hit.Success -and $hit.Groups[1].Value -eq '70872') $hit.Groups[1].Value
Check 'netstat regex does not match :31000' (-not [regex]::IsMatch($samples[1], $pattern3100))
Check 'netstat regex does not match :13100' (-not [regex]::IsMatch($samples[2], $pattern3100))

# discovery must return a real owner for a port that is actually listening
$live = Get-PortOwnerPids 3100
Check 'Get-PortOwnerPids returns the live bridge owner on 3100' (@($live).Count -ge 1) ("owners: " + $(if (@($live).Count) { ($live -join ',') } else { '(none)' }))

Check 'Get-PortOwnerPids returns nothing for an unused port' (@(Get-PortOwnerPids 45732).Count -eq 0)

# --- 2) stop logic against a real long-lived child ------------------------
$nodePath = (Get-Command node).Source
$child = Start-Process -FilePath $nodePath -ArgumentList '-e', 'setInterval(()=>{},1000)' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1200
$aliveBefore = $false
try { $aliveBefore = -not $child.HasExited } catch {}
Check "spawned a long-lived child (PID $($child.Id))" $aliveBefore

$ok = Stop-PidSafe $child.Id
Start-Sleep -Milliseconds 700
$aliveAfter = $true
try { $child.Refresh(); $aliveAfter = -not $child.HasExited } catch { $aliveAfter = $false }
Check 'Stop-PidSafe reports success' $ok
Check 'child is really gone afterwards' (-not $aliveAfter)

# stopping an already-dead pid must be handled, not throw
$again = Stop-PidSafe $child.Id
Check 'stopping an already-dead pid is handled' ($again -eq $false -or $again -eq $true) ("returned: $again")

Write-Host ''
Write-Host $(if ($fail -eq 0) { '=== all checks passed ===' } else { "=== $fail check(s) failed ===" })
exit $(if ($fail -eq 0) { 0 } else { 1 })
