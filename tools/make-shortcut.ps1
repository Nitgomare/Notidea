# 在「真正的」桌面创建 flomo local 快捷方式
# 桌面可能被重定向到 D 盘，所以先读注册表里的 User Shell Folders
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$desktop = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').Desktop
$desktop = [Environment]::ExpandEnvironmentVariables($desktop)
if (-not (Test-Path $desktop)) { $desktop = [Environment]::GetFolderPath('Desktop') }

$target = Join-Path $desktop 'flomo local.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($target)
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + (Join-Path $root 'desktop\open.vbs') + '"'
$lnk.WorkingDirectory = $root
$lnk.IconLocation = (Join-Path $root 'assets\flomo-local.ico') + ',0'
$lnk.Description = 'flomo local - 本地卡片笔记'
$lnk.WindowStyle = 7
$lnk.Save()

Write-Output ('shortcut -> ' + $target)

# 清理可能残留在 C 盘用户桌面上的旧快捷方式
$old = Join-Path $env:USERPROFILE 'Desktop\flomo local.lnk'
if ((Test-Path $old) -and ($old -ne $target)) { Remove-Item $old -Force; Write-Output ('removed ' + $old) }
