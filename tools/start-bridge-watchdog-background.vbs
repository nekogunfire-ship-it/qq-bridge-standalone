' ---------------------------------------------------------------------------
' Start the QQ-bridge watchdog hidden, detached, and independent of any shell.
'
' WHY: bridge-watchdog.ps1 monitors the bridge console (:3100), restarts the
'   bridge when it is dead/hung, and re-runs the DSH endpoint sync when DSH
'   changes port. Starting it from an agent/tool shell does not survive, so use
'   this script (directly, or via the "QQ Bridge Watchdog" scheduled task).
'
' Log : qq-bridge\state\slang-agent\bridge-watch.log
' PID : qq-bridge\state\slang-agent\bridge-watch.pid
' Stop: qq-bridge\state\slang-agent\stop-bridge-watchdog.vbs
' ---------------------------------------------------------------------------
Option Explicit

Dim fso, shell, here, script
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = "C:\Users\31085\Documents\deepseek-harness\默认工作区\qq-bridge\state\slang-agent"
script = fso.BuildPath(here, "bridge-watchdog.ps1")

If Not fso.FileExists(script) Then
  WScript.Echo "bridge-watchdog.ps1 not found: " & script
  WScript.Quit 1
End If

shell.Run "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 0, False
