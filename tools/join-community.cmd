@echo off
rem ===================================================================
rem  One-click JOIN launcher for the Discord community.
rem
rem  Opened by the watcher when the invite reopens, or by hand.
rem  Tries Discord's native deep link first (discord://-/invite/<code>)
rem  and falls back to Chrome if the desktop client is not present.
rem
rem  Why Chrome as fallback: the desktop client may not use the system
rem  proxy, while Chrome always does (verified on this machine), and
rem  discord.com itself needs a working proxy here.
rem
rem  IMPORTANT: keep this file ASCII-only. cmd.exe parses .bat/.cmd
rem  byte-wise using the OEM codepage (GBK on Chinese Windows), so
rem  UTF-8 non-ASCII text gets split and executed as commands.
rem  All Chinese output comes from PowerShell instead.
rem ===================================================================
chcp 65001 >nul
setlocal
title Join Community

rem ---- CONFIG: change this when the invite code rotates ----
set "INVITE_CODE=odysseia"
rem ---------------------------------------------------------

set "WEBURL=https://discord.com/invite/%INVITE_CODE%"
set "DEEPURL=discord://-/invite/%INVITE_CODE%"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "DISCORD=%LOCALAPPDATA%\Discord\app-1.0.9258\Discord.exe"

echo.
echo  ============================================================
echo   Join the community
echo  ============================================================
echo.
echo   Invite code : %INVITE_CODE%
echo   Web URL     : %WEBURL%
echo.
echo   Opening with the Discord desktop client (deep link)...
echo   If nothing happens within 5 seconds, Chrome will be used.
echo.

rem Try the Discord desktop client deep link via the registered handler
start "" "%DEEPURL%"

rem Give it a moment, then offer the browser path
timeout /t 5 /nobreak >nul

if exist "%CHROME%" (
  echo   Also opening in Chrome as a backup path...
  start "" "%CHROME%" "%WEBURL%"
) else (
  echo   [!] Chrome not found at the expected path.
  echo       Opening with the default browser instead.
  start "" "%WEBURL%"
)

echo.
echo  ------------------------------------------------------------
echo   If the server is still paused you will see:
echo     "The invite for this server is currently paused"
echo   That is expected - the community has not reopened yet.
echo.
echo   When it IS open you may also need:
echo     - a verified phone number on your Discord account
echo       (this server uses the highest verification level)
echo     - to accept the server rules after joining
echo  ------------------------------------------------------------
echo.
pause
endlocal
