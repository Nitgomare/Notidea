' 静默启动 flomo local（优先 Electron 壳，否则退回 start-desktop.cmd）
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
base = fso.GetParentFolderName(scriptDir)
sh.CurrentDirectory = base
If fso.FileExists(base & "\flomo-local.exe") Then
  sh.Run """" & base & "\flomo-local.exe"" """ & base & """", 0, False
Else
  sh.Run """" & base & "\start-desktop.cmd""", 0, False
End If
