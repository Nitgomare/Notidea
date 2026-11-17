# 打「增量更新包」：只含程序文件，不含 node.exe 和 data
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-patch.ps1
#   powershell ... -From 1.0.0 -To 1.1.0
param(
  [string]$From = '1.0.0',
  [string]$To = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $To) {
  $To = (& node -p "require('$($root -replace '\\','/')/version.js').version").Trim()
}
$name = 'notidea-' + $From + '-to-' + $To + '-patch'
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist ('.patch-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 1) 程序文件（不含 runtime / data）
foreach ($f in @('server.js', 'db.js', 'llm.js', 'version.js', 'README.md', 'package.json')) {
  Copy-Item (Join-Path $root $f) $stage
}
foreach ($d in @('lib', 'prompts', 'public', 'assets')) {
  Copy-Item (Join-Path $root $d) (Join-Path $stage $d) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $stage 'electron') -Force | Out-Null
Copy-Item (Join-Path $root 'electron\main.js') (Join-Path $stage 'electron')
Copy-Item (Join-Path $root 'electron\preload.js') (Join-Path $stage 'electron')
New-Item -ItemType Directory -Path (Join-Path $stage 'desktop') -Force | Out-Null
Copy-Item (Join-Path $root 'desktop\launcher.js') (Join-Path $stage 'desktop')
New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -Force | Out-Null
foreach ($t in @('make-shortcut.ps1', 'make-icon.py', 'selftest.js')) {
  $src = Join-Path $root ('tools\' + $t)
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage 'tools') }
}

# 2) 更新器与说明
Copy-Item (Join-Path $root 'tools\release\update.cmd') $stage
Copy-Item (Join-Path $root 'tools\release\更新说明.txt') $stage

# 3) 出包
$zip = Join-Path $dist ($name + '.zip')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

$kb = [math]::Round((Get-Item $zip).Length / 1KB, 0)
Write-Output ('patch zip : ' + $zip + ' (' + $kb + ' KB)')
Write-Output ('版本：' + $From + ' -> ' + $To)
try { Remove-Item $stage -Recurse -Force -ErrorAction Stop } catch { Write-Output ('note: 暂存目录没删掉：' + $stage) }
