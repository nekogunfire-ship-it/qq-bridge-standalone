@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  重启 QQ 桥接（并重启 DSH web 进程）
rem
rem  历史：本脚本原先用 Get-CimInstance(WMI) 找并结束旧进程。WMI 在受限
rem  环境/受限令牌下会"拒绝访问"，而脚本当时静默跳过，于是旧桥接继续占着
rem  3100 端口，新实例起来后 EADDRINUSE 直接退出 —— 表现为"重启完还是旧代码"。
rem
rem  现在委托给 tools\restart-bridge-and-dsh.ps1：
rem    * 用 Get-NetTCPConnection 找端口占用者（失败则退化为解析 netstat）
rem    * 逐个 Stop-Process，失败再 taskkill /T /F
rem    * 拉起 start.bat 守护循环
rem    * 校验新端点已加载、已连上 SnowLuma
rem    * POST http://127.0.0.1:3780/api/restart 重启 DSH 子进程
rem ============================================================

echo Stopping old bridge and restarting (no WMI)...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\restart-bridge-and-dsh.ps1" -Root "%~dp0"
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo [警告] 重启脚本返回退出码 %RC%，请把上面输出发给管理员。
)

exit /b %RC%
