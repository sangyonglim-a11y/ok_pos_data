#Requires -Version 5.1
# 1) okpos_agent.exe 빌드  2) OkposAgentSetup.exe 생성  3) 매장 배포 폴더 준비
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== 1. PyInstaller =="
python -m pip install -q pyinstaller
python -m PyInstaller --noconfirm --clean "agent\okpos_agent.spec"
if (-not (Test-Path "dist\okpos_agent.exe")) { throw "dist\okpos_agent.exe 생성 실패" }

$iscc = @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup(ISCC.exe) 없음. winget install JRSoftware.InnoSetup" }

Write-Host "== 2. Inno Setup =="
& $iscc "installer\okpos_agent.iss"
$setup = Join-Path $PSScriptRoot "output\OkposAgentSetup.exe"
if (-not (Test-Path $setup)) { throw "Setup 생성 실패" }

Write-Host "== 3. 매장 배포 폴더 =="
$pack = Join-Path $root "매장배포_USB"
New-Item -ItemType Directory -Force -Path $pack | Out-Null
Copy-Item $setup (Join-Path $pack "OkposAgentSetup.exe") -Force
Copy-Item (Join-Path $PSScriptRoot "설치안내.txt") (Join-Path $pack "01_설치안내.txt") -Force

# 비밀 설정은 USB 전용 하위 폴더 (GitHub에 올리지 말 것)
$secretDir = Join-Path $pack "02_매장설정_처음한번만"
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null

$cfgSrc = Join-Path $root "agent\config.json"
if (Test-Path $cfgSrc) {
  $cfg = Get-Content $cfgSrc -Raw -Encoding UTF8 | ConvertFrom-Json
  $cfg.service_account_file = "okpos-inventory.json"
  ($cfg | ConvertTo-Json -Depth 8) | Set-Content -Encoding UTF8 (Join-Path $secretDir "config.json")
} else {
  Copy-Item (Join-Path $root "agent\config.example.json") (Join-Path $secretDir "config.json") -Force
}

$sa = Get-ChildItem $root -Filter "okpos-inventory-*.json" | Select-Object -First 1
if ($sa) {
  Copy-Item $sa.FullName (Join-Path $secretDir "okpos-inventory.json") -Force
}

@"
매장 PC 설치 순서
================
1) OkposAgentSetup.exe 실행 (설치)
2) 설치 폴더가 열리면, 이 USB의 [02_매장설정_처음한번만] 안 파일을 전부 복사
   대상: %LOCALAPPDATA%\OkposAgent
3) 바탕화면 'OKPOS 판매수집' 더블클릭으로 테스트
4) 이후 업데이트는 새 OkposAgentSetup.exe 만 다시 실행하면 됩니다 (설정 유지)

주의: 02_매장설정_처음한번만 폴더는 비밀정보가 들어 있습니다. GitHub/카톡 공개채팅에 올리지 마세요.
"@ | Set-Content -Encoding UTF8 (Join-Path $pack "00_먼저읽기.txt")

# Desktop shortcut to pack for easy USB copy
$desktop = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop "매장배포_USB.lnk"
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($linkPath)
$sc.TargetPath = $pack
$sc.Description = "매장 PC에 복사할 설치 파일"
$sc.Save()

Write-Host ""
Write-Host "완료!"
Write-Host "  Setup: $setup"
Write-Host "  USB폴더: $pack"
Write-Host "  바탕화면 바로가기: 매장배포_USB"
Get-Item $setup | Format-List Name, Length, LastWriteTime
