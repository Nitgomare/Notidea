@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 有些环境（比如某些 IDE/终端）会把 ELECTRON_RUN_AS_NODE 传给子进程，Electron 会退化成 node
set "ELECTRON_RUN_AS_NODE="
rem 优先用 Electron 壳（flomo-local.exe，无边框窗口）
if exist "flomo-local.exe" (
  start "" "flomo-local.exe" "%~dp0"
  exit /b 0
)
rem 没有壳：退回旧的 Edge 应用窗口
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
"%NODE%" desktop\launcher.js
