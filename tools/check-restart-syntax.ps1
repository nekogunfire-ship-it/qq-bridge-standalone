# Syntax-check the restart tooling with the Windows PowerShell 5.1 parser
# (the dialect the .bat wrapper actually invokes). ASCII only.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$targets = @(
  'tools\restart-bridge-and-dsh.ps1',
  'tools\test-restart-helpers.ps1',
  'tools\test-restart-dryrun.ps1'
)
$fail = 0
Write-Host ("parser: PowerShell " + $PSVersionTable.PSVersion.ToString())
foreach ($rel in $targets) {
  $path = Join-Path $root $rel
  if (-not (Test-Path $path)) { Write-Host ("MISS " + $rel); $script:fail++; continue }
  $err = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$err)
  if ($err -and $err.Count) {
    Write-Host ("FAIL " + $rel)
    foreach ($e in $err) { Write-Host ("     line " + $e.Extent.StartLineNumber + ": " + $e.Message) }
    $script:fail++
  } else {
    Write-Host ("OK   " + $rel)
  }
}
Write-Host ''
Write-Host $(if ($fail -eq 0) { '=== all scripts parse under 5.1 ===' } else { "=== $fail script(s) failed to parse ===" })
exit $(if ($fail -eq 0) { 0 } else { 1 })
