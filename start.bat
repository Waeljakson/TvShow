@echo off
setlocal
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
  copy /y agent-config.example.json agent-config.json >nul
  echo.
  echo TvShow created agent-config.json
  echo Edit serverUrl and agentKey, then save the file.
  echo.
  start "" notepad "%~dp0agent-config.json"
  pause
  exit /b 0
)

echo.
echo Starting TvShow Laptop Agent...
echo Keep this window open while the TV is using media from this laptop.
echo.
call npm run agent

echo.
echo TvShow Agent stopped.
pause
