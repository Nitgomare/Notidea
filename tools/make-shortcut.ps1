# 创建 flomo local 快捷方式（默认：桌面 + 桌面版窗口）
# 直接运行会询问保存位置；也可以带参数：
#   -Dest "D:\somewhere"        指定文件夹（或直接给 .lnk 完整路径）
#   -Name "flomo local"         快捷方式名字
#   -Reveal                     创建完在资源管理器里选中它
param(
  [string]$Dest = '',
  [string]$Name = 'flomo local',
  [switch]$Reveal,
  [switch]$Quiet
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Get-RealDesktop {
  if ($env:FLOMO_SHORTCUT_DESKTOP -and (Test-Path $env:FLOMO_SHORTCUT_DESKTOP)) { return $env:FLOMO_SHORTCUT_DESKTOP }
  try {
    $d = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop).Desktop
    if ($d) {
      $d = [Environment]::ExpandEnvironmentVariables($d)
      if ($d -and (Test-Path $d)) { return $d }
      if ($d) { New-Item -ItemType Directory -Path $d -Force | Out-Null; if (Test-Path $d) { return $d } }
    }
  } catch { }
  try {
    $d = [Environment]::GetFolderPath('Desktop')
    if ($d -and (Test-Path $d)) { return $d }
    if ($d) { New-Item -ItemType Directory -Path $d -Force | Out-Null; if (Test-Path $d) { return $d } }
  } catch { }
  $d = Join-Path $env:USERPROFILE 'Desktop'
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  return $d
}

function Resolve-Target {
  if (-not (Test-Path $root)) { throw ('找不到程序目录：' + $root) }
  # 优先：打包好的 Electron 壳（无边框窗口，和安装器建的一致）
  $appExe = Join-Path $root 'flomo-local.exe'
  if (Test-Path $appExe) { return @{ Exe = $appExe; Args = ('"' + $root + '"'); Dir = $root } }


  $vbs = Join-Path $root 'desktop\open.vbs'
  if (Test-Path $vbs) { return @{ Exe = (Join-Path $env:WINDIR 'System32\wscript.exe'); Args = ('"' + $vbs + '"'); Dir = $root } }
  $cmd = Join-Path $root 'start-desktop.cmd'
  if (Test-Path $cmd) { return @{ Exe = $cmd; Args = ''; Dir = $root } }
  throw '看起来这不是 flomo local 的目录（缺 desktop\open.vbs）'
}

$desktop = Get-RealDesktop
$target = Resolve-Target

if (-not $Dest) {
  if ($Quiet) {
    $Dest = $desktop
  } else {
  Write-Host ''
  Write-Host '  flomo local · 创建快捷方式' -ForegroundColor Green
  Write-Host '  ------------------------------------------------------------'
  Write-Host ('  默认（直接回车）：' + $desktop)
  Write-Host '  想放别处就把文件夹粘进来，例如 C:\Users\me\Desktop 或开始菜单目录'
  Write-Host '  ------------------------------------------------------------'
  $answer = Read-Host '  保存到哪个文件夹'

  if ([string]::IsNullOrWhiteSpace($answer)) {
    $Dest = $desktop
  } else {
    $Dest = $answer.Trim().Trim('"').Trim("'")
    if ($Dest -eq '~') { $Dest = $env:USERPROFILE }
    $Dest = [Environment]::ExpandEnvironmentVariables($Dest)
  }
  }
}

# 允许直接给一个 .lnk 全路径
if ($Dest.ToLower().EndsWith('.lnk')) {
  $linkPath = $Dest
  $Dest = Split-Path -Parent $Dest
} else {
  $linkPath = Join-Path $Dest ($Name + '.lnk')
}

if (-not (Test-Path $Dest)) {
  Write-Host ('  目录不存在：' + $Dest) -ForegroundColor Yellow
  $mk = Read-Host '  要新建这个文件夹吗？(Y/n)'
  if ($mk -and $mk.Trim().ToLower().StartsWith('n')) {
    Write-Host '  已取消。' -ForegroundColor Yellow
    exit 1
  }
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null
  Write-Host ('  已创建：' + $Dest)
}

try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($linkPath)
  $lnk.TargetPath = $target.Exe
  $lnk.Arguments = $target.Args
  $lnk.WorkingDirectory = $target.Dir
  $ico = Join-Path $root 'assets\flomo-local.ico'
  if (Test-Path $ico) { $lnk.IconLocation = $ico + ',0' }
  $lnk.Description = 'flomo local - 本地卡片笔记（独立窗口）'
  $lnk.WindowStyle = 7
  $lnk.Save()
} catch {
  Write-Host ('  创建失败：' + $_.Exception.Message) -ForegroundColor Red
  Write-Host '  提示：如果目标在 OneDrive/受保护目录，换个位置再试。' -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path $linkPath)) { throw ('快捷方式没有生成：' + $linkPath) }
Write-Host ''
Write-Host ('  已创建：' + $linkPath) -ForegroundColor Green
Write-Host '  双击它就会打开独立的笔记窗口（和 flomo 一样，不带浏览器地址栏）'

if ($Reveal) {
  Start-Process explorer.exe ('/select,"' + $linkPath + '"')
}
