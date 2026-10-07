@echo off
setlocal
title TvShow Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed or is not available in PATH.
  echo Install Node.js 20 or newer, then run this file again.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] npm was not found.
  echo Reinstall Node.js and make sure "Add to PATH" is enabled.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing TvShow dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo Check the Internet connection, then run start.bat again.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo ==========================================
echo TvShow is starting...
echo Admin:   http://localhost:3000/admin
echo Display: http://localhost:3000/display
echo Default PIN: 2468
echo ==========================================
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start "" "http://localhost:3000/admin""

call npm start

echo.
echo TvShow server stopped.
pause
