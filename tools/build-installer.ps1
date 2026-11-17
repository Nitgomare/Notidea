# 编译一键安装器：install\Installer.cs -> dist\install-flomo-local.exe
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-installer.ps1
param([string]$Out = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw '找不到 csc.exe（.NET Framework 4.x）' }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
if (-not $Out) { $Out = Join-Path $dist 'install-flomo-local.exe' }

& $csc /nologo /target:winexe /platform:anycpu /out:$Out `
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Net.Http.dll /r:Microsoft.CSharp.dll `
  (Join-Path $root 'install\Installer.cs')
if ($LASTEXITCODE -ne 0) { throw ('编译失败：' + $LASTEXITCODE) }

$kb = [math]::Round((Get-Item -LiteralPath $Out).Length / 1KB, 0)
Write-Output ('installer exe : ' + $Out + ' (' + $kb + ' KB)')
