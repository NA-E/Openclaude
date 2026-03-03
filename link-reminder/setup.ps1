# Link Reminder Setup Script
# Registers two Windows Task Scheduler tasks for the current user.
# Run this once from the link-reminder directory:
#   cd path\to\link-reminder
#   .\setup.ps1
#
# No admin rights required (tasks run as current user).

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = (Get-Location).Path
}

# Resolve python paths
$pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue)?.Source
$python  = (Get-Command python.exe  -ErrorAction SilentlyContinue)?.Source

if (-not $python) {
    Write-Error "python.exe not found in PATH. Install Python 3.11+ and ensure it's on PATH."
    exit 1
}
if (-not $pythonw) {
    # pythonw.exe lives next to python.exe
    $pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
    if (-not (Test-Path $pythonw)) {
        Write-Warning "pythonw.exe not found; using python.exe for the server (a console window may flash)."
        $pythonw = $python
    }
}

$serverScript = Join-Path $scriptDir 'server.py'
$checkScript  = Join-Path $scriptDir 'check.py'

# ── Task 1: Server (starts at logon, runs silently) ──────────────────────────
$serverAction  = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$serverScript`"" -WorkingDirectory $scriptDir
$serverTrigger = New-ScheduledTaskTrigger -AtLogOn
$serverSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName 'LinkReminderServer' `
    -Action $serverAction `
    -Trigger $serverTrigger `
    -Settings $serverSettings `
    -Description 'Link Reminder: web server (localhost:3000)' `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host '[OK] LinkReminderServer task registered (runs at logon).'

# ── Task 2: Check (every 5 minutes, indefinitely) ────────────────────────────
$checkAction  = New-ScheduledTaskAction -Execute $python -Argument "`"$checkScript`"" -WorkingDirectory $scriptDir

# Trigger: daily starting now, repeat every 5 min for 1 day (Task Scheduler loops it)
$checkTrigger = New-ScheduledTaskTrigger -Daily -At (Get-Date)
$checkTrigger.Repetition = New-Object Microsoft.Management.Infrastructure.CimInstance 'MSFT_TaskRepetitionPattern', 'Root/Microsoft/Windows/TaskScheduler'
$checkTrigger.Repetition.Interval = 'PT5M'
$checkTrigger.Repetition.Duration = 'P1D'
$checkTrigger.Repetition.StopAtDurationEnd = $false

$checkSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName 'LinkReminderCheck' `
    -Action $checkAction `
    -Trigger $checkTrigger `
    -Settings $checkSettings `
    -Description 'Link Reminder: checks every 5 min for user presence and pending reminders' `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host '[OK] LinkReminderCheck task registered (runs every 5 minutes).'
Write-Host ''
Write-Host 'Setup complete. Reboot or log off/on to activate the server task.'
Write-Host 'Open http://localhost:3000 in your browser to save reminders.'
