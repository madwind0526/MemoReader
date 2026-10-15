@echo off
setlocal
schtasks /Delete /F /TN "MemoReader"
if errorlevel 1 (
    echo No MemoReader scheduled task was found.
    exit /b 0
)
echo Done. MemoReader will no longer start at logon.
