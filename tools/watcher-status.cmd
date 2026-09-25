@echo off
rem ===================================================================
rem  Desktop launcher: watcher status check (watchdog)
rem
rem  Shows in one screen:
rem    - is the watcher process running (and is it duplicated)
rem    - is the proxy up
rem    - is "auto open browser on reopen" enabled
rem    - what the last poll found, and when
rem    - a LIVE test: can it reach Discord right now
rem
rem  IMPORTANT: keep this file ASCII-only. cmd.exe parses .bat/.cmd
rem  byte-wise using the OEM codepage (GBK on Chinese Windows); UTF-8
rem  non-ASCII bytes get split and executed as commands.
rem  All Chinese output is produced by the PowerShell script instead.
rem ===================================================================
chcp 65001 >nul
setlocal
title Watcher Status

set "PS1=C:\Users\luoti\Desktop\dsh\leina-invite-watch\tools\watcher-status.ps1"

if not exist "%PS1%" (
  echo.
  echo [X] Script not found:
  echo     %PS1%
  echo.
  echo     The project folder may have moved. Update the PS1 path
  echo     inside this file, or run the check from the project dir.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
endlocal
