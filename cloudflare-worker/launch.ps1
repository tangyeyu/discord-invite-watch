# =====================================================================
#  换账号后的一键部署（方案 A）
#
#  做三件事：
#    1) 修复 deploy.ps1 的 BOM（必需，见文件内说明）
#    2) 退出当前 Cloudflare 账号，让你登录一个「干净」账号
#    3) 调起 deploy.ps1 完成建 KV / 写密钥 / 部署 / 线上验证
#
#  用法：
#      powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1
#      powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1 -SkipLogout
# =====================================================================
param(
  [switch]$SkipLogout,
  # 默认浏览器没有代理时用这个：打印授权链接让你用能上外网的浏览器打开
  [switch]$OpenLoginUrl
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$env:HTTPS_PROXY = 'http://127.0.0.1:10808'
$env:HTTP_PROXY  = 'http://127.0.0.1:10808'

function Step($n, $t) { Write-Host "`n===== [$n] $t =====" -ForegroundColor Cyan }
function OK($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function WARN($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function DIE($t)  { Write-Host "`n  [X] $t" -ForegroundColor Red; exit 1 }

# ---------- 0. 加载原生调用封装 ----------
# 必须最早加载：PS 5.1 会把原生命令的 stderr 当终止性错误，
# 而 npx 每次都会往 stderr 打 npm 警告 —— 不封装的话脚本会莫名其妙中断（实测）。
. (Join-Path $PSScriptRoot '..\tools\ps-util.ps1')

# ---------- 1. 修 BOM ----------
Step 1 '修复 deploy.ps1 的编码（BOM）'
$r = Invoke-Native 'node' @('.\fix-bom.mjs', '.\deploy.ps1') -ShowOutput
if (-not $r.Ok) { DIE 'deploy.ps1 修复失败' }

# ---------- 2. 退出旧账号 ----------
Step 2 '退出当前 Cloudflare 账号'
if ($SkipLogout) {
  WARN '按参数要求跳过退出（-SkipLogout）'
} else {
  $whoRes = Invoke-Native 'npx' @('wrangler', 'whoami')
  $who = $whoRes.Output

  if ($who -match '(?i)not authenticated') {
    OK '当前本来就未登录，无需退出'
  } else {
    $curEmail = ([regex]::Match($who, '([\w.+-]+@[\w.-]+)')).Groups[1].Value
    if ($curEmail) { Write-Host "  当前账号：$curEmail" }
    # 记下切换前的账号 ID，稍后与登录后的对比（不硬编码任何账号 ID）
    $script:acctBefore = ([regex]::Match($who, '\b([0-9a-f]{32})\b')).Groups[1].Value
    $outRes = Invoke-Native 'npx' @('wrangler', 'logout')
    if ($outRes.Ok) { OK '已退出旧账号' } else { WARN "退出返回码 $($outRes.ExitCode)，继续往下走" }
  }

  Write-Host ''
  Write-Host '  ============ 登录前必读（不照做会失败）============' -ForegroundColor Yellow
  Write-Host '  第一步：先登出旧账号' -ForegroundColor Yellow
  Write-Host '      浏览器打开 https://dash.cloudflare.com/logout' -ForegroundColor White
  Write-Host '      或用无痕窗口（Chrome 按 Ctrl+Shift+N）' -ForegroundColor White
  Write-Host '      不登出的话，授权页会直接沿用你切换前的旧账号！' -ForegroundColor Red
  Write-Host ''
  Write-Host '  第二步：用新邮箱登录/注册（免费，不需要信用卡）' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  第三步：按回车 -> 【Chrome】打开授权页 -> 点「允许」' -ForegroundColor Yellow
  Write-Host '      （脚本会用 Chrome 而不是默认浏览器 Firefox，见 AGENTS.md 浏览器约定）' -ForegroundColor DarkGray
  Write-Host '  ================================================' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '  已登出旧账号、准备好新账号后，按回车开始登录'

  # ---- 端口自愈：先清掉占用 8976 的残留进程 ----
  # 源码依据（wrangler-dist/cli.js:123995）：端口被占时它会 UserError 并卡住，
  # 表现就是"打印了链接、浏览器也开了，但永远不继续"——实测踩过，
  # 而且当时的占用者正是我先前测试遗留的进程。
  $stale = Get-NetTCPConnection -State Listen -LocalPort 8976 -ErrorAction SilentlyContinue
  if ($stale) {
    WARN '发现 8976 端口被占用（会导致登录卡死），正在清理…'
    foreach ($c in $stale) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      Write-Host "      结束 PID $($c.OwningProcess) $($p.ProcessName)"
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    if (Get-NetTCPConnection -State Listen -LocalPort 8976 -ErrorAction SilentlyContinue) {
      DIE '8976 端口仍被占用，请手动结束该进程后重跑'
    }
    OK '端口已释放'
  } else {
    OK '8976 端口空闲'
  }

  # ---- 起 wrangler 登录，并用 Chrome 打开授权页 ----
  # 关键结论（实测，三条缺一不可）：
  #   1) 必须**继承控制台**启动（Start-Process 不重定向）。
  #      一旦把 stdout/stderr 重定向或管道，wrangler 会判定为非交互，
  #      于是**只打印链接、根本不启动 8976 回调服务器** -> 浏览器授权后回调
  #      无处可去 -> 永久干等。实测对比：重定向时 8976 从不监听；
  #      继承控制台时第 1 秒就监听。
  #   2) 因此**不能**用 add_OutputDataReceived 抓链接（那需要重定向）。改为
  #      轮询 wrangler 自己的日志文件取链接 —— 确定性强，且不影响交互性。
  #   3) 用 --browser=false 让 wrangler 别去开默认浏览器(Firefox)，
  #      由我们把链接交给 Chrome（符合 AGENTS.md 浏览器约定）。
  . (Join-Path $PSScriptRoot '..\tools\chrome-helper.ps1')
  $chrome = Get-ChromePath
  $wranglerEntry = Join-Path $PSScriptRoot '..\node_modules\wrangler\bin\wrangler.js'
  if (-not (Test-Path $wranglerEntry)) { DIE "找不到 wrangler 入口：$wranglerEntry" }

  $logDir = Join-Path $env:APPDATA 'xdg.config\.wrangler\logs'
  $logsBefore = @(Get-ChildItem $logDir -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })

  $proc = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList "`"$((Resolve-Path $wranglerEntry).Path)`"", 'login', '--browser=false' `
    -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden

  $authUrl = $null
  $deadline = (Get-Date).AddSeconds(40)
  while (-not $authUrl -and (Get-Date) -lt $deadline -and -not $proc.HasExited) {
    Start-Sleep -Milliseconds 600
    $newLog = Get-ChildItem $logDir -Filter *.log -ErrorAction SilentlyContinue |
      Where-Object { $logsBefore -notcontains $_.Name } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newLog) {
      $m = [regex]::Match((Get-Content $newLog.FullName -Raw), '(https://dash\.cloudflare\.com/oauth2/auth\S+)')
      if ($m.Success) { $authUrl = $m.Groups[1].Value }
    }
  }

  if ($authUrl) {
    if ($chrome) {
      Start-Process $chrome -ArgumentList $authUrl
      OK "已用 Chrome 打开授权页：$chrome"
    } else {
      WARN '没找到 Chrome（见 AGENTS.md 浏览器约定），退回默认浏览器'
      Start-Process $authUrl
    }
    Write-Host ''
    Write-Host '  ---- 若 Chrome 没弹出，手动复制这条链接 ----' -ForegroundColor Yellow
    Write-Host "  $authUrl" -ForegroundColor White
    Write-Host '  -------------------------------------------' -ForegroundColor Yellow
    Write-Host '  在页面上点「允许」后本窗口会自动继续（wrangler 等 2 分钟）。' -ForegroundColor Yellow
  } else {
    WARN '40 秒内没从日志拿到授权链接；请直接看 wrangler 的输出'
  }

  # 等登录完成。wrangler 自身超时是 2 分钟（cli.js:123850），这里留 3 分钟余量。
  if (-not $proc.WaitForExit(180000)) {
    try { $proc.Kill() } catch { }
    DIE '登录等待超时 —— 已结束进程并释放 8976 端口。重跑本脚本即可。'
  }
  if ($proc.ExitCode -ne 0) {
    Write-Host ''
    WARN "登录未完成（退出码 $($proc.ExitCode)）。"
    Write-Host '  排查顺序：' -ForegroundColor Yellow
    Write-Host '    1. 是否先登出了旧账号？不登出会一直授权到旧账号' -ForegroundColor Yellow
    Write-Host '    2. 浏览器里点了「取消」？ -> 重跑本脚本' -ForegroundColor Yellow
    Write-Host '    3. 授权页打不开？ -> 手动复制上面那条链接到 Chrome' -ForegroundColor Yellow
    DIE '登录失败，重跑本脚本即可（不会留下脏状态）'
  }
  OK '授权完成'

  # 走 Invoke-Native：避免 stderr 混进字符串干扰邮箱/账号 ID 的解析
  $who2 = (Invoke-Native 'npx' @('wrangler', 'whoami')).Output
  $newEmail = ([regex]::Match($who2, '([\w.+-]+@[\w.-]+)')).Groups[1].Value
  $newAcct = ([regex]::Match($who2, '\b([0-9a-f]{32})\b')).Groups[1].Value
  OK "登录成功：$newEmail"
  if ($newAcct) { Write-Host "  新账号 ID：$newAcct" }

  # 与「切换前」的账号对比：相同就说明浏览器里没真正换号。
  # 不硬编码任何账号 ID —— 切换前记下来，切换后比对（换任何账号都适用）。
  if ($script:acctBefore -and $newAcct -eq $script:acctBefore) {
    WARN '注意：这仍是切换前那个账号（ID 未变）。'
    WARN '若目标是换账号，请重跑本脚本，并在浏览器里先登出再登录新账号。'
    Write-Host ''
    Read-Host '  仍要用这个账号继续吗？按回车继续，或 Ctrl+C 退出'
  }
}

# ---------- 3. 部署 ----------
Step 3 '执行部署（deploy.ps1）'
& powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
if ($LASTEXITCODE -ne 0) { DIE '部署脚本返回失败，看上面的输出' }

Write-Host @'

  收尾提醒：
    * 若线上验证仍出现 error code: 1101，说明这个账号的 workers.dev 同样不可执行
      （旧账号就是这个问题）。此时请走方案 B：上一层目录的 deploy-vps.sh。
    * 确认定时器在跑： npx wrangler tail
'@ -ForegroundColor Cyan
