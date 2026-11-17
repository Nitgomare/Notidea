# 打包 拾念（Windows）
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-release.ps1
# 产出：
#   dist\notidea-<版本>-win-x64.zip   完整包（Electron 壳 + Node 运行时）
#   dist\notidea-<版本>-app.zip       仅程序文件（自动更新用）
#   updates\notidea-<版本>-app.zip    镜像（jsDelivr / raw 兜底）
param(
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $Version = (& node -p "require('$($root -replace '\\','/')/version.js').version").Trim()
}

$dist = Join-Path $root 'dist'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ---------- 1) 程序文件（安装包与更新包共用） ----------
$app = Join-Path $dist ('.app-' + $stamp)
New-Item -ItemType Directory -Path $app -Force | Out-Null

foreach ($f in @('server.js', 'db.js', 'llm.js', 'version.js', 'README.md', 'package.json')) {
  Copy-Item (Join-Path $root $f) $app
}
foreach ($d in @('lib', 'prompts', 'public', 'assets')) {
  Copy-Item (Join-Path $root $d) (Join-Path $app $d) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $app 'electron') -Force | Out-Null
Copy-Item (Join-Path $root 'electron\main.js') (Join-Path $app 'electron')
Copy-Item (Join-Path $root 'electron\preload.js') (Join-Path $app 'electron')

New-Item -ItemType Directory -Path (Join-Path $app 'desktop') -Force | Out-Null
Copy-Item (Join-Path $root 'desktop\launcher.js') (Join-Path $app 'desktop')
Copy-Item (Join-Path $root 'tools\release\open.vbs') (Join-Path $app 'desktop')

New-Item -ItemType Directory -Path (Join-Path $app 'tools') -Force | Out-Null
foreach ($t in @('import-flomo.js', 'make-shortcut.ps1', 'make-icon.py', 'selftest.js')) {
  $src = Join-Path $root ('tools\' + $t)
  if (Test-Path $src) { Copy-Item $src (Join-Path $app 'tools') }
}

# 启动脚本与说明（源文件在 tools\release\）
Copy-Item (Join-Path $root 'tools\release\start.cmd') $app
Copy-Item (Join-Path $root '创建桌面快捷方式.cmd') $app
Copy-Item (Join-Path $root 'tools\release\start-desktop.cmd') $app
Copy-Item (Join-Path $root 'tools\release\使用说明.txt') $app

# 版本清单
$verJson = '{"name":"拾念","version":"' + $Version + '","platform":"win-x64"}'
Set-Content -Path (Join-Path $app 'version.json') -Value $verJson -Encoding UTF8

# ---------- 2) 更新包（仅程序文件，不含 Electron 运行时与 node.exe） ----------
$appZip = Join-Path $dist ('notidea-' + $Version + '-app.zip')
if (Test-Path $appZip) { Remove-Item $appZip -Force }
Compress-Archive -Path (Join-Path $app '*') -DestinationPath $appZip -CompressionLevel Optimal
$appKb = [math]::Round((Get-Item $appZip).Length / 1KB, 0)
Write-Output ('app  zip    : ' + $appZip + ' (' + $appKb + ' KB, 自动更新用)')

# ---------- 3) 完整包 = 程序文件 + Electron 壳 + Node 运行时 ----------
$full = Join-Path $dist ('.full-' + $stamp)
New-Item -ItemType Directory -Path $full -Force | Out-Null
Copy-Item -Path (Join-Path $app '*') -Destination $full -Recurse -Force

$eDist = Join-Path $root 'node_modules\electron\dist'
if (Test-Path (Join-Path $eDist 'electron.exe')) {
  Copy-Item -Path (Join-Path $eDist '*') -Destination $full -Recurse -Force
  $exe = Join-Path $full 'electron.exe'
  Move-Item $exe (Join-Path $full 'Notidea.exe') -Force
  # Electron dist 自带一个无扩展名的 version 文件，会抢走 require('./version')，必须删掉
  Remove-Item (Join-Path $full 'version') -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $full 'LICENSE') (Join-Path $full 'LICENSE.electron') -ErrorAction SilentlyContinue
  Write-Output 'electron    : yes'
} else {
  Write-Output 'electron    : MISSING（先跑 npm install）'
}

New-Item -ItemType Directory -Path (Join-Path $full 'runtime') -Force | Out-Null
Copy-Item (Get-Command node).Source (Join-Path $full 'runtime\node.exe')

$zip = Join-Path $dist ('notidea-' + $Version + '-win-x64.zip')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $full '*') -DestinationPath $zip -CompressionLevel Optimal
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output ('release zip : ' + $zip + ' (' + $mb + ' MB)')

# ---------- 3.5) 冒烟检查：起服务验接口（提示词解析、数据目录、版本一致性） ----------
$smoke = Join-Path $root 'tools\smoke-test.ps1'
if (Test-Path $smoke) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $smoke -AppDir $full -Port 7783
  if ($LASTEXITCODE -ne 0) {
    throw '冒烟检查没通过，打包中止（看上面的 [FAIL] 项）'
  }
}
# ---------- 4) 镜像（jsDelivr / raw 兜底） ----------
$mirrorDir = Join-Path $root 'updates'
New-Item -ItemType Directory -Path $mirrorDir -Force | Out-Null
$mirrorZip = Join-Path $mirrorDir ('notidea-' + $Version + '-app.zip')
Copy-Item $appZip $mirrorZip -Force
Write-Output ('mirror zip  : ' + $mirrorZip + '（记得 git add 并随版本一起推）')

try { Remove-Item $full -Recurse -Force -ErrorAction Stop } catch { }
try { Remove-Item $app -Recurse -Force -ErrorAction Stop } catch { Write-Output ('note: 暂存目录没删掉：' + $app) }
