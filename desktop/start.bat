@echo off
rem QQ Bridge desktop console launcher. Pure ASCII on purpose: a .bat with
rem non-ASCII text gets decoded as cp936 by cmd and can swallow the next line.
rem All Chinese UI text lives in the Electron renderer, not here.
setlocal
cd /d "%~dp0"
node start.mjs %*
if errorlevel 1 (
  echo.
  echo [desktop] Startup failed. See the message above.
  pause
)
endlocal
