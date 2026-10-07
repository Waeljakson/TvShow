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

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] npm was not found.
  echo Reinstall Node.js and enable Add to PATH.
  echo.
  pause
  exit /b 1
)

echo Checking TvShow dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed.
  echo Check your Internet connection and try again.
  echo.
  pause
  exit /b 1
)

if not exist "D:\TvShow\Media" (
  echo Creating media folder: D:\TvShow\Media
  mkdir "D:\TvShow\Media"
)

if not exist agent-config.json (
  echo.
  echo ==========================================
  echo First-time TvShow setup
  echo Public server: https://tvshow-ck1t.onrender.com
  echo Media folder: D:\TvShow\Media
  echo ==========================================
  echo.
  set /p "TVKEY=Paste Agent Key: "
  if not defined TVKEY (
    echo Agent Key is required.
    pause
    exit /b 1
  )

  set "MEDIADIR=D:\TvShow\Media"
  node -e "const fs=require('fs'); const o={serverUrl:'https://tvshow-ck1t.onrender.com',agentKey:process.env.TVKEY,mediaDir:process.env.MEDIADIR,imageDuration:10,order:[],imageDurations:{},reconnectSeconds:5}; fs.writeFileSync('agent-config.json',JSON.stringify(o,null,2),'utf8');"
  if errorlevel 1 (
    echo.
    echo [ERROR] Could not create agent-config.json.
    pause
    exit /b 1
  )
)

echo.
echo ==========================================
echo TvShow Laptop Agent
echo Server: https://tvshow-ck1t.onrender.com
echo Media: D:\TvShow\Media
echo Keep this window open while the TV is on.
echo ==========================================
echo.

call npm run agent

echo.
echo TvShow Agent stopped.
pause
