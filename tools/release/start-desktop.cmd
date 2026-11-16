@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
"%NODE%" desktop\launcher.js
