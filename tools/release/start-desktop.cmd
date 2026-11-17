@echo off
cd /d "%~dp0"
rem Some environments inject ELECTRON_RUN_AS_NODE, which turns Electron into plain node.
set "ELECTRON_RUN_AS_NODE="
rem 1) packaged build: flomo-local.exe sits next to this file
if exist "flomo-local.exe" (
  start "" "flomo-local.exe" "%CD%"
  exit /b 0
)
rem 2) source checkout: use the Electron installed by npm
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "%CD%"
  exit /b 0
)
rem 3) no Electron: fall back to the Edge app window
node "desktop\launcher.js"
