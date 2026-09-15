#Requires -Version 5.1
<#
=====================================================================
  类脑社区「是否开启」一键检测
  
  双击 一键检测.cmd 即可运行；也可手动执行：
      powershell -NoProfile -ExecutionPolicy Bypass -File .\check-status.ps1

  它做三件事：
    [1] 社区状态：探测邀请接口，对比基线成员数判断是否恢复开放
    [2] 本机守望者：计划任务是否存在/启用/上次结果
    [3] 云端哨兵：Cloudflare Worker（本账号已知不可用，会显式提示）

  输出：控制台彩色结果 + logs\status-YYYYMM.log + 结束弹窗汇总
=====================================================================

  需要用户确认/替换的配置项 —— 全部集中在下面这个区域，
  其它地方不用改。
#>

# ============================ 配置区（可改） ============================

# 要检测的邀请码。类脑：HWNkueX34q（另有短链 odysseia，作为交叉验证）
$InviteCode = 'HWNkueX34q'
$AltCode    = 'odysseia'

# 期望的服务器名（用于确认探测到的确实是类脑，防止邀请码被回收改指别处）
$ExpectGuildName = '类脑'

# 成员数上涨多少算「已开启」。暂停期间实测冻结 => 1 即可，不必调大
$Threshold = 1

# 本机计划任务名（install-task.ps1 装的）
$TaskName = 'LeinaInviteWatch'

# Cloudflare Worker 名与其 workers.dev 子域
# ⚠ 子域是「按账号」的：换 Cloudflare 账号后必须同步改下面的 WorkerSubdomain，
#   否则检测会连到旧账号的地址。
# 你的子域可在 Cloudflare 控制台 Workers & Pages 页面看到。
$WorkerName = 'leina-invite-watch'
$WorkerSubdomain = 'YOUR_SUBDOMAIN'   # ← 改成你自己的 workers.dev 子域

# 本地代理；留空则用 Node 自动探测（读 Windows 系统代理）
$ProxyUrl = 'http://127.0.0.1:10808'

# 是否结束时弹窗（双击运行时建议 true；加 -NoPopup 可关闭，便于自动化测试）
$ShowPopup = $true
if ($args -contains '-NoPopup') { $ShowPopup = $false }

# ========================== 配置区结束 ==========================


$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
Set-Location -Path $Root

# 控制台 UTF-8，避免中文乱码（要在任何输出之前设置）
try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $OutputEncoding = [Text.Encoding]::UTF8
} catch { }

$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir ("status-" + (Get-Date -Format 'yyyyMM') + ".log")
# 无 BOM 的 UTF-8 写入器。
# 不能用 Add-Content -Encoding utf8 —— PS 5.1 会给它加 BOM（实测），
# 带 BOM 的日志被 node / git diff 等工具读取时容易出问题。
# （.ps1 脚本文件本身带 BOM 是另一回事：PS 5.1 靠 BOM 识别 UTF-8。）
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$StateFile = Join-Path $Root 'state.json'
$StartTime = Get-Date
$script:Warnings = @()
$script:Summary = @()

function W($msg, $color = 'Gray') {
  Write-Host $msg -ForegroundColor $color
  [System.IO.File]::AppendAllText($LogFile, $msg + [Environment]::NewLine, $script:Utf8NoBom)
}
function Head($t) { W ''; W ("=" * 62) 'DarkCyan'; W "  $t" 'Cyan'; W ("=" * 62) 'DarkCyan' }

W ("检测时间：" + $StartTime.ToString('yyyy-MM-dd HH:mm:ss'))
W ("工作目录：" + $Root)

# ---------------------------------------------------------------- Node
Head '0. 前置检查'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  W '  [X] 未找到 node，无法执行检测。请先安装 Node.js。' 'Red'
  $script:Summary += '环境：缺少 node，检测未执行'
  if ($ShowPopup) { [void][System.Windows.Forms.MessageBox]::Show('未找到 node，无法检测。', '类脑检测') }
  exit 1
}
W ("  [OK] node " + (& node --version)) 'Green'

$MonitorScript = Join-Path $Root 'monitor.mjs'
if (-not (Test-Path $MonitorScript)) {
  W '  [X] 找不到 monitor.mjs，请在项目目录内运行本脚本。' 'Red'
  exit 1
}
W '  [OK] 找到 monitor.mjs' 'Green'

# 代理探测：设置环境变量让 Node 走 CONNECT 隧道
if ($ProxyUrl) { $env:HTTPS_PROXY = $ProxyUrl; $env:HTTP_PROXY = $ProxyUrl }
$proxyOk = $false
if ($ProxyUrl) {
  $p = [regex]::Match($ProxyUrl, ':(\d+)')
  if ($p.Success) {
    $live = Get-NetTCPConnection -State Listen -LocalPort ([int]$p.Groups[1].Value) -ErrorAction SilentlyContinue
    if ($live) { W '  [OK] 本地代理端口在监听' 'Green'; $proxyOk = $true }
    else { W '  [!] 本地代理端口未监听 —— 检测可能失败' 'Yellow'; $script:Warnings += '代理端口未监听' }
  }
}

# ------------------------------------------------- [1] 社区是否开启
Head '1. 社区是否开启'

# 读基线：state.json 里保存着上一轮的成员数
$baseline = $null
if (Test-Path $StateFile) {
  try {
    $st = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($st.watched -and $st.watched.$InviteCode) { $baseline = $st.watched.$InviteCode.memberCount }
  } catch { W '  [!] state.json 解析失败，本轮只建立基线' 'Yellow' }
}
if ($null -eq $baseline) { W '  [i] 尚无基线，本轮将建立基线（首次运行属正常）' 'DarkGray' }
else { W ("  [i] 基线成员数：" + $baseline) 'DarkGray' }

# 探测：调用 monitor.mjs 的 --check 子命令（复用已实测的逻辑，含代理与限流处理）
$probe = & node $MonitorScript --check $InviteCode $AltCode 2>&1 | Out-String
$probeLines = $probe -split "`r?`n" | Where-Object { $_.Trim() }
$probeLines | ForEach-Object { W ("     " + $_) 'DarkGray' }

# 解析探测结果：抓 "OK   <code>   <服务器名>   成员=N ..."
$memberCount = $null
$guildName = $null
$resolved = $false
foreach ($line in $probeLines) {
  $m = [regex]::Match($line, 'OK\s+' + [regex]::Escape($InviteCode) + '\s+(\S+)\s+成员=(\d+)')
  if ($m.Success) {
    $guildName = $m.Groups[1].Value
    $memberCount = [int]$m.Groups[2].Value
    $resolved = $true
    break
  }
}
# 兜底：短链的结果也算（主码被限流时可能只有它成功）
if (-not $resolved) {
  foreach ($line in $probeLines) {
    $m = [regex]::Match($line, 'OK\s+' + [regex]::Escape($AltCode) + '\s+(\S+)\s+成员=(\d+)')
    if ($m.Success) { $guildName = $m.Groups[1].Value; $memberCount = [int]$m.Groups[2].Value; $resolved = $true; break }
  }
}

$verdict = ''
if (-not $resolved) {
  # 探测不到：可能是网络/代理挂了，也可能是限流。不能断言"未开启"
  $verdict = 'UNKNOWN'
  W '  [!] 探测失败：无法读取邀请信息（代理或网络问题？）' 'Yellow'
  W '      这不代表社区关闭 —— 请先确认代理在看下面第 2 项' 'Yellow'
  $script:Warnings += '邀请探测失败（网络/代理）'
  $script:Summary += '社区状态：无法判定（探测失败）'
}
elseif ($guildName -notlike "*$ExpectGuildName*") {
  # 邀请码可能被回收改指到别的服务器了
  $verdict = 'UNKNOWN'
  W ("  [!] 探测到服务器是「" + $guildName + "」，与预期的「" + $ExpectGuildName + "」不符" ) 'Yellow'
  W '      可能邀请码已被回收/改指，请人工确认' 'Yellow'
  $script:Warnings += '邀请指向的服务器名不符'
  $script:Summary += "社区状态：异常（指向 $guildName）"
}
elseif ($null -eq $baseline) {
  $verdict = 'BASELINE'
  W ("  [i] 已建立基线：成员数 = " + $memberCount) 'Cyan'
  $script:Summary += "社区状态：已建基线（$memberCount 人），下轮才能判断"
}
else {
  $delta = $memberCount - $baseline
  if ($delta -ge $Threshold) {
    $verdict = 'OPEN'
  } elseif ($delta -eq 0) {
    $verdict = 'PAUSED'
  } else {
    $verdict = 'SHRINK'
  }
}

# 根据判定输出结论
switch ($verdict) {
  'OPEN' {
    W ''
    W '  ****************************************************' 'Green'
    W ("  **  社区可能已开启！成员数 +" + ($memberCount - $baseline) + "（" + $baseline + " -> " + $memberCount + "）") 'Green'
    W '  **  立刻点：https://discord.com/invite/HWNkueX34q' 'Green'
    W ("  **  短链：  https://discord.gg/" + $AltCode) 'Green'
    W '  ****************************************************' 'Green'
    $script:Summary += "社区状态：★ 疑似已开启（成员 +$($memberCount - $baseline)）"
    if ($ShowPopup) {
      Add-Type -AssemblyName System.Windows.Forms
      [void][System.Windows.Forms.MessageBox]::Show(
        "社区可能已开启！`n`n成员数 +$($memberCount - $baseline)（$baseline -> $memberCount）`n`n立刻加入：`nhttps://discord.com/invite/HWNkueX34q",
        '类脑已开启？', 'OK', 'Information')
    }
  }
  'PAUSED' {
    W ''
    W ("  [未开启] 成员数仍冻结在 " + $memberCount + "（与基线相同）") 'Yellow'
    if ($baseline) { W ("           —— 与暂停期间的表现一致，邀请仍处于 paused") 'DarkGray' }
    $script:Summary += "社区状态：仍关闭（成员 $memberCount 未变）"
  }
  'SHRINK' {
    W ''
    W ("  [未开启] 成员数下降 " + ($memberCount - $baseline) + "（有人退群），不代表开放") 'Yellow'
    $script:Summary += "社区状态：仍关闭（成员下降）"
  }
}

# 更新基线（用 monitor.mjs 的 --once，它会正确处理状态推进与阈值逻辑）
if ($verdict -in @('OPEN', 'PAUSED', 'SHRINK', 'BASELINE')) {
  & node $MonitorScript --once 2>&1 | Out-Null
}

# ------------------------------------------------- [2] 本机守望者
Head '2. 本机守望者（计划任务）'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  W ("  [!] 计划任务 " + $TaskName + " 不存在 —— 不会自动监测") 'Yellow'
  W '      安装： powershell -File .\install-task.ps1' 'DarkGray'
  $script:Warnings += '计划任务未安装'
  $script:Summary += '本机守望者：未安装'
} else {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $enabled = $task.State -ne 'Disabled'
  W ("  任务名   : " + $task.TaskName)
  W ("  状态     : " + $task.State + $(if ($enabled) { '  (正在工作)' } else { '  (已停止，不会触发)' })) $(if ($enabled) { 'Green' } else { 'Yellow' })
  W ("  上次运行 : " + $info.LastRunTime + "   结果=" + $info.LastTaskResult + $(if ($info.LastTaskResult -eq 0) { ' (成功)' } else { '' }))
  W ("  下次运行 : " + $info.NextRunTime)
  if (-not $enabled) { $script:Warnings += '计划任务已停止'; $script:Summary += '本机守望者：已停止' }
  elseif ($info.LastTaskResult -ne 0) { $script:Warnings += "计划任务上次结果异常($($info.LastTaskResult))"; $script:Summary += '本机守望者：上次运行异常' }
  else { $script:Summary += '本机守望者：正常' }
}

# ------------------------------------------------- [3] 云端哨兵
Head '3. 云端哨兵（Cloudflare Worker）'
$cfDir = Join-Path $Root 'cloudflare-worker'
$wrangler = Join-Path $Root 'node_modules\wrangler'
if (-not (Test-Path $wrangler)) {
  W '  [i] 未安装 wrangler，跳过云端检测' 'DarkGray'
  $script:Summary += '云端哨兵：未部署'
} else {
  Push-Location $cfDir
  $whoOut = & npx wrangler whoami 2>&1 | Out-String
  $loggedIn = -not ($whoOut -match '(?i)not authenticated')
  if (-not $loggedIn) {
    W '  [i] Cloudflare 未登录，跳过云端检测' 'DarkGray'
    $script:Summary += '云端哨兵：未登录'
  } else {
    $url = "https://$WorkerName.$WorkerSubdomain.workers.dev"
    # 注意：不要写 $resp + 事后读 $_ —— 在 if/else 作用域里 $_ 会失效，
    # 实测会打印出无意义的 "HTTP 0"。改成显式捕获异常对象。
    $statusCode = $null
    $respContent = $null

    # ⚠ 必须先用 DoH 拿真实 IP：本机 workers.dev 被 DNS 污染
    #   （实测被解析到 Facebook 的 31.13.67.19），直接用域名请求会 EPROTO 假故障。
    $realIp = $null
    try {
      $doh = Invoke-RestMethod -Uri ("https://cloudflare-dns.com/dns-query?name=" + $WorkerName + "." + $WorkerSubdomain + ".workers.dev&type=A") `
        -Headers @{ Accept = 'application/dns-json' } -TimeoutSec 20 -ErrorAction Stop
      $realIp = ($doh.Answer | Where-Object { $_.type -eq 1 } | Select-Object -First 1).data
    } catch { }
    if ($realIp) { W ("  [i] DoH 解析真实 IP：" + $realIp + "（绕过 DNS 污染）") 'DarkGray' }
    else { W '  [!] DoH 解析失败，将直接按域名请求（可能因污染而失败）' 'DarkGray' }

    try {
      $params = @{ Uri = $url; TimeoutSec = 30; UseBasicParsing = $true; ErrorAction = 'Stop' }
      if ($realIp) { $params.Headers = @{ Host = "$WorkerName.$WorkerSubdomain.workers.dev" } }
      $r = Invoke-WebRequest @params
      $statusCode = [int]$r.StatusCode
      $respContent = $r.Content
      W ("  [OK] Worker 可访问：" + $url + "  (HTTP " + $statusCode + ")") 'Green'
    } catch {
      $ex = $_.Exception
      if ($ex.Response -and $ex.Response.StatusCode) { $statusCode = [int]$ex.Response.StatusCode }
      else { $statusCode = 'NO_RESPONSE' }
      W ("  [X] Worker 不可访问：" + $url) 'Yellow'
      W ("      HTTP " + $statusCode + "   原因：" + $ex.Message) 'DarkGray'
    }

    if ($statusCode -eq 200 -and $respContent) {
      $j = $null
      try { $j = $respContent | ConvertFrom-Json } catch { }
      if ($j) {
        W ("       成员数=" + $j.memberCount + "  事件=" + ($j.events -join ',')) 'DarkGray'
        $script:Summary += ('云端哨兵：正常（成员 ' + $j.memberCount + '）')
      } else {
        W '       响应不是预期的 JSON，可能部署有误' 'Yellow'
        $script:Warnings += 'Worker 响应格式异常'
        $script:Summary += '云端哨兵：响应异常'
      }
    } elseif ($statusCode -eq 'NO_RESPONSE') {
      W '      完全无响应：DNS/代理问题，或 Worker 已被删除' 'DarkGray'
      $script:Warnings += 'Cloudflare Worker 无响应'
      $script:Summary += '云端哨兵：无响应'
    } else {
      if ($statusCode -eq 500) {
        W '      本账号已知问题：workers.dev 返回 error 1101（连最小 Worker 也一样）' 'DarkGray'
        W '      详见 cloudflare-worker\README-cloud.md，或改用 deploy-vps.sh' 'DarkGray'
      }
      $script:Warnings += "Cloudflare 云端哨兵不可用(HTTP $statusCode)"
      $script:Summary += "云端哨兵：不可用（HTTP $statusCode）"
    }
  }
  Pop-Location
}

# ------------------------------------------------- 汇总
Head '检测汇总'
foreach ($s in $script:Summary) { W ("  · " + $s) 'White' }
if ($script:Warnings.Count) {
  W ''
  W '  需要注意：' 'Yellow'
  foreach ($s in $script:Warnings) { W ("    ! " + $s) 'Yellow' }
}
$elapsed = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
W ''
W ("  耗时 " + $elapsed + " 秒    日志：" + $LogFile) 'DarkGray'

if ($ShowPopup) {
  Add-Type -AssemblyName System.Windows.Forms
  $popup = ($script:Summary -join "`n")
  if ($verdict -eq 'OPEN') { $popup = "★ 社区疑似已开启！`n`n" + $popup }
  [void][System.Windows.Forms.MessageBox]::Show($popup, '类脑检测结果', 'OK',
    $(if ($verdict -eq 'OPEN') { 'Information' } else { 'Information' }))
}
