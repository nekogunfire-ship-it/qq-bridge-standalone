@echo off
REM ============================================================================
REM  QQ Bridge - standalone uninstaller
REM
REM  Usage: double-click this file (or run from a console).
REM
REM  Flow:
REM    1. re-launch itself elevated if not already admin (one UAC prompt)
REM    2. ask what to do with user data (keep / archive / delete)
REM    3. print the full plan and ask for typed confirmation
REM    4. run tools\uninstall-core.mjs --execute
REM
REM  Everything destructive lives in the Node core (tools\uninstall-core.mjs),
REM  so this .bat stays a thin, auditable wrapper. See that file for the plan.
REM
REM  NOTE: after uninstall, node_modules is gone, so this .bat can no longer run.
REM        That is intentional - use git to restore if needed.
REM
REM  This file MUST stay pure ASCII: cmd.exe decodes .bat with the system ANSI
REM  code page (cp936 here) and would eat characters after a non-ASCII byte.
REM ============================================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo ============================================================
echo   QQ Bridge - uninstaller
echo ============================================================
echo   Folder: %ROOT%
echo.

REM --------------------------------------------------------------------------
REM 1. Elevate if needed
REM --------------------------------------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights ^(UAC prompt^)...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo FAILED to elevate. Please right-click this file and choose
    echo "Run as administrator", then try again.
    echo.
    pause
    exit /b 1
  )
  exit /b 0
)
echo [ok] Running as administrator.
echo.

REM --------------------------------------------------------------------------
REM 2. Locate node
REM --------------------------------------------------------------------------
set "NODE_EXE=D:\DSH\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
  echo FAILED: node.exe not found. Install Node.js or make it available in PATH.
  echo Tried: %NODE_EXE%
  pause
  exit /b 1
)
echo [ok] node: %NODE_EXE%
echo.

REM --------------------------------------------------------------------------
REM 3. Decide about user data
REM    Optional first argument pre-selects the mode so the desktop app can ask
REM    once in a GUI dialog instead of double-asking here:
REM      uninstall.bat keep     -> keep data
REM      uninstall.bat archive  -> archive then delete
REM      uninstall.bat purge    -> delete permanently
REM --------------------------------------------------------------------------
set "PRESET=%~1"
if /i "%PRESET%"=="keep" goto :data_decided
if /i "%PRESET%"=="archive" goto :data_decided
if /i "%PRESET%"=="purge" goto :data_decided

echo ------------------------------------------------------------
echo   What should happen to your data?
echo ------------------------------------------------------------
echo   This covers state\ (chat history, slang library, stickers,
echo   session bindings) and config.json (your QQ number, tokens).
echo.
echo     [1] KEEP it          - reinstall later and continue (default)
echo     [2] ARCHIVE then del - move a copy into archive\ first
echo     [3] DELETE it        - permanently, cannot be undone
echo.
set "DATA_CHOICE="
set /p "DATA_CHOICE=Choose 1/2/3 [1]: "
if not defined DATA_CHOICE set "DATA_CHOICE=1"
set "PRESET="
if "%DATA_CHOICE%"=="1" set "PRESET=keep"
if "%DATA_CHOICE%"=="2" set "PRESET=archive"
if "%DATA_CHOICE%"=="3" set "PRESET=purge"
if not defined PRESET set "PRESET=keep"
echo.

:data_decided
set "DATA_FLAG=--keep-data"
set "DATA_CHOICE=1"
if /i "%PRESET%"=="archive" (
  set "DATA_FLAG=--archive-data"
  set "DATA_CHOICE=2"
)
if /i "%PRESET%"=="purge" (
  set "DATA_FLAG=--purge-data"
  set "DATA_CHOICE=3"
)
echo [ok] data mode: %PRESET%
echo.

REM --------------------------------------------------------------------------
REM 4. Show the plan and ask for typed confirmation
REM --------------------------------------------------------------------------
echo ------------------------------------------------------------
echo   Planned actions (nothing has been changed yet)
echo ------------------------------------------------------------
"%NODE_EXE%" "tools\uninstall-core.mjs" %DATA_FLAG%
echo.
echo   NOTE: source code and the .git folder are KEPT by default,
echo   so the 400 MB of dependencies can be reinstalled later.
echo.

if "%DATA_CHOICE%"=="3" (
  echo ############################################################
  echo #  WARNING: option 3 permanently deletes chat history,
  echo #  the slang library and your tokens. This cannot be undone.
  echo ############################################################
  echo.
)

set "CONFIRM="
set /p "CONFIRM=Type UNINSTALL to proceed, or press Enter to abort: "
if /i not "%CONFIRM%"=="UNINSTALL" (
  echo.
  echo Aborted. Nothing was changed.
  echo.
  pause
  exit /b 0
)

REM --------------------------------------------------------------------------
REM 5. Execute
REM --------------------------------------------------------------------------
echo.
echo ------------------------------------------------------------
echo   Uninstalling...
echo ------------------------------------------------------------
"%NODE_EXE%" "tools\uninstall-core.mjs" %DATA_FLAG% --execute --elevated-ok
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   Uninstall finished.
  echo.
  echo   Not touched ^(remove them yourself if you want^):
  echo     - SnowLuma      C:\SnowLuma
  echo     - ComfyUI       E:\comfyui
  echo     - DSH           D:\DSH
  echo.
  echo   To also remove the source code, run:
  echo     node tools\uninstall-core.mjs --purge-data --remove-source --execute
) else (
  echo   Uninstall finished with problems ^(exit %RC%^).
  echo   Scroll up for details.
)
echo ============================================================
echo.
pause
endlocal
