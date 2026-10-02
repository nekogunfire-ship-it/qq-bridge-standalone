@echo off
REM ============================================================================
REM  QQ bridge desktop - DIAGNOSTIC launcher
REM
REM  When the app exits immediately ("window flashes and disappears"), this keeps
REM  the console open and shows Electron's REAL error text plus a comparison of
REM  "normal" vs "elevated (admin)" launch, so we can tell whether the failure is
REM  permission related.
REM
REM  Output is also saved to ..\state\desktop-diag.log
REM  Pure ASCII on purpose: a cmd window in cp936 mangles non-ASCII output.
REM ============================================================================
setlocal
cd /d "%~dp0"

set "REPORT=%~dp0..\state\desktop-diag.log"
set "DESKLOG=%~dp0..\state\desktop.log"

echo ============================================================
echo   QQ bridge desktop - diagnostic launch
echo ============================================================
echo.
echo Working dir : %CD%
echo Report file : %REPORT%
echo.

echo === A. Environment (things that break Electron if inherited) ===
echo   NODE_OPTIONS=%NODE_OPTIONS%
echo   NODE_PATH=%NODE_PATH%
echo   ELECTRON_RUN_AS_NODE=%ELECTRON_RUN_AS_NODE%
echo.

echo === B. Am I elevated? ===
net session >nul 2>&1
if %ERRORLEVEL%==0 (echo   YES - running as administrator) else (echo   NO - running as a normal user)
echo.

echo === C. Electron binary works at all? (bypasses GUI init) ===
set "ELEC=%~dp0node_modules\electron\dist\electron.exe"
set ELECTRON_RUN_AS_NODE=1
"%ELEC%" -e "console.log('  NODE_MODE_OK electron=' + process.versions.electron)" 2>&1
set ELECTRON_RUN_AS_NODE=
echo.

echo === D. Normal launch via start.mjs (full output below) ===
echo.
node start.mjs > "%REPORT%" 2>&1
set "RC=%ERRORLEVEL%"
type "%REPORT%"
echo.
echo   Exit code: %RC%
echo     2147483651 (0x80000003) = Electron died BEFORE app code ran
echo     0                       = app ran and exited normally
echo.

echo === E. Last 6 lines of the app log ===
powershell -NoProfile -Command "if (Test-Path '%DESKLOG%') { Get-Content '%DESKLOG%' -Tail 6 } else { '  (no desktop.log)' }"
echo.
echo ============================================================
echo   Send the text above back to support.
echo   If launch works only with "Run as administrator",
echo   say so explicitly - that tells us it is a privilege issue.
echo ============================================================
echo.
pause
endlocal
