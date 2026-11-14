#Requires -Version 5.1
# POS 30분 + 날씨 2회(11:40, 19:10) + 매일 23:00 강제 종료
param(
  [string]$InstallDir = $PSScriptRoot,
  [int]$IntervalMinutes = 30,
  [string]$ShutdownAt = "23:00"
)

$ErrorActionPreference = "Stop"
$exe = Join-Path $InstallDir "okpos_agent.exe"
$usePython = $false
if (-not (Test-Path $exe)) {
  $exe = Join-Path $InstallDir "store_agent.py"
  $usePython = $true
  if (-not (Test-Path $exe)) { throw "okpos_agent.exe / store_agent.py 를 찾을 수 없습니다: $InstallDir" }
}

$python = $null
if ($usePython) {
  $python = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $python) { throw "python 이 없습니다. exe 설치본을 사용하세요." }
}

function New-PosAction {
  if ($usePython) {
    return New-ScheduledTaskAction -Execute $python -Argument "`"$exe`" --once --silent" -WorkingDirectory $InstallDir
  }
  return New-ScheduledTaskAction -Execute $exe -Argument "--once --silent" -WorkingDirectory $InstallDir
}

function New-WeatherAction {
  if ($usePython) {
    return New-ScheduledTaskAction -Execute $python -Argument "`"$exe`" --weather-only --silent" -WorkingDirectory $InstallDir
  }
  return New-ScheduledTaskAction -Execute $exe -Argument "--weather-only --silent" -WorkingDirectory $InstallDir
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# --- POS 30분 ---
$posName = "중계고기파티_OKPOS수집"
$posTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
Unregister-ScheduledTask -TaskName $posName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $posName -Action (New-PosAction) -Trigger $posTrigger -Settings $settings -Principal $principal | Out-Null

# --- 날씨 2회 ---
$wxName = "중계고기파티_일별날씨"
$wxTriggers = @(
  (New-ScheduledTaskTrigger -Daily -At "11:40"),
  (New-ScheduledTaskTrigger -Daily -At "19:10")
)
Unregister-ScheduledTask -TaskName $wxName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $wxName -Action (New-WeatherAction) -Trigger $wxTriggers -Settings $settings -Principal $principal | Out-Null

# --- 매일 23:00 강제 종료 (/s /f /t 0) ---
$offName = "중계고기파티_매장PC강제종료"
$offAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\shutdown.exe" -Argument "/s /f /t 0"
$offTrigger = New-ScheduledTaskTrigger -Daily -At $ShutdownAt
$offSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
# 종료는 높은 권한 필요할 수 있음
$offPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
Unregister-ScheduledTask -TaskName $offName -Confirm:$false -ErrorAction SilentlyContinue
try {
  Register-ScheduledTask -TaskName $offName -Action $offAction -Trigger $offTrigger -Settings $offSettings -Principal $offPrincipal | Out-Null
} catch {
  # UAC/권한 실패 시 일반 권한으로라도 등록
  Register-ScheduledTask -TaskName $offName -Action $offAction -Trigger $offTrigger -Settings $offSettings -Principal $principal | Out-Null
  Write-Host "경고: 강제종료 작업을 일반 권한으로 등록했습니다. 안 되면 관리자 PowerShell 에서 register_schedule.ps1 을 다시 실행하세요."
}

# 바탕화면 수동 바로가기
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "OKPOS 판매수집.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ($usePython) {
  $shortcut.TargetPath = $python
  $shortcut.Arguments = "`"$exe`" --manual"
} else {
  $shortcut.TargetPath = $exe
  $shortcut.Arguments = "--manual"
}
$shortcut.WorkingDirectory = $InstallDir
$shortcut.WindowStyle = 7
$shortcut.Description = "OKPOS 판매내역을 지금 한 번 가져옵니다"
$shortcut.Save()

Write-Host "등록 완료"
Write-Host "  - $posName : ${IntervalMinutes}분마다 POS"
Write-Host "  - $wxName : 매일 11:40 · 19:10 날씨"
Write-Host "  - $offName : 매일 $ShutdownAt 강제 종료 (shutdown /s /f /t 0)"
Write-Host "  - 바탕화면: $shortcutPath"
