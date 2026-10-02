@echo off
rem  PURE ASCII ONLY -- see the note in the start script. cmd.exe mis-decodes
rem  UTF-8 Chinese in BOM-less .bat files and breaks the command lines.
chcp 65001 >nul
title QQ Bridge - Restart All
cd /d "%~dp0.."
echo.
echo   Restarting all: bridge - SnowLuma - sync endpoint - start
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0qq-bridge-launcher.ps1" -Action restartAll
echo.
pause
