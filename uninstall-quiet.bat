@echo off
REM ============================================================================
REM  QQ Bridge - QUIET uninstaller
REM
REM  Non-interactive variant for the registry "QuietUninstallString".
REM  Policy: KEEP user data (state\ + config.json) and KEEP source code, so the
REM  software can be reinstalled later and continue where it left off.
REM  Use uninstall.bat instead if you want to be asked about data.
REM
REM  Pure ASCII on purpose: cmd.exe decodes .bat with the system ANSI code page.
REM ============================================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM Elevate (one UAC prompt); the elevated copy runs the real work below.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
  exit /b 0
)

set "NODE_EXE=D:\DSH\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
  echo FAILED: node.exe not found. Tried: %NODE_EXE%
  echo Install Node.js or run uninstall.bat manually.
  pause
  exit /b 1
)

echo Uninstalling QQ Bridge (keeping user data and source code)...
echo.
"%NODE_EXE%" "tools\uninstall-core.mjs" --keep-data --execute --elevated-ok
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Done. User data ^(state\ and config.json^) and source code were KEPT.
  echo To remove them too, run uninstall.bat and pick option 3.
) else (
  echo Finished with problems ^(exit %RC%^). Run uninstall.bat for details.
)
echo.
pause
endlocal
