' 静默启动 flomo local（优先 Electron 壳，其次 start-desktop.cmd）
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = base
If fso.FileExists(base & "\flomo-local.exe") Then
  sh.Run """" & base & "\flomo-local.exe"" """ & base & """", 0, False
ElseIf fso.FileExists(base & "\start-desktop.cmd") Then
  sh.Run """" & base & "\start-desktop.cmd""", 0, False
Else
  sh.Run """" & base & "\runtime\node.exe"" """ & base & "\desktop\launcher.js""", 0, False
End If