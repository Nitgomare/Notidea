@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  = 拾念 updater =
echo.
if not exist "%~dp0..\server.js" (
  echo  [!] Extract this patch INSIDE the 拾念 folder
  echo      so that this patch folder sits next to server.js and data.
  echo.
  pause
  exit /b 1
)
echo  Copying new program files to: %~dp0..
echo  (your data\ and runtime\ folders are left untouched)
echo.
robocopy "%~dp0." "%~dp0.." /E /XF update.cmd *.txt /XD "data" "runtime" "dist" /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo  [!] Copy failed. Please take a screenshot of this window.
  pause
  exit /b 1
)
echo  Done. Close the old window, then run start-desktop.cmd again.
echo.
pause
