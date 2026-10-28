' Runs launch.js with no console window. Desktop and Startup shortcuts point here.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
args = ""
If WScript.Arguments.Count > 0 Then args = " " & WScript.Arguments(0)
sh.Run "node """ & dir & "\..\launch.js""" & args, 0, False
