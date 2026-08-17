@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo   Palink-AI 开发模式启动器
echo ============================================
echo.
echo 请选择开发模式：
echo.
echo   [1] Docker 热更新模式（推荐）
echo       - 前端代码修改后自动热更新
echo       - 后端继续使用 Docker 容器
echo       - 访问地址: http://localhost:3000
echo.
echo   [2] 本地 Vite 开发模式
echo       - 需要后端已在 localhost:8000 运行
echo       - 访问地址: http://localhost:3000
echo.
echo   [3] 生产模式（重建容器）
echo       - 修改代码后需要重建前端容器
echo.
set /p choice="请输入选择 [1/2/3]: "

if "%choice%"=="1" goto docker_dev
if "%choice%"=="2" goto local_dev
if "%choice%"=="3" goto production
echo 无效选择
pause
exit /b

:docker_dev
echo.
echo 启动 Docker 热更新模式...
echo 修改 frontend/src 下的代码后浏览器自动刷新！
echo.

set "TEMP_BUILD=%TEMP%\palink-frontend-dev-build"
echo 复制前端文件到临时目录...
if exist "%TEMP_BUILD%" rmdir /s /q "%TEMP_BUILD%"
xcopy "%~dp0frontend" "%TEMP_BUILD%\" /e /i /q /exclude:%~dp0frontend\.dockerignore >nul 2>&1

echo 构建 Docker 开发镜像...
cd /d "%TEMP_BUILD%"
docker build -f Dockerfile.dev -t palink-ai-frontend:dev . 2>&1
if errorlevel 1 (
    echo 构建失败！
    pause
    exit /b 1
)

echo 启动开发容器...
cd /d "%~dp0"
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d frontend 2>&1

echo.
echo 开发服务器已启动！访问 http://localhost:3000
echo 查看日志: docker compose logs -f frontend
echo 停止: docker compose -f docker-compose.yml -f docker-compose.dev.yml stop frontend
pause
exit /b

:local_dev
echo.
echo 启动本地 Vite 开发服务器...
echo 请确保后端已在 http://localhost:8000 运行
echo.
cd /d "%~dp0frontend"
if not exist node_modules (
    echo 正在安装依赖...
    npm install
    echo.
)
npm run dev
pause
exit /b

:production
echo.
echo 重建生产模式容器...
cd /d "%~dp0"

set "TEMP_BUILD=%TEMP%\palink-frontend-prod-build"
echo 复制前端文件到临时目录...
if exist "%TEMP_BUILD%" rmdir /s /q "%TEMP_BUILD%"
xcopy "%~dp0frontend" "%TEMP_BUILD%\" /e /i /q >nul 2>&1

echo 构建前端生产镜像...
cd /d "%TEMP_BUILD%"
docker build -t palink-ai-frontend . 2>&1
if errorlevel 1 (
    echo 构建失败！
    pause
    exit /b 1
)

echo 启动生产容器...
cd /d "%~dp0"
docker compose up -d 2>&1

echo.
echo 生产模式已启动！访问 http://localhost:3000
pause
exit /b
