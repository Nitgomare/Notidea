@echo off
REM 编译无边框桌面外壳（需要 .NET Framework 4.8 自带的 csc）
setlocal
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [!] 找不到 csc.exe（.NET Framework 4.x）
  exit /b 1
)
"%CSC%" /nologo /target:winexe /out:FlomoShell.exe /platform:x64 ^
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll ^
  /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll ^
  FlomoShell.cs
if errorlevel 1 (
  echo [!] 编译失败
  exit /b 1
)
echo [ok] FlomoShell.exe
