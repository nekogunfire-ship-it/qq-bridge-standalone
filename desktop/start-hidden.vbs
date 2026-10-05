Option Explicit

' Launch desktop/start.mjs without creating a console window.
' Arguments: node.exe, start.mjs, working directory.
Dim shell, nodeExe, startScript, workDir, command
nodeExe = WScript.Arguments(0)
startScript = WScript.Arguments(1)
workDir = WScript.Arguments(2)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = workDir
command = """" & nodeExe & """ """ & startScript & """"
shell.Run command, 0, False
