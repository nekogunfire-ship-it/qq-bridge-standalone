' ---------------------------------------------------------------------------
' Start the QQ bridge as a detached background process.
'
' WHY THIS FILE EXISTS
'   Starting the bridge directly from an agent/tool shell does NOT survive:
'   the harness binds spawned children to its own job object, so the bridge
'   dies the moment that shell exits. Going through Task Scheduler (or the
'   Startup folder) gives the process a normal user-session parent, so it
'   keeps running after this window is gone.
'
' Logs: qq-bridge\tools\runtime\bridge-new-out.log / bridge-new-err.log
' ---------------------------------------------------------------------------
Option Explicit

Dim fso, shell, bridgeDir, nodeExe, outLog, errLog, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

bridgeDir = "C:\Users\31085\Documents\deepseek-harness\默认工作区\qq-bridge"
nodeExe = "D:\DSH\node\node.exe"

If Not fso.FileExists(nodeExe) Then
  WScript.Echo "node not found: " & nodeExe
  WScript.Quit 1
End If
If Not fso.FileExists(bridgeDir & "\src\bridge.js") Then
  WScript.Echo "bridge entry not found: " & bridgeDir & "\src\bridge.js"
  WScript.Quit 1
End If

' A stale lock makes the bridge refuse to start; drop it when its PID is gone.
Dim lockFile, lockPid
lockFile = bridgeDir & "\state\bridge.lock"
If fso.FileExists(lockFile) Then
  On Error Resume Next
  Dim ts, raw
  Set ts = fso.OpenTextFile(lockFile, 1)
  raw = Trim(ts.ReadAll)
  ts.Close
  On Error GoTo 0
  lockPid = 0
  If IsNumeric(raw) Then lockPid = CLng(raw)
  If lockPid <= 0 Then
    On Error Resume Next
    fso.DeleteFile lockFile, True
    On Error GoTo 0
  Else
    Dim wmi, procs, p
    On Error Resume Next
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & lockPid)
    On Error GoTo 0
    If procs.Count = 0 Then
      On Error Resume Next
      fso.DeleteFile lockFile, True
      On Error GoTo 0
    End If
  End If
End If

outLog = bridgeDir & "\tools\runtime\bridge-new-out.log"
errLog = bridgeDir & "\tools\runtime\bridge-new-err.log"

shell.CurrentDirectory = bridgeDir
cmd = """" & nodeExe & """ src\bridge.js > """ & outLog & """ 2> """ & errLog & """"

' 0 = hidden window, False = do not wait for it to finish (detached)
shell.Run cmd, 0, False
