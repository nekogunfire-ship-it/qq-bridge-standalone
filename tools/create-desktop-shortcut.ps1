# create-desktop-shortcut.ps1
# ---------------------------------------------------------------------------
# Put a desktop shortcut to the "restart bridge and make the drawing tool take
# effect" entry point, so it is one double-click.
#
# The shortcut is created with the SAME window style the bridge tooling already
# uses for its other shortcuts: WindowStyle 1 (normal) plus -WindowStyle
# Minimized on the powershell call, so the restart runs without stealing focus
# and the batch's final `pause` still shows the result when opened again.
#
# ASCII ONLY (Windows PowerShell 5.1 decodes BOM-less .ps1 with the ANSI code
# page, which would corrupt non-ASCII literals). The Chinese display name and
# the Chinese .bat file name are built from code points for that reason.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Icon = 'D:\DSH\assets\dsh-0.1.13.ico',
  [string]$ShortcutName = '',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

# "重启桥接并让画图工具生效" built from code points, to keep this file ASCII.
$cn = -join ([char]0x91CD, [char]0x542F, [char]0x6865, [char]0x63A5, [char]0x5E76,
             [char]0x8BA9, [char]0x753B, [char]0x56FE, [char]0x5DE5, [char]0x5177,
             [char]0x751F, [char]0x6548)
if (-not $ShortcutName) { $ShortcutName = $cn + '.lnk' }

$Desktop = [Environment]::GetFolderPath('Desktop')
if (-not $Desktop) { $Desktop = Join-Path $env:USERPROFILE 'Desktop' }
$LinkPath = Join-Path $Desktop $ShortcutName
$Target = Join-Path $Root ('tools\' + $cn + '.bat')

if ($Remove) {
  if (Test-Path $LinkPath) { Remove-Item -LiteralPath $LinkPath -Force; Write-Host ("removed: " + $LinkPath) }
  else { Write-Host ("nothing to remove: " + $LinkPath) }
  exit 0
}

if (-not (Test-Path $Target)) { throw ("target not found: " + $Target) }

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($LinkPath)
$link.TargetPath = $Target
# WorkingDirectory matches the sibling shortcuts: the folder that contains the
# tooling, while the .bat itself cds to the repo root.
$link.WorkingDirectory = Join-Path $Root 'tools'
$link.Description = $cn
# Keep the console out of the way; the batch still pauses for reading results.
$link.WindowStyle = 7
if ($Icon -and (Test-Path ($Icon -split ',')[0])) {
  $link.IconLocation = $Icon
  Write-Host ("icon   : " + $Icon)
} else {
  Write-Host ("icon   : (default; not found: " + $Icon + ")")
}
$link.Save()

# Read it back so the report reflects what is actually on disk.
$check = $shell.CreateShortcut($LinkPath)
Write-Host ''
Write-Host '=== desktop shortcut created ==='
Write-Host ("path      : " + $LinkPath)
Write-Host ("exists    : " + (Test-Path $LinkPath))
Write-Host ("target    : " + $check.TargetPath)
Write-Host ("workdir   : " + $check.WorkingDirectory)
Write-Host ("icon      : " + $check.IconLocation)
Write-Host ("windowstyle: " + $check.WindowStyle)
Write-Host ("target exists: " + (Test-Path $check.TargetPath))
