@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Ports are allocated centrally in C:\Claude\PORTS.md (MemoReader: API 4313, dev UI 5182).
rem Default: build the app and serve it from the API port (this is what Tailscale should point at).
rem "start.bat dev": run the API with auto-restart and the Vite dev server with hot reload.
set "API_PORT=4313"
set "WEB_PORT=5182"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=prod"

echo Checking for an existing MemoReader server on ports %API_PORT%/%WEB_PORT%...
for %%R in (%API_PORT% %WEB_PORT%) do (
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%%R " ^| findstr "LISTENING"') do (
        echo Found existing process on port %%R ^(PID %%P^) - stopping it...
        taskkill /F /PID %%P >nul 2>&1
    )
)

rem Child node processes can outlive the cmd window that started them; match them by window title.
taskkill /F /IM node.exe /FI "WINDOWTITLE eq MemoReader*" >nul 2>&1

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

if /i "%MODE%"=="dev" (
    echo Starting MemoReader in dev mode ^(API :%API_PORT%, UI :%WEB_PORT%^)...
    start "MemoReader" /min cmd /c "npm run dev"
    echo Done. Open http://127.0.0.1:%WEB_PORT%
) else (
    echo Building MemoReader...
    call npm run build
    if errorlevel 1 (
        echo Build failed.
        pause
        exit /b 1
    )
    echo Starting MemoReader ^(http://127.0.0.1:%API_PORT%^)...
    start "MemoReader" /min cmd /c "npm start"
    echo Done. Open http://127.0.0.1:%API_PORT%
)

pause
