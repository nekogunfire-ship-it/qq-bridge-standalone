@echo off
rem ---------------------------------------------------------------------------
rem  IMPORTANT -- THIS FILE MUST STAY PURE ASCII.
rem  cmd.exe reads BOM-less .bat files using the system ANSI code page (cp936
rem  here). UTF-8 Chinese text therefore gets mis-decoded and eats the next
rem  character, so lines like "echo -- ok" break apart and cmd reports
rem  "'xxx' is not recognized as an internal or external command".
rem  Keep all human-facing Chinese in tools\messages.json instead.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title QQ Bridge - Start
cd /d "%~dp0.."
echo.
echo   ============================================
echo     QQ Bridge Launcher
echo     DSH - SnowLuma - QQ Bridge
echo   ============================================
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0qq-bridge-launcher.ps1" -Action startAll
echo.
echo   console: http://127.0.0.1:3100   (full GUI: tools\launcher.hta)
echo   logs   : %~dp0runtime\launcher.log
echo.
pause
