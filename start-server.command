#!/bin/sh
# flomo local · 只启动本地服务（然后在浏览器打开 http://127.0.0.1:7777）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  需要 Node.js 22.5 或更高版本。"
  echo "  安装：brew install node   或到 https://nodejs.org 下载"
  echo ""
  printf "  按回车关闭…"
  read -r _
  exit 1
fi

echo ""
echo "  flomo local：http://127.0.0.1:7777"
echo "  按 Ctrl+C 停止服务"
echo ""
exec node server.js
