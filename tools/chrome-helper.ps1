# 统一的 Chrome 调用助手（PowerShell 脚本可 dot-source 使用）
#
# 工作区约定（见 AGENTS.md「浏览器调用约定」）：
#   本机默认浏览器是 Firefox，而访问境外站点依赖系统代理 127.0.0.1:10808；
#   Chrome/Edge 必定读系统代理，Firefox 代理行为不确定。
#   => 凡是要打开网页，一律显式指定 Chrome，不要依赖默认浏览器关联。
#
# 用法（在别的 .ps1 里）：
#   . "$PSScriptRoot\chrome-helper.ps1"
#   Open-Chrome -Url 'https://example.com'
#   $chrome = Get-ChromePath
#
# 注意：本文件是 PowerShell 脚本，注释只能用 #，不能用 //（实测会被当命令执行）。
#
# 本机 Chrome 路径。重装/换盘时改这里，并同步更新 AGENTS.md。
$script:ChromePreferred = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$script:ChromeCandidates = @(
  $script:ChromePreferred,
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)

function Get-ChromePath {
  <# 返回可用的 Chrome 路径；找不到返回 $null #>
  foreach ($c in $script:ChromeCandidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

function Open-Chrome {
  <#
    用 Chrome 打开 URL。
      -Url        要打开的地址
      -NewWindow  新窗口
      -Incognito  无痕（没有旧 cookie，适合切换账号登录）
      -DryRun     只校验不打开
    返回 $true / $false
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [switch]$NewWindow,
    [switch]$Incognito,
    [switch]$DryRun
  )

  if ([string]::IsNullOrWhiteSpace($Url)) {
    Write-Host '  [X] Open-Chrome: URL 为空' -ForegroundColor Red
    return $false
  }
  if ($Url -notmatch '^[a-zA-Z][a-zA-Z0-9+.\-]*:') {
    Write-Host "  [!] Open-Chrome: 参数不像 URL（缺少协议头）：$Url" -ForegroundColor Yellow
    return $false
  }

  $chrome = Get-ChromePath
  if (-not $chrome) {
    Write-Host '  [X] Open-Chrome: 找不到 Chrome，候选路径都不存在：' -ForegroundColor Red
    $script:ChromeCandidates | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
    Write-Host '      请更新 AGENTS.md 的浏览器调用约定。' -ForegroundColor Yellow
    return $false
  }

  $argList = @()
  if ($Incognito) { $argList += '--incognito' }
  if ($NewWindow) { $argList += '--new-window' }
  $argList += $Url

  if ($DryRun) {
    Write-Host "  [DryRun] Open-Chrome: $chrome $($argList -join ' ')" -ForegroundColor Cyan
    return $true
  }

  try {
    Start-Process -FilePath $chrome -ArgumentList $argList -ErrorAction Stop
    return $true
  } catch {
    Write-Host "  [X] Open-Chrome 启动失败：$($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}
