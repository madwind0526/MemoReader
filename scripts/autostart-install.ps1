# Registers a per-user scheduled task that runs start.bat 30 seconds after you log on.
# The schtasks /SC ONLOGON form is "all users" and needs admin rights; this form does not.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$root\start.bat`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = "PT30S"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "MemoReader" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts MemoReader at logon" -Force | Out-Null
Write-Output "Registered task MemoReader for $user (runs 30 seconds after logon)."
