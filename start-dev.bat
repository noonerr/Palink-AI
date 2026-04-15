@echo off
echo Starting Palink-AI Development Server...
cd /d "%~dp0frontend"
start cmd /k "npm run dev"
echo.
echo Frontend dev server started at http://localhost:3000
echo.
echo Starting Docker backend services...
cd /d "%~dp0"
docker-compose up -d backend db
echo.
echo Done! Backend services are starting...
echo.
pause
