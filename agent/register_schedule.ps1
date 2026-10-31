#Requires -Version 5.1
# 30분마다 무화면 수집 + 바탕화면 수동 바로가기
param(
  [string]$InstallDir = $PSScriptRoot,
  [int]$IntervalMinutes = 30
)

$ErrorActionPreference = "Stop"
$exe = Join-Path $InstallDir "okpos_agent.exe"
$usePython = $false
if (-not (Test-Path $exe)) {
  $exe = Join-Path $InstallDir "store_agent.py"
  $usePython = $true
  if (-not (Test-Path $exe)) { throw "okpos_agent.exe / store_agent.py 를 찾을 수 없습니다: $InstallDir" }
}

$taskName = "중계고기파티_OKPOS수집"
if ($usePython) {
  $python = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $python) { throw "python 이 없습니다. exe 설치본을 사용하세요." }
  $action = New-ScheduledTaskAction -Execute $python -Argument "`"$exe`" --once --silent" -WorkingDirectory $InstallDir
} else {
  $action = New-ScheduledTaskAction -Execute $exe -Argument "--once --silent" -WorkingDirectory $InstallDir
}

# 매 30분. 영업시간 여부는 프로그램(config.json)에서 판단하고 아니면 바로 종료
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "OKPOS 판매수집.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ($usePython) {
  $shortcut.TargetPath = (Get-Command python).Source
  $shortcut.Arguments = "`"$exe`" --manual"
} else {
  $shortcut.TargetPath = $exe
  $shortcut.Arguments = "--manual"
}
$shortcut.WorkingDirectory = $InstallDir
$shortcut.WindowStyle = 7
$shortcut.Description = "OKPOS 판매내역을 지금 한 번 가져옵니다"
$shortcut.Save()

Write-Host "등록 완료: 작업 스케줄러 '$taskName' (${IntervalMinutes}분마다, 화면 없음)"
Write-Host "바탕화면 바로가기: $shortcutPath"
Write-Host "영업시간은 config.json 의 business_hours 로 조정합니다."
