# =====================================================================
#  原生命令调用封装（PowerShell 5.1 的 stderr 陷阱）
#
#  背景事故：`npx wrangler logout` 会在 stderr 打印 npm 警告
#  （"Proxy environment variables detected..."）。PowerShell 5.1 把原生命令的
#  stderr 视作 ErrorRecord，配合脚本里的 $ErrorActionPreference='Stop'，
#  会让**脚本直接终止**，并在用户面前刷一堆红色 NativeCommandError。
#  实测后果：launch.ps1 卡在「退出账号」这步，打印完账号名就没了下文。
#
#  用法：. "$PSScriptRoot\ps-util.ps1"
#        $r = Invoke-Native 'npx' @('wrangler','whoami') -ShowOutput
#        $r.ExitCode / $r.Output / $r.Ok
#
#  注意：本文件是 PowerShell 脚本，注释只能用 #，不能用 //。
# =====================================================================

function Invoke-Native {
  <#
    安全执行原生命令：把 stderr 合并进 stdout，避免被当成终止性错误。
      -FilePath     可执行文件（npx / node / git ...）
      -ArgumentList 参数数组
      -ShowOutput   实时打印输出（需要交互输入的命令必须开，否则提示看不见）
      -TimeoutSec   超时（默认 300 秒）
    返回 [pscustomobject]@{ Ok; ExitCode; Output }
  #>
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [switch]$ShowOutput,
    [int]$TimeoutSec = 300
  )

  # 关键：临时放宽 ErrorActionPreference，否则原生命令的 stderr 会被 PS 5.1
  # 当成终止性错误，脚本会在这一行直接死掉。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($ShowOutput) {
      # 不重定向，直接让子进程继承当前控制台：
      # 这样交互式提示（例如 wrangler 的 OAuth 引导）用户能看见、能回答。
      & $FilePath @ArgumentList
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      return [pscustomobject]@{ Ok = ($code -eq 0); ExitCode = $code; Output = '' }
    }

    $out = & $FilePath @ArgumentList 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ Ok = ($code -eq 0); ExitCode = $code; Output = $out }
  } finally {
    $ErrorActionPreference = $prevEap
  }
}
