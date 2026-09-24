@echo off
setlocal
cd /d "%~dp0"
title My Memory - Local Server

where.exe node >nul 2>&1
if errorlevel 1 goto no_node

node -e "if (Number(process.versions.node.split('.')[0]) < 18) process.exit(1)"
if errorlevel 1 goto old_node

node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if not errorlevel 1 goto already_running

echo Starting My Memory. Keep this window open while using the app.
echo The app will open at http://localhost:8000/index.html
node server.mjs
set "SERVER_EXIT=%ERRORLEVEL%"
if not "%SERVER_EXIT%"=="0" (
  echo.
  echo The local server stopped with error code %SERVER_EXIT%.
  pause
)
exit /b %SERVER_EXIT%

:already_running
echo My Memory is already running. Opening the app...
start "" "http://localhost:8000/index.html"
exit /b 0

:no_node
echo Node.js was not found. Install Node.js 18 or newer, then run this file again.
pause
exit /b 1

:old_node
echo My Memory requires Node.js 18 or newer. Update Node.js and try again.
pause
exit /b 1