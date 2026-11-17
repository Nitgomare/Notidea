#!/bin/sh
# flomo local · macOS 启动器（双击运行，或用 sh start.command）
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

exec node desktop/launcher.js
