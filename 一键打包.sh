#!/bin/sh
set -eu
cd "$(dirname "$0")"

echo
echo "========================================"
echo "  汐灵 OS 桌面端 - 一键打包"
echo "========================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 22+"
  exit 1
fi

export NODE_ENV=development
unset CI || true
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@11.19.0 --activate
if [ ! -f node_modules/typescript/package.json ]; then
  echo "正在安装依赖 第一次或被清过后会比较久..."
  CI=true pnpm install
else
  echo "依赖已经装过 跳过安装。"
fi
if [ ! -f apps/server/dist/index.js ]; then
  echo "还没有构建过 将自动编译 请等几分钟..."
fi
node apps/desktop/scripts/ensure-built.mjs
node apps/desktop/scripts/bundle-pet.mjs
node apps/desktop/scripts/pack.mjs

OUT="$(pwd)/安装包"
echo
echo "完成。安装包在："
echo "  $OUT"
echo
if command -v open >/dev/null 2>&1; then
  open "$OUT"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$OUT"
fi
