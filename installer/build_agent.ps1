#Requires -Version 5.1
# 1) okpos_agent.exe build  2) OkposAgentSetup.exe  3) store deploy folder
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== 1. PyInstaller =="
python -m pip install -q pyinstaller
python -m PyInstaller --noconfirm --clean "agent\okpos_agent.spec"
if (-not (Test-Path "dist\okpos_agent.exe")) { throw "dist\okpos_agent.exe missing" }

$iscc = @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup (ISCC.exe) not found. winget install JRSoftware.InnoSetup" }

Write-Host "== 2. Inno Setup =="
& $iscc "installer\okpos_agent.iss"
$setup = Join-Path $PSScriptRoot "output\OkposAgentSetup.exe"
if (-not (Test-Path $setup)) { throw "Setup build failed" }

Write-Host "== 3. Deploy folder =="
$pack = Join-Path $root "store_deploy_USB"
if (Test-Path $pack) { Remove-Item $pack -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pack | Out-Null
Copy-Item $setup (Join-Path $pack "OkposAgentSetup.exe") -Force
Copy-Item (Join-Path $PSScriptRoot "00_README_deploy.txt") (Join-Path $pack "00_README.txt") -Force
$guide = Get-ChildItem $PSScriptRoot -Filter "*.txt" | Where-Object { $_.Name -like "*안내*" -or $_.Name -eq "install_guide.txt" } | Select-Object -First 1
if ($guide) { Copy-Item $guide.FullName (Join-Path $pack "01_install_guide.txt") -Force }
else { Copy-Item (Join-Path $PSScriptRoot "00_README_deploy.txt") (Join-Path $pack "01_install_guide.txt") -Force }

$secretDir = Join-Path $pack "02_store_secrets_first_time"
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
python (Join-Path $PSScriptRoot "_pack_secret_config.py") --root $root --out $secretDir

$sa = Get-ChildItem $root -Filter "okpos-inventory-*.json" | Select-Object -First 1
if ($sa) {
  Copy-Item $sa.FullName (Join-Path $secretDir "okpos-inventory.json") -Force
}

$desktop = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop "store_deploy_USB.lnk"
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($linkPath)
$sc.TargetPath = $pack
$sc.Description = "Store PC install package"
$sc.Save()

Write-Host ""
Write-Host "DONE"
Write-Host "  Setup: $setup"
Write-Host "  USB folder: $pack"
Write-Host "  Desktop shortcut: store_deploy_USB.lnk"
Get-Item $setup | Format-List Name, Length, LastWriteTime
