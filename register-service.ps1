# Register OpenClaude Gateway as a Windows Task Scheduler task
# Runs on user logon and restarts on failure

$TaskName = "OpenClaude-Gateway"
$WorkDir = "E:\1.Claude Code\Openclaude"
$BatPath = "$WorkDir\start-openclaude.bat"
$LogPath = "$WorkDir\openclaude-gateway.log"

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task: $TaskName"
}

# Action: run the bat file, redirect output to log
$Action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$BatPath`" > `"$LogPath`" 2>&1" `
    -WorkingDirectory $WorkDir

# Trigger: at user logon
$Trigger = New-ScheduledTaskTrigger -AtLogOn

# Settings: restart on failure, don't stop on idle, run indefinitely
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -StartWhenAvailable

# Register the task (runs as current user, no password needed for interactive logon trigger)
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "OpenClaude Gateway - 24/7 AI assistant via Telegram" `
    -RunLevel Limited

Write-Host ""
Write-Host "Task '$TaskName' registered successfully."
Write-Host "  Trigger: At user logon"
Write-Host "  Action:  $BatPath"
Write-Host "  Log:     $LogPath"
Write-Host ""
Write-Host "To start now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "To check:      Get-ScheduledTask -TaskName '$TaskName' | Select State"
Write-Host "To remove:     Unregister-ScheduledTask -TaskName '$TaskName'"
