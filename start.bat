@echo off
setlocal EnableExtensions DisableDelayedExpansion
title TvShow Laptop Agent
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed.
  echo Install Node.js 20 or newer from https://nodejs.org/
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
    pause
    exit /b 1
  )
)

if not exist agent-config.json (
  echo.
  echo ==========================================
  echo First-time TvShow setup
  echo Public server: https://tvshow-ck1t.onrender.com
  echo ==========================================
  echo.
  set /p "TVKEY=Paste Agent Key: "
  if "%TVKEY%"=="" (
    echo Agent Key is required.
    pause
    exit /b 1
  )
  set /p "MEDIADIR=Media folder path [D:\TvShow\Media]: "
  if "%MEDIADIR%"=="" set "MEDIADIR=D:\TvShow\Media"

  powershell -NoProfile -ExecutionPolicy Bypass -Command "$o=[ordered]@{serverUrl='https://tvshow-ck1t.onrender.com';agentKey=$env:TVKEY;mediaDir=$env:MEDIADIR;imageDuration=10;order=@();imageDurations=@{};reconnectSeconds=5}; $o | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 'agent-config.json'" 2>nul
  if errorlevel 1 (
    echo.
    echo Could not create agent-config.json automatically.
    echo Creating the template instead.
    copy /y agent-config.example.json agent-config.json >nul
    start "" notepad "%~dp0agent-config.json"
    pause
    exit /b 1
  )
)

echo.
echo ==========================================
echo TvShow Laptop Agent
echo Server: https://tvshow-ck1t.onrender.com
echo Keep this window open while the TV is on.
echo ==========================================
echo.
call npm run agent

echo.
echo TvShow Agent stopped.
pause
