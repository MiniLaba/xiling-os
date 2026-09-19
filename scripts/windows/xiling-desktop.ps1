$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "../.."))

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "请先安装 Node.js 22+"
}

corepack enable | Out-Null
corepack prepare pnpm@11.19.0 --activate | Out-Null
pnpm install
pnpm desktop
