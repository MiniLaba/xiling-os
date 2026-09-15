@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  ========================================
echo    汐灵 OS 桌面端 - 一键启动
echo  ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。
  echo 请先安装 Node.js 22 或更高版本： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo [1/3] 启用 pnpm 11.19.0 ...
set "CI="
set "NODE_ENV=development"
call corepack enable >nul 2>nul
call corepack prepare pnpm@11.19.0 --activate

if exist "node_modules\typescript\package.json" if exist "apps\desktop\node_modules\electron\" goto SKIP_INSTALL
echo [2/3] 正在安装依赖 第一次或被清过后会比较久...
set CI=true
call pnpm install
if errorlevel 1 (
  set "CI="
  echo [错误] 依赖安装失败。
  pause
  exit /b 1
)
set "CI="
goto AFTER_INSTALL

:SKIP_INSTALL
echo [2/3] 依赖已经装过 跳过安装。

:AFTER_INSTALL
if not exist "apps\server\dist\index.js" (
  echo 还没有构建过 将自动编译 请等几分钟...
) else (
  echo 检测到已经构建过 将直接打开窗口。
)

echo [3/3] 正在打开桌面窗口和右下角悬浮球 ...
call node apps\desktop\scripts\ensure-built.mjs
if errorlevel 1 goto START_FAIL
call node apps\desktop\scripts\bundle-pet.mjs
if errorlevel 1 goto START_FAIL
call node apps\desktop\scripts\launch-electron.mjs
if errorlevel 1 goto START_FAIL
goto START_OK

:START_FAIL
echo [错误] 启动失败。请把上面的英文报错截图下来。
pause
exit /b 1

:START_OK
pause
