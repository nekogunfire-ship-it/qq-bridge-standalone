@echo off
REM ============================================================================
REM  QQ Bridge - installer
REM
REM  Usage: double-click this file (run it from the folder you extracted the
REM  package into). It copies the program to an install folder, installs
REM  dependencies, and can optionally create shortcuts and register the
REM  Windows uninstall entry.
REM
REM  The real logic lives in tools\install-core.mjs - this .bat is only a thin
REM  wrapper that elevates, asks a few questions, and passes flags through.
REM  Run `node tools\install-core.mjs --plan` to see the plan without this wrapper.
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
echo   QQ Bridge - installer
echo ============================================================
echo   Package folder: %ROOT%
echo.

REM --------------------------------------------------------------------------
REM Locate node
REM --------------------------------------------------------------------------
set "NODE_EXE=D:\DSH\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
  echo FAILED: node.exe not found.
  echo Install Node.js ^(22 or newer recommended^) first:
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)
echo [ok] node: %NODE_EXE%
echo.

REM --------------------------------------------------------------------------
REM Ask for the install folder
REM --------------------------------------------------------------------------
set "DEFAULT_TARGET=%LOCALAPPDATA%\QQBridge"
echo ------------------------------------------------------------
echo   Where should it be installed?
echo ------------------------------------------------------------
echo   Press Enter to accept the default:
echo     %DEFAULT_TARGET%
echo.
set "TARGET="
set /p "TARGET=Install folder: "
if not defined TARGET set "TARGET=%DEFAULT_TARGET%"
echo.

REM --------------------------------------------------------------------------
REM Ask which extras to set up
REM --------------------------------------------------------------------------
echo ------------------------------------------------------------
echo   Optional extras
echo ------------------------------------------------------------
echo.
set "ANS="
set /p "ANS=Install the DSH environment too? (no = use a standard AI API instead) [Y/n]: "
if /i "%ANS%"=="n" set "EXTRA_NODSH=--no-dsh"
if /i "%ANS%"=="n" echo    -^> will skip DSH's optional dependency; the setup wizard will then use the "direct" runtime.
echo.

set "EXTRA_COMFY="
set "EXTRA_MODEL="
set "EXTRA_COMFY_VARIANT="
set "ANS="
set /p "ANS=Install the official ComfyUI Portable environment? (large download) [y/N]: "
if /i "%ANS%"=="y" (
  set "EXTRA_COMFY=--with-comfy"
  echo.
  echo   GPU package:
  echo     1. NVIDIA 20 series or newer ^(recommended^)
  echo     2. NVIDIA 10 series or older ^(CUDA 12.6^)
  echo     3. AMD ROCm
  echo     4. Intel XPU
  set "GPU_CHOICE="
  set /p "GPU_CHOICE=Choose 1-4 [1]: "
  if "%GPU_CHOICE%"=="2" set "EXTRA_COMFY_VARIANT=--comfy-variant nvidiaLegacy"
  if "%GPU_CHOICE%"=="3" set "EXTRA_COMFY_VARIANT=--comfy-variant amd"
  if "%GPU_CHOICE%"=="4" set "EXTRA_COMFY_VARIANT=--comfy-variant intel"
  if not defined EXTRA_COMFY_VARIANT set "EXTRA_COMFY_VARIANT=--comfy-variant nvidia"
  echo.
  echo   Optional image model: Stable Diffusion XL Base 1.0
  echo   Download size: about 6.9 GB
  echo   License: CreativeML Open RAIL++-M
  echo   https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md
  set "MODEL_ANS="
  set /p "MODEL_ANS=Download this model and accept its license? [y/N]: "
  if /i "%MODEL_ANS%"=="y" set "EXTRA_MODEL=--with-image-model"
)
echo.

set "EXTRA_SHORTCUTS="
set /p "ANS=Create desktop + Start Menu shortcuts? [Y/n]: "
if /i not "%ANS%"=="n" set "EXTRA_SHORTCUTS=--with-shortcuts"

set "ANS="
set /p "ANS=Register it in the Windows apps list (so it can be uninstalled there)? [Y/n]: "
if /i not "%ANS%"=="n" set "EXTRA_REG=--with-uninstall-entry"

set "ANS="
set /p "ANS=Start the watchdogs automatically at logon? (needs admin) [y/N]: "
if /i "%ANS%"=="y" set "EXTRA_TASKS=--with-watchdogs"
echo.

REM --------------------------------------------------------------------------
REM Watchdog tasks need admin (creating scheduled tasks requires elevation).
REM Rather than re-running this whole wizard elevated (which would ask every
REM question twice), we just drop that one flag and tell the user how to do it
REM afterwards.
REM --------------------------------------------------------------------------
if defined EXTRA_TASKS (
  net session >nul 2>&1
  if errorlevel 1 (
    echo NOTE: this window is not elevated, so the watchdog tasks will be skipped.
    echo       To register them later, run this in an ADMIN prompt:
    echo         node tools\register-watchdog-tasks.mjs
    echo.
    set "EXTRA_TASKS="
  )
)

echo ------------------------------------------------------------
echo   Planned actions (nothing has been changed yet)
echo ------------------------------------------------------------
"%NODE_EXE%" "tools\install-core.mjs" --target "%TARGET%" %EXTRA_NODSH% %EXTRA_COMFY% %EXTRA_MODEL% %EXTRA_COMFY_VARIANT% %EXTRA_SHORTCUTS% %EXTRA_REG% %EXTRA_TASKS%
echo.

set "CONFIRM="
set /p "CONFIRM=Type INSTALL to proceed, or press Enter to abort: "
if /i not "%CONFIRM%"=="INSTALL" (
  echo.
  echo Aborted. Nothing was changed.
  echo.
  pause
  exit /b 0
)

echo.
echo ------------------------------------------------------------
echo   Installing...
echo ------------------------------------------------------------
"%NODE_EXE%" "tools\install-core.mjs" --target "%TARGET%" --apply %EXTRA_NODSH% %EXTRA_COMFY% %EXTRA_MODEL% %EXTRA_COMFY_VARIANT% %EXTRA_SHORTCUTS% %EXTRA_REG% %EXTRA_TASKS%
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   Install finished.
  echo.
  echo   Initial configuration was completed automatically.
  echo   Any missing account/API item will be shown in the app overview.
  echo     Start it:         run "tools\qq-bridge-launcher.ps1 -Action startAll"
  echo                        from the install folder, or use the shortcut
  echo.
  echo   Other external component ^(bring your own^):
  echo     - SnowLuma  QQ gateway
  echo   DSH / ComfyUI / SDXL were handled according to your choices above.
) else (
  echo   Install finished with problems ^(exit %RC%^).
  echo   Scroll up for details. Nothing outside the target folder was removed.
)
echo ============================================================
echo.
pause
endlocal
