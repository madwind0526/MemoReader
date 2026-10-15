@echo off
setlocal
rem Registers a scheduled task (current user only, no admin rights needed) that runs start.bat when
rem you log on, so MemoReader is already running, and organizing the memos that piled up, whenever
rem the PC is switched on. Remove it again with scripts\autostart-remove.bat.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart-install.ps1"
if errorlevel 1 (
    echo Could not create the scheduled task.
    exit /b 1
)
echo Done. MemoReader will start 30 seconds after you log on.
