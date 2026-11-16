' 静默启动 flomo local 独立窗口（不弹黑框）
Set sh = CreateObject("WScript.Shell")
base = "E:\flomolocal"
sh.Run "node """ & base & "\desktop\launcher.js""", 0, False
