@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  ========================================
echo    汐灵 OS 桌面端 - 一键打包
echo  ========================================
echo.
echo  完成后会打开仓库里的 安装包 文件夹
echo  里面的 exe 才是 Windows 安装文件
echo  如果已经构建过 这次会快很多
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。请先安装 Node.js 22+。
  pause
  exit /b 1
)

set "CI="
set "NODE_ENV=development"
call corepack enable >nul 2>nul
call corepack prepare pnpm@11.19.0 --activate

if exist "node_modules\typescript\package.json" if exist "apps\desktop\node_modules\electron-builder\" (
  echo 依赖已经装过 跳过安装。
  goto SKIP_INSTALL
)
echo 正在安装依赖 第一次或被清过后会比较久...
set CI=true
call pnpm install
if errorlevel 1 (
  set "CI="
  echo [错误] 依赖安装失败。
  pause
  exit /b 1
)
set "CI="

:SKIP_INSTALL

if not exist "apps\server\dist\index.js" (
  echo 还没有构建过 先完整编译 请等几分钟...
  call pnpm build
  if errorlevel 1 (
    echo [错误] 构建失败。
    pause
    exit /b 1
  )
) else (
  echo 检测到已经构建过 跳过完整编译。
)

echo 正在打包 请等几分钟...
call node apps\desktop\scripts\ensure-built.mjs
if errorlevel 1 goto PACK_FAIL
call node apps\desktop\scripts\bundle-pet.mjs
if errorlevel 1 goto PACK_FAIL
call node apps\desktop\scripts\pack.mjs
if errorlevel 1 goto PACK_FAIL
goto PACK_OK

:PACK_FAIL
echo [错误] 打包失败。
echo 如果提示目录被占用：先关掉汐灵和右下角悬浮球，再重新双击本文件。
pause
exit /b 1

:PACK_OK
set "OUT=%~dp0安装包"
if not exist "%OUT%\*.exe" if not exist "%OUT%\*.dmg" if not exist "%OUT%\*.AppImage" (
  echo [错误] 没有找到安装包。正确位置是：
  echo   %OUT%
  pause
  exit /b 1
)

echo.
echo 完成。安装包在：
echo   %OUT%
echo.
explorer "%OUT%"
pause
