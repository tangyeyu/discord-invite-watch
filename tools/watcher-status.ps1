# =====================================================================
#  Watchdog status check - one key, read-only
#
#  Answers three questions at a glance:
#    1) Is the watcher running (and how many instances)?
#    2) Is the proxy up (without it nothing can be detected)?
#    3) Is "auto open browser on open" enabled?
#    4) What did the last poll find, and when?
#
#  Read-only: starts nothing, changes nothing, sends nothing.
#  ASCII-only body on purpose (PS 5.1 parses BOM-less UTF-8 as GBK and
#  then mangles quotes -> "Missing type name after '['" style errors).
#  Chinese output is emitted via -f formatting on literal ASCII keys.
# =====================================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$PROJ = 'C:\Users\luoti\Desktop\dsh\leina-invite-watch'
$PIDFILE = Join-Path $PROJ 'logs\monitor.pid'
$STATE = Join-Path $PROJ 'state.json'
$CONFIG = Join-Path $PROJ 'monitor.config.json'

function Line { Write-Host ('-' * 58) -ForegroundColor DarkGray }
function Title($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan; Line }

$problems = @()

Write-Host ''
Write-Host '  WATCHER STATUS' -ForegroundColor White
Write-Host ("  checked at " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor DarkGray

# ---------------------------------------------------------------- 1. process
Title '[1] Watcher process'

$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'monitor\.mjs' })

if ($procs.Count -eq 0) {
  Write-Host '  [X] not running - nothing is being monitored' -ForegroundColor Red
  $problems += 'watcher not running'
} elseif ($procs.Count -eq 1) {
  $p = $procs[0]
  $pp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  $started = if ($pp) { $pp.StartTime.ToString('MM-dd HH:mm:ss') } else { '?' }
  Write-Host ("  [OK] 1 instance, PID " + $p.ProcessId + " (started " + $started + ")") -ForegroundColor Green
} else {
  Write-Host ("  [!] " + $procs.Count + " instances running - they will fight over state.json") -ForegroundColor Yellow
  foreach ($p in $procs) { Write-Host ("        PID " + $p.ProcessId) -ForegroundColor Yellow }
  $problems += ("duplicate instances: " + $procs.Count)
}

# lock file consistency
if (Test-Path $PIDFILE) {
  $lockPid = (Get-Content $PIDFILE -Raw).Trim()
  $liveIds = @($procs | ForEach-Object { $_.ProcessId })
  if ($liveIds -contains [int]$lockPid) {
    Write-Host ("  [OK] single-instance lock matches (PID " + $lockPid + ")") -ForegroundColor Green
  } else {
    Write-Host ("  [!] lock file says PID " + $lockPid + " but that process is gone") -ForegroundColor Yellow
    $problems += 'stale lock file'
  }
} else {
  Write-Host '  [!] no lock file - duplicate protection is inactive' -ForegroundColor Yellow
  $problems += 'missing lock file'
}

# ---------------------------------------------------------------- 2. proxy
Title '[2] Proxy (required - nothing works without it)'

$proxyUp = $false
if (Get-NetTCPConnection -State Listen -LocalPort 10808 -ErrorAction SilentlyContinue) {
  $proxyUp = $true
  Write-Host '  [OK] 127.0.0.1:10808 is listening' -ForegroundColor Green
} else {
  Write-Host '  [X] 127.0.0.1:10808 is NOT listening' -ForegroundColor Red
  Write-Host '      -> start v2rayN. Without it the watcher skips every poll' -ForegroundColor Yellow
  Write-Host '         and the browser will never auto-open.' -ForegroundColor Yellow
  $problems += 'proxy down'
}

$vp = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'v2ray|xray|sing-box|clash|mihomo' })
if ($vp.Count -gt 0) {
  Write-Host ('  [OK] proxy process: ' + (($vp | ForEach-Object { $_.ProcessName }) -join ', ')) -ForegroundColor Green
} else {
  Write-Host '  [X] no proxy process found' -ForegroundColor Red
}

# ---------------------------------------------------------------- 3. config
Title '[3] Auto-open browser on "opened"'

if (Test-Path $CONFIG) {
  $cfg = Get-Content $CONFIG -Raw -Encoding UTF8 | ConvertFrom-Json
  $auto = $cfg.notify.autoOpenBrowser
  if ($auto -eq $false) {
    Write-Host '  [!] DISABLED (notify.autoOpenBrowser = false)' -ForegroundColor Yellow
    $problems += 'auto-open disabled'
  } else {
    Write-Host '  [OK] ENABLED (will pop Chrome when the invite reopens)' -ForegroundColor Green
  }
  Write-Host ("        toast=" + $cfg.notify.toast + "  sound=" + $cfg.notify.sound + "  poll=" + $cfg.pollSeconds + "s") -ForegroundColor DarkGray
  Write-Host ("        inviteCode=" + $cfg.inviteCode + "  cooldown=" + $cfg.alertCooldownMinutes + "min") -ForegroundColor DarkGray
} else {
  Write-Host '  [X] monitor.config.json missing' -ForegroundColor Red
  $problems += 'config missing'
}

# ---------------------------------------------------------------- 4. last poll
Title '[4] Last poll result'

if (Test-Path $STATE) {
  $st = Get-Content $STATE -Raw -Encoding UTF8 | ConvertFrom-Json
  $mtime = (Get-Item $STATE).LastWriteTime
  $ageMin = [math]::Round(((Get-Date) - $mtime).TotalMinutes, 1)
  Write-Host ("  state.json written " + $ageMin + " min ago (" + $mtime.ToString('MM-dd HH:mm:ss') + ")") -ForegroundColor DarkGray

  if ($proxyUp -and $ageMin -gt 5) {
    Write-Host ("  [!] stale: last write " + $ageMin + " min ago, expected <= pollSeconds") -ForegroundColor Yellow
    $problems += 'state not updating'
  }

  foreach ($k in $st.watched.PSObject.Properties.Name) {
    $w = $st.watched.$k
    $at = '?'
    if ($w.at) {
      try { $at = ([datetime]$w.at).ToLocalTime().ToString('MM-dd HH:mm:ss') } catch { $at = '?' }
    }
    Write-Host ("  " + $k.PadRight(14) + " ok=" + $w.ok + "  members=" + $w.memberCount + "  online=" + $w.onlineCount) -ForegroundColor Gray
    Write-Host ("                 last SUCCESS at " + $at) -ForegroundColor DarkGray

    # 取数失败时 monitor 会保留上次成功的快照，并追加 lastError / lastErrorAt。
    # 只看 at 会误以为"轮询正常"（文件在写、但数据是旧的），所以这里把失败原因显示出来。
    # 但代理是间歇性不稳定的，历史错误≠现在不通 —— 第 5 步会做实时验证，所以这里不直接判为故障。
    if ($w.lastError -or $w.lastErrorAt) {
      $eat = '?'
      if ($w.lastErrorAt) {
        try { $eat = ([datetime]$w.lastErrorAt).ToLocalTime().ToString('MM-dd HH:mm:ss') } catch { $eat = '?' }
      }
      Write-Host ("                 LAST ERROR at " + $eat + " : " + $w.lastError) -ForegroundColor Yellow
    }
  }

  $logCount = @($st.log).Count
  Write-Host ("  event log entries: " + $logCount) -ForegroundColor DarkGray
  if ($st.lastAlertAt) {
    $la = '?'
    try { $la = ([datetime]$st.lastAlertAt).ToLocalTime().ToString('MM-dd HH:mm:ss') } catch { $la = '?' }
    Write-Host ("  last alert sent at: " + $la) -ForegroundColor DarkGray
  } else {
    Write-Host '  last alert: (none since this state file was created)' -ForegroundColor DarkGray
  }
} else {
  Write-Host '  [X] state.json missing' -ForegroundColor Red
  $problems += 'state missing'
}

# ---------------------------------------------------------------- 5. live test
# 历史错误不代表现在不通（代理是间歇性不稳定的），所以这里做一次实时取数验证。
Title '[5] Live test (can it reach Discord RIGHT NOW)'

if (-not $proxyUp) {
  Write-Host '  [skip] proxy is down, live test would fail for an obvious reason' -ForegroundColor DarkGray
} else {
  Write-Host '  querying Discord, please wait (up to 45s)...' -ForegroundColor DarkGray
  $env:HTTPS_PROXY = 'http://127.0.0.1:10808'
  $env:HTTP_PROXY = 'http://127.0.0.1:10808'
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  # 为什么落到文件而不是 Receive-Job：
  # monitor 的 log() 走 console.error（stderr），经 PowerShell 作业传递时编码可能被转换，
  # 导致中文正则（成员=）匹配失败 —— 实测出现过「reachable now - members=?」。
  # 写文件再按 UTF8 读回来最稳。
  $probeOut = Join-Path $env:TEMP ('watcher-live-' + [guid]::NewGuid().ToString('N') + '.txt')
  & cmd /c "cd /d `"$PROJ`" && node monitor.mjs --check HWNkueX34q > `"$probeOut`" 2>&1"
  $liveOut = ''
  if (Test-Path $probeOut) {
    $liveOut = Get-Content $probeOut -Raw -Encoding UTF8
    Remove-Item $probeOut -Force -ErrorAction SilentlyContinue
  }
  $ErrorActionPreference = $prevEap

  if ($liveOut -match 'OK\s+HWNkueX34q') {
    $mm = [regex]::Match($liveOut, '成员=(\d+)')
    $mv = if ($mm.Success) { $mm.Groups[1].Value } else { '?' }
    Write-Host ("  [OK] reachable now - members=" + $mv) -ForegroundColor Green
  } elseif ($liveOut -match 'FAIL') {
    Write-Host '  [X] FAILED right now - proxy is up but Discord is unreachable' -ForegroundColor Red
    Write-Host '      -> the proxy node may be dead; try switching node in v2rayN' -ForegroundColor Yellow
    $problems += 'live test failed'
  } else {
    Write-Host '  [?] no clear result (timeout or unexpected output)' -ForegroundColor Yellow
    $problems += 'live test inconclusive'
  }
}

# ---------------------------------------------------------------- summary
Title 'SUMMARY'
if ($problems.Count -eq 0) {
  Write-Host '  All good. Waiting for the invite to reopen.' -ForegroundColor Green
  Write-Host '  When it does: Chrome pops up automatically + WeChat push arrives.' -ForegroundColor Green
} else {
  Write-Host '  Issues found:' -ForegroundColor Yellow
  foreach ($p in $problems) { Write-Host ('    - ' + $p) -ForegroundColor Yellow }
  if ($problems -contains 'proxy down') {
    Write-Host '' 
    Write-Host '  Most likely fix: start v2rayN, then run this check again.' -ForegroundColor Cyan
  }
}
Write-Host ''
Read-Host '  Press Enter to close'
