#!/bin/sh
set -eu
cd "$(dirname "$0")"

echo
echo "========================================"
echo "  汐灵 OS 桌面端 - 一键启动"
echo "========================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 22+"
  echo "https://nodejs.org/"
  exit 1
fi

export NODE_ENV=development
unset CI || true
echo "[1/3] 启用 pnpm 11.19.0 ..."
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@11.19.0 --activate

if [ -f node_modules/typescript/package.json ] && [ -d apps/desktop/node_modules/electron ]; then
  echo "[2/3] 依赖已经装过 跳过安装。"
else
  echo "[2/3] 正在安装依赖 第一次或被清过后会比较久..."
  CI=true pnpm install
fi

if [ ! -f apps/server/dist/index.js ]; then
  echo "还没有构建过 将自动编译 请等几分钟..."
else
  echo "检测到已经构建过 将直接打开窗口。"
fi

echo "[3/3] 正在打开桌面窗口和右下角悬浮球 ..."
node apps/desktop/scripts/ensure-built.mjs
node apps/desktop/scripts/bundle-pet.mjs
node apps/desktop/scripts/launch-electron.mjs
