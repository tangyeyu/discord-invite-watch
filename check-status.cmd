@echo off
rem ===================================================================
rem  Double-click launcher for the one-key community status check.
rem
rem  IMPORTANT: keep this file ASCII-only.
rem  cmd.exe parses .bat/.cmd byte-wise using the OEM codepage (GBK on
rem  Chinese Windows), so UTF-8 Chinese text here gets split mid-byte and
rem  executed as commands (verified failure). All Chinese output is
rem  produced by check-status.ps1 instead, where the encoding is controlled.
rem ===================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-status.ps1"

echo.
echo ------------------------------------------------------------
echo Done. This window stays open so you can read the result.
echo Log file: logs\status-YYYYMM.log
echo ------------------------------------------------------------
echo.
pause
endlocal
