@echo off
REM ============================================================
REM  Goethe Fleet Commander - One-time Setup
REM  Double-click this file to install everything needed.
REM ============================================================
title Goethe Fleet Commander - Setup
color 0B

echo.
echo  ============================================================
echo    Goethe Fleet Commander  -  SETUP
echo  ============================================================
echo.

REM --- Check Node.js is installed ---
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [X] Node.js is NOT installed.
    echo.
    echo      Please install Node.js LTS first:
    echo      https://nodejs.org
    echo.
    echo      After installing, close this window and run SETUP again.
    echo.
    pause
    exit /b 1
)

echo  [OK] Node.js found:
node --version
echo.

REM --- Install dependencies ---
echo  Installing dependencies (this may take a minute)...
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo  [X] npm install failed. Check your internet connection and try again.
    echo.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo    Setup complete!
echo.
echo    To start the Commander, double-click:  START.bat
echo    Then open:  http://localhost:3000
echo  ============================================================
echo.
pause
