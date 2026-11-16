' 静默启动 flomo local 独立窗口（不弹黑框）
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
If fso.FileExists(base & "\runtime\node.exe") Then
  exe = base & "\runtime\node.exe"
Else
  exe = "node"
End If
sh.CurrentDirectory = base
sh.Run """" & exe & """ """ & base & "\desktop\launcher.js""", 0, False
