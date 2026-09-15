# =====================================================================
#  统一的「用 Chrome 打开」入口
#
#  为什么需要它：本机默认浏览器是 Firefox，而访问境外站点依赖系统代理
#  127.0.0.1:10808 —— Chrome/Edge 必定读系统代理，Firefox 的代理行为不确定。
#  用默认浏览器打开境外链接有"页面打不开"的实际风险（登录 Cloudflare 时踩过）。
#  所以约定：凡是要打开网页，一律显式指定 Chrome。
#  约定见工作区 AGENTS.md 的「浏览器调用约定」。
#
#  用法：
#      powershell -File .\open-chrome.ps1 -Url "https://example.com"
#      powershell -File .\open-chrome.ps1 -Url "https://a.com" -NewWindow
#      powershell -File .\open-chrome.ps1 -Url "https://a.com" -Incognito
# =====================================================================
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [switch]$NewWindow,
  [switch]$Incognito,
  # 仅校验路径与参数，不真正打开（便于自动化测试）
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 本机 Chrome 路径。若重装/换盘，改这一行即可（同时更新 AGENTS.md）。
$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

# 备用候选：路径变了也不至于直接失败
$Candidates = @(
  $ChromePath,
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)

function Resolve-Chrome {
  foreach ($c in $Candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

function Fail($msg) {
  Write-Host "  [X] $msg" -ForegroundColor Red
  exit 1
}

# ---- 1) 校验 URL ----
if ([string]::IsNullOrWhiteSpace($Url)) { Fail 'URL 为空' }
# 允许 ms-settings: / discord: 之类的自定义协议，也允许 http(s)
if ($Url -notmatch '^[a-zA-Z][a-zA-Z0-9+.\-]*:') {
  Write-Host "  [!] 这个参数不像 URL（缺少协议头）：$Url" -ForegroundColor Yellow
  Write-Host '      例：https://example.com' -ForegroundColor Yellow
  exit 2
}

# ---- 2) 校验 Chrome ----
$chrome = Resolve-Chrome
if (-not $chrome) {
  Write-Host '  [X] 找不到 Chrome；候选路径都不存在：' -ForegroundColor Red
  $Candidates | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
  Write-Host '  请确认 Chrome 安装位置，并同步更新 AGENTS.md 的约定。' -ForegroundColor Yellow
  Write-Host '  退回用默认浏览器打开（可能因无代理而打不开境外页面）：' -ForegroundColor Yellow
  Start-Process $Url
  exit 1
}

if ($chrome -ne $ChromePath) {
  Write-Host "  [!] 约定路径不存在，改用备用路径：$chrome" -ForegroundColor Yellow
}

# ---- 3) 组装参数 ----
$argList = @()
if ($Incognito) { $argList += '--incognito' }
if ($NewWindow) { $argList += '--new-window' }
$argList += $Url

$ver = (Get-Item -LiteralPath $chrome).VersionInfo.ProductVersion
Write-Host "  Chrome : $chrome" -ForegroundColor Green
Write-Host "  版本   : $ver"
Write-Host "  打开   : $Url"

if ($DryRun) {
  Write-Host "  [DryRun] 未真正打开。参数：$($argList -join ' ')" -ForegroundColor Cyan
  exit 0
}

Start-Process -FilePath $chrome -ArgumentList $argList
Write-Host '  已发起打开请求。' -ForegroundColor Green
exit 0
