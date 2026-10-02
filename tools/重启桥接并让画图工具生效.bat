@echo off
rem ---------------------------------------------------------------------------
rem  IMPORTANT -- THIS FILE MUST STAY PURE ASCII.
rem  cmd.exe reads BOM-less .bat files using the system ANSI code page (cp936
rem  here). UTF-8 Chinese text therefore gets mis-decoded and eats the next
rem  character, so lines break apart and cmd reports
rem  "'xxx' is not recognized as an internal or external command".
rem  All human-facing Chinese lives in the .ps1 this wrapper calls (PowerShell
rem  reads UTF-8 with a BOM correctly) and in tools\messages.json.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title QQ Bridge - Restart (activate drawing tools)
setlocal
cd /d "%~dp0"

rem  Pass --dry-run through to check the chain without changing anything.
set "DRY="
if /i "%~1"=="--dry-run" set "DRY=-DryRun"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-bridge-and-dsh.ps1" -Root "%~dp0.." %DRY%
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" echo   [WARN] restart script exit code %RC%
echo   Press any key to close.
pause >nul
endlocal
