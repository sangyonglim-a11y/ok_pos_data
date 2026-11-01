#Requires -Version 5.1
# 매장 PC에서 실행: GitHub Release 의 최신 OkposAgentSetup.exe 를 받아 덮어설치합니다.
# config.json / 서비스계정 JSON 은 유지됩니다.
param(
  [string]$InstallDir = $PSScriptRoot,
  [string]$Repo = "sangyonglim-a11y/ok_pos_data",
  [string]$AssetName = "OkposAgentSetup.exe"
)

$ErrorActionPreference = "Stop"
$api = "https://api.github.com/repos/$Repo/releases/latest"
Write-Host "최신 버전 확인 중... ($Repo)"

try {
  $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "OkposAgentUpdater" }
} catch {
  throw "릴리스 정보를 가져오지 못했습니다. 저장소에 Release 가 있는지, 비공개면 토큰이 필요합니다.`n$_"
}

$asset = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
if (-not $asset) {
  $names = ($release.assets | ForEach-Object { $_.name }) -join ", "
  throw "릴리스에 $AssetName 이 없습니다. assets: $names"
}

$tmp = Join-Path $env:TEMP "OkposAgentSetup-update.exe"
Write-Host "다운로드: $($release.tag_name) / $AssetName"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -UseBasicParsing

Write-Host "설치 실행 (설정 파일은 유지)..."
$args = "/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /DIR=`"$InstallDir`""
Start-Process -FilePath $tmp -ArgumentList $args -Wait
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

# 스케줄 재등록
$reg = Join-Path $InstallDir "register_schedule.ps1"
if (Test-Path $reg) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $reg -InstallDir $InstallDir
}

Write-Host "업데이트 완료: $($release.tag_name)"
Write-Host "설치 폴더: $InstallDir"
