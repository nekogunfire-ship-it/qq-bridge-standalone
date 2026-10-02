@echo off
REM ============================================================================
REM  QQ bridge desktop launcher - keeps GPU enabled (diagnostic / normal mode)
REM
REM  Why this exists:
REM    The desktop app applies a group of GPU switches at startup
REM    (disableHardwareAcceleration + disable-gpu + disable-gpu-compositing +
REM     disable-gpu-sandbox + disable-software-rasterizer) as a second line of
REM    defense against the old "window flashes and disappears" problem.
REM    But the console window then failed with
REM      "renderer-process-gone reason=launch-failed exitCode=18"
REM    (Chromium could not start a renderer/GPU subprocess).
REM
REM    main.mjs already honours QQ_BRIDGE_GPU=1 to skip that whole group,
REM    so this wrapper just sets it and hands over to start.mjs.
REM
REM  Usage: double-click the desktop shortcut (it points here).
REM         To go back to software rendering, point the shortcut back to
REM         node.exe with start.mjs as the argument.
REM
REM  Pure ASCII on purpose: a cp936 console mangles non-ASCII output.
REM ============================================================================
setlocal
cd /d "%~dp0"

set "QQ_BRIDGE_GPU=1"
echo [launcher] QQ_BRIDGE_GPU=%QQ_BRIDGE_GPU%  (GPU switches skipped)

set "NODE_EXE=D:\DSH\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"

"%NODE_EXE%" "%~dp0start.mjs"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [launcher] start.mjs exited with code %RC%
  pause
)
endlocal
