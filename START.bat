@echo off
REM ============================================================
REM  Goethe Fleet Commander - Launcher
REM  Double-click to start the server, then open the dashboard.
REM ============================================================
title Goethe Fleet Commander
color 0A

REM --- Check Node.js ---
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [X] Node.js is not installed. Run SETUP.bat first.
    pause
    exit /b 1
)

REM --- Make sure dependencies exist ---
if not exist "node_modules" (
    echo  Dependencies missing - running setup first...
    call npm install
)

REM --- Free port 3000 if an old server is still running ---
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>nul

echo.
echo  ============================================================
echo    Starting Goethe Fleet Commander...
echo    Dashboard will be at:  http://localhost:3000
echo    (Opening your browser automatically in a moment)
echo    Press Ctrl + C in this window to STOP the server.
echo  ============================================================
echo.

REM --- Open the dashboard in the default browser after a short delay ---
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"

REM --- Run the server (keeps this window open) ---
node server.js

echo.
echo  Server stopped.
pause
