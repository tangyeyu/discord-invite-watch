# Verify that the desktop-notification path actually works on this machine.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as GBK.
$ErrorActionPreference = 'Stop'

$title = 'Leina invite watcher - self test'
$body  = 'If you can see this toast, the alert channel works.'

$xml = '<toast duration="long"><visual><binding template="ToastGeneric">' +
       "<text>$title</text><text>$body</text>" +
       '</binding></visual><audio src="ms-winsoundevent:Notification.Looping.Alarm2" loop="false"/></toast>'

Write-Host "[1/3] Loading WinRT toast APIs..."
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
Write-Host "      OK"

Write-Host "[2/3] Showing test toast..."
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml($xml)
$t = New-Object Windows.UI.Notifications.ToastNotification $x
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('LeinaInviteWatch')
$notifier.Show($t)
Write-Host "      Show() returned without error"

Write-Host "[3/3] Beep test..."
[console]::beep(880, 200); [console]::beep(1180, 200); [console]::beep(1560, 350)
Write-Host "      OK"

Write-Host ""
Write-Host "RESULT: API call succeeded. A toast should be visible in the bottom-right corner"
Write-Host "        (or in the Action Center / notification history)."
Write-Host "If you did NOT see it, check: Settings > System > Notifications, and make sure"
Write-Host "Focus Assist / Do Not Disturb and 'quiet hours' are not suppressing toasts."
