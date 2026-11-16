# 打包 flomo local 成可分发的 zip
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-release.ps1
#   powershell ... -NoNode            # 不带 Node 运行时（对方自己装 Node 22+）
#   powershell ... -Version 1.1.0
param(
  [string]$Version = '',
  [switch]$NoNode
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $Version = (& node -p "require('$($root -replace '\\','/')/version.js').version").Trim()
}
$name = 'flomo-local-' + $Version + '-win-x64'
$dist = Join-Path $root 'dist'
# 每次用一个全新的暂存目录：旧的构建目录可能被资源管理器/杀软占着句柄，删不掉也不影响本次出包
$stage = Join-Path $dist ('.stage-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 1) 代码与静态资源（data/ 永远不打包）
foreach ($f in @('server.js', 'db.js', 'llm.js', 'version.js', 'README.md')) {
  Copy-Item (Join-Path $root $f) $stage
}
foreach ($d in @('lib', 'prompts', 'public', 'assets')) {
  Copy-Item (Join-Path $root $d) (Join-Path $stage $d) -Recurse
}

# 2) 桌面壳 + 工具
New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'desktop') -Force | Out-Null
Copy-Item (Join-Path $root 'desktop\launcher.js') (Join-Path $stage 'desktop')
Copy-Item (Join-Path $root 'tools\release\open.vbs') (Join-Path $stage 'desktop')
foreach ($t in @('import-flomo.js', 'make-shortcut.ps1', 'make-icon.py', 'selftest.js')) {
  $src = Join-Path $root ('tools\' + $t)
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage 'tools') }
}

# 3) Node 运行时（默认内置，双击即用）
if (-not $NoNode) {
  New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
  Copy-Item (Get-Command node).Source (Join-Path $stage 'runtime\node.exe')
}

# 4) 启动脚本与说明（源文件在 tools\release\，避免在脚本里拼字符串）
Copy-Item (Join-Path $root 'tools\release\start.cmd') $stage
Copy-Item (Join-Path $root '创建桌面快捷方式.cmd') $stage
Copy-Item (Join-Path $root 'tools\release\start-desktop.cmd') $stage
Copy-Item (Join-Path $root 'tools\release\使用说明.txt') $stage

# 5) 版本清单（给「检查更新」用）
$verJson = '{"name":"flomo local","version":"' + $Version + '","platform":"win-x64"}'
Set-Content -Path (Join-Path $stage 'version.json') -Value $verJson -Encoding UTF8

# 6) 打 zip
$zip = Join-Path $dist ($name + '.zip')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output ('release zip : ' + $zip + ' (' + $mb + ' MB)')

# 7) 自动更新用的「程序包」：内容相同但不带 runtime，客户端下载后覆盖程序文件、保留 data 与 runtime
$appStage = Join-Path $dist ('.app-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $appStage -Force | Out-Null
Copy-Item -Path (Join-Path $stage '*') -Destination $appStage -Recurse -Force
$runtimeDir = Join-Path $appStage 'runtime'
if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
$appZip = Join-Path $dist ('flomo-local-' + $Version + '-app.zip')
if (Test-Path $appZip) { Remove-Item $appZip -Force }
Compress-Archive -Path (Join-Path $appStage '*') -DestinationPath $appZip -CompressionLevel Optimal
$appKb = [math]::Round((Get-Item $appZip).Length / 1KB, 0)
Write-Output ('app  zip   : ' + $appZip + ' (' + $appKb + ' KB, 自动更新用)')
try { Remove-Item $appStage -Recurse -Force -ErrorAction Stop } catch { }

try { Remove-Item $stage -Recurse -Force -ErrorAction Stop } catch { Write-Output ('note: 暂存目录没删掉（句柄被占），可重启后再删：' + $stage) }
