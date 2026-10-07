@echo off
title TvShow Server
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
echo TvShow is starting...
echo Admin:   http://localhost:3000/admin
echo Display: http://localhost:3000/display
echo.
call npm start
pause
