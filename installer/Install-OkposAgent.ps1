#Requires -Version 5.1
# 매장 PC용 간단 설치(Inno Setup 대체). 관리자 권한 불필요.
param(
  [string]$SourceDir = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\OkposAgent"
)

$ErrorActionPreference = "Stop"
if (-not $SourceDir) {
  $SourceDir = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $PSScriptRoot "okpos_agent.exe")) {
    $SourceDir = $PSScriptRoot
  } elseif (Test-Path (Join-Path $SourceDir "dist\okpos_agent.exe")) {
    $SourceDir = Join-Path $SourceDir "dist"
  }
}

$exeSrc = Join-Path $SourceDir "okpos_agent.exe"
if (-not (Test-Path $exeSrc)) {
  throw "okpos_agent.exe 를 찾을 수 없습니다: $exeSrc"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $exeSrc (Join-Path $InstallDir "okpos_agent.exe") -Force

$root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $root "agent\config.example.json"
if (-not (Test-Path $example)) { $example = Join-Path $SourceDir "config.example.json" }
if (Test-Path $example) {
  Copy-Item $example (Join-Path $InstallDir "config.example.json") -Force
  $cfg = Join-Path $InstallDir "config.json"
  if (-not (Test-Path $cfg)) { Copy-Item $example $cfg }
}

$reg = Join-Path $root "agent\register_schedule.ps1"
if (-not (Test-Path $reg)) { $reg = Join-Path $SourceDir "register_schedule.ps1" }
if (Test-Path $reg) {
  Copy-Item $reg (Join-Path $InstallDir "register_schedule.ps1") -Force
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir "register_schedule.ps1") -InstallDir $InstallDir
}

Write-Host ""
Write-Host "설치 위치: $InstallDir"
Write-Host "1) config.json 에 OKPOS 계정·시트 URL 입력"
Write-Host "2) 서비스계정 JSON 파일을 같은 폴더에 넣고 service_account_file 이름 맞추기"
Write-Host "3) 바탕화면 'OKPOS 판매수집' 으로 수동 실행 가능"
Write-Host "4) 작업 스케줄러가 30분마다 무화면 수집 (영업시간만)"
