#Requires -Version 5.1
# 매일 06:10 / 19:10 에 일별날씨만 갱신 (Python 필요)
param(
  [string]$ProjectDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectDir) {
  # 기본: 이 스크립트 기준 상위(프로젝트 루트) 또는 설치 폴더
  $here = $PSScriptRoot
  $parent = Split-Path -Parent $here
  if (Test-Path (Join-Path $parent "weather_daily.py")) {
    $ProjectDir = $parent
  } elseif (Test-Path (Join-Path $here "weather_daily.py")) {
    $ProjectDir = $here
  } else {
    throw "weather_daily.py 경로를 찾지 못했습니다. -ProjectDir 로 지정하세요."
  }
}

$script = Join-Path $ProjectDir "weather_daily.py"
if (-not (Test-Path $script)) { throw "없음: $script" }

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw "python 이 PATH 에 없습니다. 포스 PC에 Python 을 설치하거나 PATH 를 설정하세요." }

$taskName = "중계고기파티_일별날씨"
$arg = "`"$script`" --days 2"
$action = New-ScheduledTaskAction -Execute $python -Argument $arg -WorkingDirectory $ProjectDir

$t1 = New-ScheduledTaskTrigger -Daily -At "06:10"
$t2 = New-ScheduledTaskTrigger -Daily -At "19:10"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($t1, $t2) -Settings $settings -Principal $principal | Out-Null

Write-Host "등록 완료: 작업 스케줄러 '$taskName' (매일 06:10, 19:10)"
Write-Host "작업 폴더: $ProjectDir"
Write-Host "config.json 에 weather_api_key 가 있어야 합니다."
