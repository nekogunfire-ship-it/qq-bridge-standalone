@echo off
rem  PURE ASCII ONLY: cmd.exe mis-decodes UTF-8 Chinese in BOM-less .bat files.
rem  Starts the QQ-bridge watchdog hidden; it auto-restarts the bridge if the
rem  process dies or its console stops answering.
chcp 65001 >nul
title QQ Bridge - Watchdog
cd /d "%~dp0.."
echo.
echo   Starting QQ bridge watchdog (hidden)...
echo   Log : state\slang-agent\bridge-watch.log
echo   PID : state\slang-agent\bridge-watch.pid
echo   Stop: wscript.exe "%~dp0..\state\slang-agent\stop-bridge-watchdog.vbs"
echo.
wscript.exe "%~dp0..\state\slang-agent\launch-bridge-watchdog.vbs"
echo   Watchdog launched.
timeout /t 3 >nul
