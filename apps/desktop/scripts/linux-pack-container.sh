#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates git python3 make g++ xz-utils
echo "copying source into linux workspace..."
mkdir -p /work /out
tar -C /src --exclude=node_modules --exclude=apps/desktop/release --exclude=apps/desktop/stage --exclude=apps/desktop/runtime --exclude=安装包 --exclude=.git --exclude=.pnpm-store -cf - . | tar -C /work -xf -
cd /work
export NODE_ENV=development
export CI=true
export CSC_IDENTITY_AUTO_DISCOVERY=false
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
node apps/desktop/scripts/ensure-built.mjs
node apps/desktop/scripts/bundle-pet.mjs
node apps/desktop/scripts/pack.mjs
ls -lah 安装包
cp -v 安装包/*.AppImage /out/
echo "linux pack done"
