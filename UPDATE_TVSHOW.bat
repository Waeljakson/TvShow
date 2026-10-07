@echo off
setlocal EnableExtensions
title TvShow Update
set "APPDIR=%USERPROFILE%\TvShowAgent"
set "ZIPFILE=%TEMP%\tvshow-main.zip"
set "EXTRACTDIR=%TEMP%\tvshow-update"

if not exist "%APPDIR%\agent-config.json" (
  echo.
  echo [ERROR] TvShow Agent is not installed in:
  echo %APPDIR%
  echo Run the installer first.
  echo.
  pause
  exit /b 1
)

echo Updating TvShow Agent while preserving your local configuration...

powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing 'https://github.com/Waeljakson/TvShow/archive/refs/heads/main.zip' -OutFile '%ZIPFILE%'"
if errorlevel 1 (
  echo [ERROR] Could not download the latest TvShow version.
  pause
  exit /b 1
)

if exist "%EXTRACTDIR%" rmdir /s /q "%EXTRACTDIR%"
mkdir "%EXTRACTDIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIPFILE%' -DestinationPath '%EXTRACTDIR%' -Force"
if errorlevel 1 (
  echo [ERROR] Could not extract the update.
  pause
  exit /b 1
)

copy /y "%EXTRACTDIR%\TvShow-main\agent.js" "%APPDIR%\agent.js" >nul
copy /y "%EXTRACTDIR%\TvShow-main\package.json" "%APPDIR%\package.json" >nul

cd /d "%APPDIR%"
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
echo TvShow Agent updated successfully.
echo Starting Agent...
echo.
call npm run agent

pause
