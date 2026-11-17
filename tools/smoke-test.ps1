# flomo local · 打包冒烟检查
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\smoke-test.ps1 -AppDir <程序目录> [-Port 7781]
# 用一个临时数据目录起服务，验证：版本一致、静态页可用、提示词 front-matter 解析正常（不是文件名）、数据目录可解析。
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [int]$Port = 7781
)

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path -LiteralPath $AppDir).Path
$fail = New-Object System.Collections.Generic.List[string]
$pass = New-Object System.Collections.Generic.List[string]

function Ok([string]$m) { $script:pass.Add($m); Write-Host ("  [ok]   " + $m) }
function Bad([string]$m) { $script:fail.Add($m); Write-Host ("  [FAIL] " + $m) -ForegroundColor Red }

Write-Host ("冒烟检查: " + $AppDir)

# ---- 1) 关键文件在不在 ----
$need = @('server.js', 'db.js', 'llm.js', 'version.js', 'package.json', 'public\index.html', 'public\app.js',
  'electron\main.js', 'electron\preload.js', 'assets\flomo-local.ico', 'prompts\insights\default.md')
foreach ($f in $need) {
  if (Test-Path (Join-Path $AppDir $f)) { Ok ("文件 " + $f) } else { Bad ("缺少 " + $f) }
}
if (-not (Test-Path (Join-Path $AppDir 'flomo-local.exe'))) { Write-Host '  [warn] 没有 flomo-local.exe（源码目录跑冒烟时会这样，正常）' }

# ---- 2) 起服务（临时数据目录，不碰用户数据）----
$node = Join-Path $AppDir 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$tmpData = Join-Path $env:TEMP ('flomo-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpData -Force | Out-Null
$env:PORT = "$Port"
$env:FLOMO_DATA_DIR = $tmpData
$log = Join-Path $tmpData 'server.log'
$errLog = Join-Path $tmpData 'server.err.log'
$proc = Start-Process -FilePath $node -ArgumentList (Join-Path $AppDir 'server.js') -WorkingDirectory $AppDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog

$base = "http://127.0.0.1:$Port"
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try { $null = Invoke-WebRequest -UseBasicParsing "$base/api/version" -TimeoutSec 2; $up = $true; break } catch { }
}
if (-not $up) {
  Bad '服务没起来'
  Write-Host (Get-Content $log, $errLog -ErrorAction SilentlyContinue | Select-Object -Last 10)
} else {
  Ok '服务已启动'

  try {
    $ver = (Invoke-WebRequest -UseBasicParsing "$base/api/version" -TimeoutSec 5).Content | ConvertFrom-Json
    $want = (Select-String -Path (Join-Path $AppDir 'version.js') -Pattern "version: '([^']+)'" | Select-Object -First 1).Matches[0].Groups[1].Value
    if ($ver.version -eq $want) { Ok ("版本一致 " + $ver.version) } else { Bad ("版本不一致 api=" + $ver.version + " version.js=" + $want) }
  } catch { Bad ("/api/version 失败: " + $_.Exception.Message) }

  try {
    $html = (Invoke-WebRequest -UseBasicParsing "$base/" -TimeoutSec 5).Content
    if ($html -match 'flomo') { Ok '静态首页可访问' } else { Bad '首页内容异常' }
  } catch { Bad ("首页失败: " + $_.Exception.Message) }

  try {
    $b = (Invoke-WebRequest -UseBasicParsing "$base/api/bootstrap" -TimeoutSec 8).Content | ConvertFrom-Json
    if ($b.storage -and $b.storage.path -and (Test-Path (Split-Path -Parent $b.storage.path))) { Ok ("数据目录可用 " + $b.storage.dir) } else { Bad 'storage.path 不可用' }
    $badPrompt = @($b.prompts | Where-Object { $_.name -eq $_.kind })
    if ($b.prompts.Count -ge 5 -and $badPrompt.Count -eq 0) { Ok ("基础提示词名称正常 (" + $b.prompts.Count + " 个)") }
    else { Bad ("基础提示词名称异常 (" + $badPrompt.Count + "/" + $b.prompts.Count + " 退化成文件名)") }
  } catch { Bad ("/api/bootstrap 失败: " + $_.Exception.Message) }

  try {
    $ins = (Invoke-WebRequest -UseBasicParsing "$base/api/insights" -TimeoutSec 8).Content | ConvertFrom-Json
    $p = @($ins.perspectives)
    $slug = @($p | Where-Object { $_.name -eq $_.id })
    $other = @($p | Where-Object { $_.category -eq '其它' })
    if ($p.Count -ge 20) { Ok ("视角数量 " + $p.Count) } else { Bad ("视角数量偏少: " + $p.Count) }
    if ($slug.Count -eq 0) { Ok '视角名称都是中文标题' } else { Bad ("有 " + $slug.Count + " 个视角名称退化成文件名，例: " + $slug[0].id) }
    if ($other.Count -eq 0) { Ok '视角分类都已解析' } else { Bad ("有 " + $other.Count + " 个视角分类是「其它」") }
    $noRange = @($p | Where-Object { -not $_.range })
    if ($noRange.Count -eq 0) { Ok '视角推荐范围都有' } else { Bad ("有 " + $noRange.Count + " 个视角缺 range") }
  } catch { Bad ("/api/insights 失败: " + $_.Exception.Message) }
}

# ---- 3) 收尾 ----
if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400
Remove-Item $tmpData -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:PORT, Env:FLOMO_DATA_DIR -ErrorAction SilentlyContinue

Write-Host ''
if ($fail.Count -gt 0) {
  Write-Host ("冒烟检查失败：" + $fail.Count + " 项") -ForegroundColor Red
  $fail | ForEach-Object { Write-Host ("  - " + $_) -ForegroundColor Red }
  exit 1
}
Write-Host ("冒烟检查通过：" + $pass.Count + " 项") -ForegroundColor Green
