param(
  [int]$IntervalMinutes = 5,
  [switch]$RunNow,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $dir 'monitor.mjs'
$taskName = 'LeinaInviteWatch'

if ($Status) {
  $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "Task '$taskName' is NOT registered."; exit 1 }
  $i = Get-ScheduledTaskInfo -TaskName $taskName
  Write-Host "Task      : $($t.TaskName)"
  Write-Host "State     : $($t.State)"
  Write-Host "LastRun   : $($i.LastRunTime)  Result=$($i.LastTaskResult)"
  Write-Host "NextRun   : $($i.NextRunTime)"
  Write-Host "Action    : $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
  $rep = $t.Triggers | Where-Object { $_.Repetition } | Select-Object -First 1
  if ($rep) {
    Write-Host "Repeat    : every $($rep.Repetition.Interval)  for $($rep.Repetition.Duration)"
  } else {
    Write-Host "Repeat    : (no repetition trigger found - alerts would only fire at logon!)"
  }
  exit 0
}

if (-not (Test-Path $entry)) { throw "monitor.mjs not found next to this script: $entry" }

# --- 1) verify node is resolvable ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "node.exe not found in PATH. Install Node.js or add it to PATH first." }
Write-Host "node      : $($nodeCmd.Source)"
Write-Host "entry     : $entry"

# --- 2) sanity: run once in the foreground so failures are visible now, not silently later ---
Write-Host "`n[1/3] Foreground sanity run..."
& $nodeCmd.Source $entry --once
if ($LASTEXITCODE -ne 0) { throw "monitor.mjs --once exited with $LASTEXITCODE - fix that before scheduling." }

# --- 3) register the scheduled task ---
$logDir = Join-Path $dir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$day = Get-Date -Format 'yyyyMM'

$psArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ' +
  '"' +
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
  '$OutputEncoding=[Text.Encoding]::UTF8; ' +
  '& ''' + $nodeCmd.Source + ''' ''' + $entry + ''' --once ' +
  '*>&1 | Out-File -FilePath ''' + (Join-Path $logDir ("monitor-$day.log")) + ''' -Append -Encoding utf8' +
  '"'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $dir

# Two triggers: at logon, plus a repeating one.
# Do NOT set Repetition.Duration: an empty duration already means "repeat forever",
# while any explicit value is rejected by the Task Scheduler XML validator
# (verified: [TimeSpan]::MaxValue, [TimeSpan]::Zero and even a plain integer all fail
# with HRESULT 0x80041318). Omitting it yields a real NextRunTime.
$t1 = New-ScheduledTaskTrigger -AtLogOn
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$user = "$env:USERDOMAIN\$env:USERNAME"

Write-Host "`n[2/3] Registering scheduled task '$taskName' (every $IntervalMinutes min, user $user)..."
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "  existing task found - replacing it."
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($t1, $t2) `
  -Settings $settings -Description 'Watch the Leina (ODYSSEIA) Discord invite and alert when joining opens.' `
  -User $user | Out-Null

# --- 4) verify it is really registered, with the exact command we intended ---
Write-Host "`n[3/3] Verifying registration..."
$t = Get-ScheduledTask -TaskName $taskName
if (-not $t) { throw "Registration reported success but the task is missing." }
$i = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "  State   : $($t.State)"
Write-Host "  NextRun : $($i.NextRunTime)"
Write-Host "  Logs    : $logDir"

if ($RunNow) {
  Write-Host "`nTriggering a run now..."
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 12
  $i = Get-ScheduledTaskInfo -TaskName $taskName
  Write-Host "  LastRunTime   : $($i.LastRunTime)"
  Write-Host "  LastTaskResult: $($i.LastTaskResult)  (0 = success)"
}

Write-Host "`nDone. Commands:"
Write-Host "  powershell -File install-task.ps1 -Status     # check state / last result"
Write-Host "  powershell -File install-task.ps1 -RunNow     # re-register and fire once"
Write-Host "  Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
