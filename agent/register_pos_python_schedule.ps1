#Requires -Version 5.1
# 기존 exe 스케줄 대신, 최신 파이썬 코드로 30분마다 무화면 수집
# 필요 파일: ProjectDir\okpos_crawler.py , ProjectDir\agent\store_agent.py , config.json
param(
  [string]$ProjectDir = "",
  [int]$IntervalMinutes = 30
)

$ErrorActionPreference = "Stop"

if (-not $ProjectDir) {
  $here = $PSScriptRoot
  $parent = Split-Path -Parent $here
  if (Test-Path (Join-Path $parent "okpos_crawler.py")) {
    $ProjectDir = $parent
  } elseif (Test-Path (Join-Path $here "okpos_crawler.py")) {
    $ProjectDir = $here
  } else {
    throw "okpos_crawler.py 를 찾지 못했습니다. -ProjectDir 로 지정하세요."
  }
}

$agent = Join-Path $ProjectDir "agent\store_agent.py"
$crawler = Join-Path $ProjectDir "okpos_crawler.py"
if (-not (Test-Path $crawler)) { throw "없음: $crawler" }

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw "python 이 PATH 에 없습니다." }

if (Test-Path $agent) {
  $work = Join-Path $ProjectDir "agent"
  $arg = "`"$agent`" --once --silent"
} else {
  $work = $ProjectDir
  $arg = "`"$crawler`""
  Write-Host "경고: store_agent.py 없음 → okpos_crawler.py 직접 실행(안내 창이 뜰 수 있음)"
}

$taskName = "중계고기파티_OKPOS수집"
$action = New-ScheduledTaskAction -Execute $python -Argument $arg -WorkingDirectory $work
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

Write-Host "등록 완료: '$taskName' (${IntervalMinutes}분마다, Python)"
Write-Host "작업 폴더: $work"
Write-Host "인수: $arg"
