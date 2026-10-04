param(
  [ValidateSet('keep', 'archive', 'purge')]
  [string]$Mode = 'keep'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $env:TEMP 'qq-bridge-uninstall.log'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  try {
    $arguments = @(
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', ('"{0}"' -f $PSCommandPath), '-Mode', $Mode
    )
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments `
      -Verb RunAs -WindowStyle Hidden | Out-Null
    exit 0
  } catch {
    Set-Content -LiteralPath $LogFile -Encoding UTF8 -Value (
      'QQ Bridge silent uninstall elevation failed: ' + $_.Exception.Message
    )
    exit 1
  }
}

$node = 'D:\DSH\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { $node = $command.Source }
}

if (-not (Test-Path -LiteralPath $node)) {
  Set-Content -LiteralPath $LogFile -Encoding UTF8 -Value 'QQ Bridge silent uninstall failed: node.exe not found.'
  exit 1
}

$flag = switch ($Mode) {
  'archive' { '--archive-data' }
  'purge'   { '--purge-data' }
  default   { '--keep-data' }
}

Set-Content -LiteralPath $LogFile -Encoding UTF8 -Value (
  "QQ Bridge silent uninstall started. mode=$Mode root=$Root"
)

Push-Location $Root
try {
  & $node (Join-Path $Root 'tools\uninstall-core.mjs') $flag '--execute' '--elevated-ok' *>> $LogFile
  $exitCode = $LASTEXITCODE
} catch {
  Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $_.Exception.ToString()
  $exitCode = 1
} finally {
  Pop-Location
}

Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value (
  "QQ Bridge silent uninstall finished. exit=$exitCode"
)
exit $exitCode
