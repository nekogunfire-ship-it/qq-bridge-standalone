@echo off
rem ---------------------------------------------------------------------------
rem  ONE-CLICK ENTRY: start the whole QQ-bridge stack, sync the DSH endpoint,
rem  open DSH + the bridge console in the browser, then print a self-check.
rem
rem  IMPORTANT -- THIS FILE MUST STAY PURE ASCII.
rem  cmd.exe reads BOM-less .bat files using the system ANSI code page (cp936
rem  here), so UTF-8 Chinese text gets mis-decoded and eats the next character.
rem  All Chinese output comes from qq-oneclick-start.ps1 (UTF-8 with BOM).
rem
rem  Optional switches (edit the powershell line below):
rem    -CheckOnly   self-check only, change nothing
rem    -NoOpen      start + self-check, do not open the browser
rem    -Restart     stop bridge/SnowLuma first, then start them again
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title QQ Bridge - One-click Start + Self-check
cd /d "%~dp0.."

rem  Self-heal: qq-oneclick-start.ps1 carries Chinese literals, so it MUST be
rem  UTF-8 with BOM (PowerShell 5.1 reads BOM-less .ps1 as ANSI/cp936 and the
rem  Chinese turns into mojibake that breaks parsing). Some editors strip the
rem  BOM on save -- re-add it here instead of failing with a cryptic error.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$f='%~dp0qq-oneclick-start.ps1'; $b=[IO.File]::ReadAllBytes($f); if (-not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) { $t=[IO.File]::ReadAllText($f,[Text.Encoding]::UTF8); [IO.File]::WriteAllText($f,$t,(New-Object Text.UTF8Encoding($true))); Write-Host '  [fixed] re-added UTF-8 BOM to qq-oneclick-start.ps1' }"

rem  Switches can be passed through on the command line, e.g.
rem    "oneclick...bat" -NoOpen      start + self-check without opening a browser
rem  Double-clicking passes none, which means: start everything, open both pages.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0qq-oneclick-start.ps1" %*
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" echo   [FAILED] one or more checks did not pass. See the [FAIL] lines above.
echo   Report : %~dp0runtime\oneclick-last-run.log
echo   History: %~dp0runtime\oneclick-history.log
echo.
pause
