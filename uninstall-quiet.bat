@echo off
REM ============================================================================
REM  QQ Bridge - QUIET uninstaller
REM
REM  Non-interactive variant for the registry "QuietUninstallString".
REM  Optional first argument: keep (default), archive, or purge.
REM  No console prompts or pauses. A diagnostic log is written to TEMP.
REM
REM  Pure ASCII on purpose: cmd.exe decodes .bat with the system ANSI code page.
REM ============================================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "MODE=%~1"
if not defined MODE set "MODE=keep"
if /i not "%MODE%"=="keep" if /i not "%MODE%"=="archive" if /i not "%MODE%"=="purge" exit /b 64
set "DATA_FLAG=--keep-data"
if /i "%MODE%"=="archive" set "DATA_FLAG=--archive-data"
if /i "%MODE%"=="purge" set "DATA_FLAG=--purge-data"
set "LOG_FILE=%TEMP%\qq-bridge-uninstall.log"

REM Elevate (one UAC prompt); the elevated copy runs the real work below.
net session >nul 2>&1
if errorlevel 1 (
  set "QB_UNINSTALL_SELF=%~f0"
  set "QB_UNINSTALL_MODE=%MODE%"
  powershell -NoProfile -WindowStyle Hidden -Command "$a=@($env:QB_UNINSTALL_MODE); Start-Process -FilePath $env:QB_UNINSTALL_SELF -ArgumentList $a -Verb RunAs -WindowStyle Hidden" >nul 2>&1
  if errorlevel 1 exit /b 1
  exit /b 0
)

set "NODE_EXE=D:\DSH\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
  >"%LOG_FILE%" echo FAILED: node.exe not found. Tried: %NODE_EXE%
  exit /b 1
)

>"%LOG_FILE%" echo QQ Bridge quiet uninstall started. mode=%MODE%
"%NODE_EXE%" "tools\uninstall-core.mjs" %DATA_FLAG% --execute --elevated-ok >>"%LOG_FILE%" 2>&1
set "RC=%ERRORLEVEL%"
>>"%LOG_FILE%" echo QQ Bridge quiet uninstall finished. exit=%RC%
endlocal & exit /b %RC%
