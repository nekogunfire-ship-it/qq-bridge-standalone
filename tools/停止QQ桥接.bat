@echo off
rem  PURE ASCII ONLY -- see the note in the start script. cmd.exe mis-decodes
rem  UTF-8 Chinese in BOM-less .bat files and breaks the command lines.
chcp 65001 >nul
title QQ Bridge - Stop
cd /d "%~dp0.."
echo.
echo   Stopping QQ Bridge and SnowLuma (DSH is left running) ...
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0qq-bridge-launcher.ps1" -Action stopAll
echo.
pause
