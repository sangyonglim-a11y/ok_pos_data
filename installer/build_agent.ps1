#Requires -Version 5.1
# PyInstaller로 okpos_agent.exe 생성. Inno Setup이 있으면 Setup.exe 도 만든다.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pyinstaller = Get-Command pyinstaller -ErrorAction SilentlyContinue
if (-not $pyinstaller) {
  python -m pip install pyinstaller
}

Write-Host "에이전트 exe 빌드 중..."
python -m PyInstaller --noconfirm --clean "agent\okpos_agent.spec"
if (-not (Test-Path "dist\okpos_agent.exe")) {
  throw "dist\okpos_agent.exe 생성 실패"
}

# okpos_crawler 모듈이 exe에 포함되도록 Analysis pathex 에 루트가 있음.
# 추가 데이터: config.example 은 spec 에 포함.

$iscc = Get-Command iscc -ErrorAction SilentlyContinue
if (-not $iscc) {
  $guess = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($guess) { $iscc = @{ Source = $guess } }
}

if ($iscc) {
  Write-Host "Inno Setup 설치파일 생성 중..."
  & $iscc.Source "installer\okpos_agent.iss"
  Write-Host "완료: installer\output\OkposAgentSetup.exe"
} else {
  Write-Host "Inno Setup(ISCC) 없음 — exe 만 생성됨: dist\okpos_agent.exe"
  Write-Host "설치: dist\okpos_agent.exe 와 agent\config.example.json 을 매장 폴더에 복사 후"
  Write-Host "  1) config.json 작성 + 서비스계정 JSON 복사"
  Write-Host "  2) powershell -File agent\register_schedule.ps1 -InstallDir <폴더>"
}
