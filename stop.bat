@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Ports this app owns (see C:\Claude\PORTS.md).
echo Stopping MemoReader...

for %%R in (4313 5182) do (
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%%R " ^| findstr "LISTENING"') do (
        echo Stopping process on port %%R ^(PID %%P^)...
        taskkill /F /PID %%P >nul 2>&1
    )
)

rem Child node processes can outlive the cmd window that started them; match them by window title.
taskkill /F /IM node.exe /FI "WINDOWTITLE eq MemoReader*" >nul 2>&1

echo Done.
pause
