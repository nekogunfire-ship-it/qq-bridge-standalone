# probe.ps1 -- isolate why Get-ServiceProcess returns nothing inside the launcher
$ErrorActionPreference = 'Continue'

function Get-ServiceProcess([string]$pattern, [string[]]$excludePattern = @()) {
  $found = @()
  foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if (-not $p.CommandLine) { continue }
    if ($p.CommandLine -notlike $pattern) { continue }
    $skip = $false
    foreach ($ex in $excludePattern) { if ($p.CommandLine -like $ex) { $skip = $true; break } }
    if ($skip) { continue }
    $found += $p
  }
  return $found
}

$BridgeExclude = @('*mcp-*', '*subprocess-local*', '*launcher.ps1*', '*-Command*')
Write-Output "--- bridge ---"
$bp = @(Get-ServiceProcess -pattern '*src\bridge.js*' -excludePattern $BridgeExclude)
Write-Output ("count=" + $bp.Count)
foreach ($p in $bp) { Write-Output ("  pid=" + $p.ProcessId) }

Write-Output "--- snow (no exclude) ---"
$sp0 = @(Get-ServiceProcess -pattern '*index.mjs*')
Write-Output ("count=" + $sp0.Count)

Write-Output "--- snow (with exclude) ---"
$sp = @(Get-ServiceProcess -pattern '*index.mjs*' -excludePattern @('*subprocess-local*', '*launcher.ps1*', '*-Command*', '*dsh*lib\bin.js*'))
Write-Output ("count=" + $sp.Count)
foreach ($p in $sp) { Write-Output ("  pid=" + $p.ProcessId) }

Write-Output "--- dsh ---"
$dp = @(Get-ServiceProcess -pattern '*dsh*lib\bin.js*web*' -excludePattern @('*subprocess-local*', '*launcher.ps1*'))
Write-Output ("count=" + $dp.Count)
foreach ($p in $dp) { Write-Output ("  pid=" + $p.ProcessId) }

Write-Output "--- total cim ---"
Write-Output ("all=" + @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue).Count)
