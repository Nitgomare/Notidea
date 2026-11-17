# 打包 macOS 版（不含 Node 运行时，要求本机 Node 22.5+）
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-mac-release.ps1
#   powershell ... -Version 1.3.3
param(
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $Version = (& node -p "require('$($root -replace '\\','/')/version.js').version").Trim()
}

$name = 'flomo-local-' + $Version + '-mac'
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist ('.mac-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 1) 程序文件
foreach ($f in @('server.js', 'db.js', 'llm.js', 'version.js', 'README.md')) {
  Copy-Item (Join-Path $root $f) $stage
}
foreach ($d in @('lib', 'prompts', 'public', 'assets')) {
  Copy-Item (Join-Path $root $d) (Join-Path $stage $d) -Recurse
}

# 2) 桌面壳 + 工具（只要跨平台的，Windows 专用脚本不进 mac 包）
New-Item -ItemType Directory -Path (Join-Path $stage 'tools') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'desktop') -Force | Out-Null
Copy-Item (Join-Path $root 'desktop\launcher.js') (Join-Path $stage 'desktop')
foreach ($t in @('import-flomo.js', 'selftest.js')) {
  $src = Join-Path $root ('tools\' + $t)
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage 'tools') }
}

# 3) macOS 启动脚本与说明
foreach ($f in @('start.command', 'start-server.command', '使用说明-mac.txt')) {
  Copy-Item (Join-Path $root $f) $stage
}

# 4) 版本清单
$verJson = '{"name":"flomo local","version":"' + $Version + '","platform":"mac"}'
Set-Content -Path (Join-Path $stage 'version.json') -Value $verJson -Encoding UTF8

# 5) 强制 LF，避免从 Windows 打出来的 .command 在 mac 上是 CRLF
foreach ($sh in @('start.command', 'start-server.command')) {
  $p = Join-Path $stage $sh
  if (Test-Path $p) {
    $t = [IO.File]::ReadAllText($p) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false)))
  }
}

# 6) 打 zip
$zip = Join-Path $dist ($name + '.zip')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output ('mac zip     : ' + $zip + ' (' + $mb + ' MB)')

try { Remove-Item $stage -Recurse -Force -ErrorAction Stop } catch { Write-Output ('note: 暂存目录没删掉：' + $stage) }
