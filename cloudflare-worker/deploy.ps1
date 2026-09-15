# =====================================================================
#  云端哨兵一键部署（Cloudflare Worker 版）
#
#  用法： powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
#
#  它做六件事：
#    [0] 前置检查（wrangler / 代理 / 本地工具）
#    [1] 确保已登录 Cloudflare（未登录则用 Chrome 打开授权页）
#    [2] 复核 KV 命名空间归属（换账号后旧 id 会失效，必须重建）
#    [3] 配置推送通路（可选，回车跳过）
#    [4] 部署 Worker
#    [5] 线上实测（DoH 解析真实 IP，绕开 DNS 污染）
#
#  只有四处需要你本人参与：浏览器点授权、粘贴 webhook、可能要点一次回车、
#  以及首次部署时 Cloudflare 可能要求注册 workers.dev 子域。
#
#  需要用户填写/替换的配置项全部集中在下面「配置区」。
#
#  ⚠ 本文件刻意保存为 UTF-8 带 BOM（全仓库唯一例外），不要去掉：
#    Windows PowerShell 5.1 靠 BOM 识别 UTF-8；缺 BOM 时会按 GBK 解码，
#    中文注释被误解码后会吃掉引号，导致解析失败（实测）。
#    因此 check-encoding.mjs 对本文件报「不应带 BOM」属已知误报。
#
#  ⚠ 本文件的注释里刻意不写方括号：PowerShell 的类型解析器即使面对 # 注释
#    也会对方括号报错（实测）。
# =====================================================================

# ============================ 配置区（可改） ============================

# Worker 名称（wrangler.toml 里的 name 必须一致）
$WorkerName = 'leina-invite-watch'

# KV 绑定名（wrangler.toml 里的 binding）
$KvBinding = 'LEINA_KV'

# 本地代理；wrangler 需要访问 api.cloudflare.com
$ProxyUrl = 'http://127.0.0.1:10808'

# OAuth 回调端口（wrangler 默认 8976）
$CallbackPort = 8976

# ========================== 配置区结束 ==========================


$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# --- 加载原生调用封装（必须最早）---
# deploy.ps1 是独立进程，别的脚本里 dot-source 过的函数在这里不存在。
# 而且 PS 5.1 会把 npx 的 stderr 警告当终止性错误，必须用封装兜住。
. (Join-Path $PSScriptRoot '..\tools\ps-util.ps1')

$env:HTTPS_PROXY = $ProxyUrl
$env:HTTP_PROXY = $ProxyUrl

$TOML = Join-Path $PSScriptRoot 'wrangler.toml'
$LogDir = Join-Path $env:APPDATA 'xdg.config\.wrangler\logs'

function Step($n, $text) { Write-Host "`n===== [$n] $text =====" -ForegroundColor Cyan }
function OK($t)   { Write-Host "  [OK] $t"   -ForegroundColor Green }
function WARN($t) { Write-Host "  [!]  $t"   -ForegroundColor Yellow }
function DIE($t)  { Write-Host "`n  [X] $t"  -ForegroundColor Red; exit 1 }

# 读 wrangler 的 OAuth token（用于直接调 Cloudflare REST API）
function Get-CfToken {
  foreach ($p in @(
      (Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'),
      (Join-Path $env:USERPROFILE '.wrangler\config\default.toml'),
      (Join-Path $env:USERPROFILE '.config\.wrangler\config\default.toml'))) {
    if (Test-Path $p) {
      $t = [regex]::Match((Get-Content $p -Raw -Encoding UTF8), 'oauth_token\s*=\s*"([^"]+)"')
      if ($t.Success) { return $t.Groups[1].Value }
    }
  }
  return $null
}

function Get-CfAccountId($whoamiOutput) {
  $m = [regex]::Match($whoamiOutput, '\b([0-9a-f]{32})\b')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

<#
  判断某个 KV 命名空间是否属于当前账号。
  实测判据（2026-09-15）：
    GET /accounts/{acct}/storage/kv/namespaces/{nsId}/keys
      · 属于本账号        -> HTTP 200
      · 不属于（换账号后）-> HTTP 404
    注意：加 ?limit=1 会被拒绝（HTTP 400），所以不带参数。
  返回 $true / $false / $null（$null = 无法确定，调用方需保守处理）
#>
function Test-KvBelongsToAccount($accountId, $nsId) {
  if (-not $accountId -or -not $nsId) { return $null }
  $token = Get-CfToken
  if (-not $token) { return $null }
  $base = "https://api.cloudflare.com/client/v4/accounts/$accountId/storage/kv/namespaces"
  $hdr = @{ Authorization = "Bearer $token" }

  try {
    Invoke-RestMethod -Uri "$base/$nsId/keys" -Headers $hdr -TimeoutSec 25 -ErrorAction Stop | Out-Null
    return $true
  } catch {
    $code = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $code = [int]$_.Exception.Response.StatusCode
    } elseif ($_.Exception.Message -match '\((\d{3})\)') {
      $code = [int]$Matches[1]
    }
    if ($code -eq 404 -or $code -eq 403) { return $false }
  }

  # 退路：拉全量命名空间列表再确认
  try {
    $list = Invoke-RestMethod -Uri $base -Headers $hdr -TimeoutSec 25 -ErrorAction Stop
    $ids = @($list.result | ForEach-Object { $_.id })
    if ($ids.Count -gt 0) { return ($ids -contains $nsId) }
  } catch { }

  return $null
}

# ---------------------------------------------------------------- 0. 前置
Step 0 '前置检查'
$wranglerEntry = Join-Path $PSScriptRoot '..\node_modules\wrangler\bin\wrangler.js'
if (-not (Test-Path $wranglerEntry)) {
  DIE "找不到 wrangler。请先在项目根目录执行： npm install wrangler --save-dev"
}
OK 'wrangler 已就绪'
if (-not (Test-Path $TOML)) { DIE "找不到 wrangler.toml：$TOML" }
OK 'wrangler.toml 已就绪'

$proxyLive = Get-NetTCPConnection -State Listen -LocalPort 10808 -ErrorAction SilentlyContinue
if ($proxyLive) { OK '本地代理 10808 在监听' }
else { WARN '本地代理 10808 未监听；wrangler 可能连不上 Cloudflare' }

# ---------------------------------------------------------------- 1. 登录
Step 1 'Cloudflare 登录状态'

$who = (Invoke-Native 'npx' @('wrangler', 'whoami')).Output
$loggedIn = $false
if ($who -match '(?i)not authenticated|Please run .{0,20}wrangler login') {
  $loggedIn = $false
} elseif ($who -match '(?i)You are logged in|associated with the email|Account Name|Account ID') {
  $loggedIn = $true
}

if ($loggedIn) {
  $email = ([regex]::Match($who, '([\w.+-]+@[\w.-]+)')).Groups[1].Value
  OK "已登录：$email"
} else {
  Write-Host '  未登录。即将用 Chrome 打开 Cloudflare 授权页。' -ForegroundColor Yellow
  Write-Host '  【提醒】若授权页显示的是你不想要的账号，先打开' -ForegroundColor Yellow
  Write-Host '          https://dash.cloudflare.com/logout 登出，或用无痕窗口。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '  准备好后按回车开始登录'

  . (Join-Path $PSScriptRoot '..\tools\chrome-helper.ps1')
  $chrome = Get-ChromePath

  # 端口自愈：回调口被占会让 wrangler 直接报 EADDRINUSE 并卡住（实测）
  $stale = Get-NetTCPConnection -State Listen -LocalPort $CallbackPort -ErrorAction SilentlyContinue
  if ($stale) {
    WARN "$CallbackPort 端口被占用，正在清理…"
    foreach ($c in $stale) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }

  # 关键：必须**继承控制台**启动（不重定向）。
  # 一旦重定向输出，wrangler 判定为非交互，只打印链接而不启动 OAuth 回调服务器，
  # 浏览器授权后回调无处可去 -> 永久干等（实测）。
  # 因此授权链接改为从 wrangler 自己的日志文件读取。
  $logsBefore = @(Get-ChildItem $LogDir -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })

  $proc = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList "`"$((Resolve-Path $wranglerEntry).Path)`"", 'login', '--browser=false' `
    -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden

  $authUrl = $null
  $deadline = (Get-Date).AddSeconds(40)
  while (-not $authUrl -and (Get-Date) -lt $deadline -and -not $proc.HasExited) {
    Start-Sleep -Milliseconds 600
    $newLog = Get-ChildItem $LogDir -Filter *.log -ErrorAction SilentlyContinue |
      Where-Object { $logsBefore -notcontains $_.Name } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newLog) {
      $m = [regex]::Match((Get-Content $newLog.FullName -Raw -Encoding UTF8), '(https://dash\.cloudflare\.com/oauth2/auth\S+)')
      if ($m.Success) { $authUrl = $m.Groups[1].Value }
    }
  }

  if ($authUrl) {
    if ($chrome) { Start-Process $chrome -ArgumentList $authUrl; OK "已用 Chrome 打开授权页" }
    else { Start-Process $authUrl }
    Write-Host '  ---- 若没弹出，手动复制这条链接到 Chrome ----' -ForegroundColor Yellow
    Write-Host "  $authUrl" -ForegroundColor White
    Write-Host '  点「允许」后本窗口会自动继续（wrangler 等 2 分钟）。' -ForegroundColor Yellow
  } else {
    WARN '40 秒内没从日志拿到授权链接，请直接看 wrangler 的输出'
  }

  if (-not $proc.WaitForExit(180000)) {
    try { $proc.Kill() } catch { }
    DIE '登录超时 —— 已结束进程并释放端口。重跑本脚本即可。'
  }
  if ($proc.ExitCode -ne 0) { DIE "登录未完成（退出码 $($proc.ExitCode)）。重跑本脚本即可。" }
  OK '授权完成'

  $who = (Invoke-Native 'npx' @('wrangler', 'whoami')).Output
  $email = ([regex]::Match($who, '([\w.+-]+@[\w.-]+)')).Groups[1].Value
  OK "登录成功：$email"
}

$accountId = Get-CfAccountId $who
if ($accountId) { OK "账号 ID：$accountId" } else { WARN '未能解析账号 ID' }

# ---------------------------------------------------------------- 2. KV
Step 2 'KV 命名空间（存基线成员数）'

# 显式 -Encoding UTF8！PS 5.1 的 Get-Content 默认按 ANSI(GBK) 解码，
# 读 UTF-8 文件会得到乱码，随后写回就永久损坏中文内容（实测踩过，不可逆）。
$tomlText = Get-Content $TOML -Raw -Encoding UTF8
$kvIdInToml = ([regex]::Match($tomlText, '(?m)^\s*id\s*=\s*"([0-9a-f]{32})"')).Groups[1].Value
$needKv = $true

if ($tomlText -match 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID') {
  Write-Host '  [i] wrangler.toml 是占位符状态，需要创建 KV'
} elseif ($kvIdInToml) {
  $belongs = Test-KvBelongsToAccount $accountId $kvIdInToml
  if ($belongs -eq $true) {
    OK "KV $kvIdInToml 属于当前账号，跳过创建"
    $needKv = $false
  } elseif ($belongs -eq $false) {
    WARN "KV $kvIdInToml 不属于当前账号（换账号后的典型情况），将重建"
  } else {
    WARN "无法确认 KV $kvIdInToml 的归属，保留现有绑定（避免误改）"
    $needKv = $false
  }
} else {
  Write-Host '  [i] wrangler.toml 里没有可用 KV id，需要创建'
}

if ($needKv) {
  $kvRes = Invoke-Native 'npx' @('wrangler', 'kv', 'namespace', 'create', $KvBinding)
  $kvOut = $kvRes.Output
  Write-Host $kvOut
  if (-not $kvRes.Ok) { DIE "创建 KV 失败（退出码 $($kvRes.ExitCode)）。输出见上。" }

  $m = [regex]::Match($kvOut, '([0-9a-fA-F]{32})')
  if (-not $m.Success) { DIE "没能从输出里解析出 KV id。请手动填进 wrangler.toml 后重跑。`n输出：$kvOut" }
  $kvId = $m.Groups[1].Value
  OK "新 KV id：$kvId"

  # 回填：占位符和「真实的旧 id」两种形态都要处理。
  # 只替换占位符是不够的 —— 换账号时文件里是真实的旧 id（实测踩过）。
  if ($tomlText -match 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID') {
    $newText = $tomlText -replace 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID', $kvId
  } elseif ($kvIdInToml -and $kvIdInToml -ne $kvId) {
    $newText = $tomlText -replace ('(?m)^(\s*id\s*=\s*")' + [regex]::Escape($kvIdInToml) + '(")'), ('${1}' + $kvId + '${2}')
  } else {
    $newText = $tomlText
  }

  [System.IO.File]::WriteAllText($TOML, ($newText -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))

  # 自校准：确认真写进去了（这一步实测拦下过一次静默失败，别删）
  $check = Get-Content $TOML -Raw -Encoding UTF8
  if ($check -match 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID') { DIE '回填失败，占位符仍存在。' }
  if ($check -notmatch [regex]::Escape($kvId)) { DIE "回填失败，$kvId 未出现在 wrangler.toml 中。" }
  if ($kvIdInToml -and $kvIdInToml -ne $kvId -and $check -match [regex]::Escape($kvIdInToml)) {
    DIE "回填不完整：旧 id $kvIdInToml 仍在文件中（会导致绑定失效、Worker 报 1101）。"
  }
  OK "回填校验通过（新 id=$kvId）"
}

# ---------------------------------------------------------------- 3. 推送通路
Step 3 '推送通路'
$secList = (Invoke-Native 'npx' @('wrangler', 'secret', 'list')).Output
$hasServerChan = $secList -match 'SERVERCHAN_KEY'
$hasDiscord = $secList -match 'DISCORD_WEBHOOK'

if ($hasServerChan -or $hasDiscord) {
  if ($hasServerChan) { OK 'Server酱（推微信）已配置' }
  if ($hasDiscord) { OK 'Discord webhook 已配置' }
  Write-Host '  如需修改： node setup-push.mjs sct <SendKey>  /  discord <webhookURL>' -ForegroundColor DarkGray
} else {
  Write-Host '  尚未配置任何推送通路（没有它，检测到开放也不会通知你）' -ForegroundColor Yellow
  Write-Host '    · Server酱（推微信，推荐）： https://sct.ftqq.com/ 拿 SendKey' -ForegroundColor Yellow
  Write-Host '    · 或 Discord webhook' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  现在配置吗？留空则跳过（稍后可随时用 setup-push.mjs 补）。' -ForegroundColor Yellow
  $key = Read-Host '  粘贴 Server酱 SendKey（SCT 开头），或直接回车跳过'
  if (-not [string]::IsNullOrWhiteSpace($key)) {
    $r = Invoke-Native 'node' @('setup-push.mjs', 'sct', $key.Trim()) -ShowOutput
    if ($r.Ok) { OK 'Server酱 已写入' } else { WARN "写入失败（退出码 $($r.ExitCode)），可稍后手动配置" }
  } else {
    WARN '已跳过。哨兵仍会每分钟检查，但不会推送通知。'
  }
}

# ---------------------------------------------------------------- 4. 部署
Step 4 '部署 Worker'
$depRes = Invoke-Native 'npx' @('wrangler', 'deploy')
Write-Host $depRes.Output
if (-not $depRes.Ok) {
  if ($depRes.Output -match 'register a workers\.dev subdomain') {
    Write-Host ''
    WARN '新账号还没有 workers.dev 子域。两种解决办法：' -ForegroundColor Yellow
    Write-Host '  A) 打开控制台 Workers & Pages 页面一次，会自动创建；' -ForegroundColor Yellow
    Write-Host '  B) 或用 API 直接注册（把 yourname 换成你想要的前缀）：' -ForegroundColor Yellow
    Write-Host "     PUT https://api.cloudflare.com/client/v4/accounts/$accountId/workers/subdomain" -ForegroundColor DarkGray
    Write-Host '     body: {"subdomain":"yourname"}' -ForegroundColor DarkGray
  }
  DIE '部署失败，看上面的报错。'
}

$mUrl = [regex]::Match($depRes.Output, '(https://[a-zA-Z0-9._-]+\.workers\.dev)')
if ($mUrl.Success) { OK "线上地址：$($mUrl.Groups[1].Value)" } else { WARN '未从输出解析到 workers.dev 地址' }

# ---------------------------------------------------------------- 5. 线上验证
Step 5 '线上实测（不依赖本地代码）'
if ($mUrl.Success) {
  $base = $mUrl.Groups[1].Value
  $host_ = ([regex]::Match($base, 'https://(.+)')).Groups[1].Value

  # 关键：workers.dev 可能被 DNS 污染（实测被解析到 Facebook 的 IP），
  # 直接用域名请求会得到 EPROTO / CERT_HAS_EXPIRED 这类握手错误，看起来像 Worker 坏了。
  # 所以先用 DoH 拿真实 IP，再用它建连（脚本内用 Node 完成，见 doh-lookup.mjs）。
  $probe = @"
import { resolveViaDoh } from './doh-lookup.mjs';
import http from 'node:http';
import tls from 'node:tls';
const HOST = '$host_';
const ips = await resolveViaDoh(HOST);
if (!ips.length) { console.log('DOH_FAILED'); process.exit(0); }
console.log('DOH_IP=' + ips[0]);
function get(ip) {
  return new Promise((res) => {
    const cr = http.request({ host: '127.0.0.1', port: 10808, method: 'CONNECT', path: ip + ':443', headers: { Host: ip + ':443' } });
    cr.on('connect', (r, s) => {
      if (r.statusCode !== 200) return res({ err: 'CONNECT ' + r.statusCode });
      const t = tls.connect({ socket: s, servername: HOST });
      let buf = '';
      t.setTimeout(30000, () => { t.destroy(); res({ err: 'TIMEOUT' }); });
      t.on('error', (e) => res({ err: e.code || e.message }));
      t.on('data', (c) => {
        buf += c.toString('utf8');
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const status = Number((buf.slice(0, i).match(/HTTP\/\d\.\d (\d+)/) || [])[1]);
        res({ status, body: buf.slice(i + 4) });
        t.destroy();
      });
      t.write('GET / HTTP/1.1\r\nHost: ' + HOST + '\r\nAccept: application/json\r\nConnection: close\r\n\r\n');
    });
    cr.on('error', (e) => res({ err: e.code || e.message }));
    cr.end();
  });
}
const r = await get(ips[0]);
console.log('STATUS=' + (r.status ?? ('ERR ' + r.err)));
console.log('BODY=' + (r.body || '').slice(0, 400));
"@
  $probeFile = Join-Path $PSScriptRoot '_probe_deploy.mjs'
  [System.IO.File]::WriteAllText($probeFile, $probe, (New-Object System.Text.UTF8Encoding $false))
  $out = (Invoke-Native 'node' @($probeFile)).Output
  Remove-Item $probeFile -ErrorAction SilentlyContinue
  Write-Host $out

  if ($out -match 'STATUS=200') {
    OK 'Worker 正常响应（HTTP 200）'
    if ($out -match 'memberCount') { OK '返回了成员数，判定逻辑在跑' }
    if ($out -match '1101') { WARN '返回 1101 —— 若是新账号请检查子域与 KV 绑定' }
  } elseif ($out -match 'DOH_FAILED') {
    WARN 'DoH 解析失败，无法验证；可稍后手动打开上面的 workers.dev 地址'
  } else {
    WARN '线上验证未通过，请看上面的 STATUS/BODY'
  }
}

# ---------------------------------------------------------------- 收尾
Write-Host ''
Write-Host '================ 完成 ================' -ForegroundColor Cyan
Write-Host '  · 确认定时器在跑： npx wrangler tail    （等 1~2 分钟，应看到每分钟一次的 cron 日志）'
Write-Host '  · 重置基线：       打开 <地址>/reset'
Write-Host '  · 改监控目标：     编辑 wrangler.toml 的 INVITE_CODE 后重新 deploy'
Write-Host ''
