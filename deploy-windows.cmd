@echo off
rem Double-click me (Windows) to put SnapVote online.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is needed ^(free^). Opening https://nodejs.org - install the LTS version,
  echo   then double-click this file again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
node scripts\deploy.mjs %*
echo.
pause
