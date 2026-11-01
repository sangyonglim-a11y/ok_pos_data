; Inno Setup 6 — 매장 PC용 OKPOS 수집 에이전트
; 빌드: installer\build_agent.ps1

#define MyAppName "중계고기파티 OKPOS 수집"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "중계고기파티"
#define MyAppExeName "okpos_agent.exe"

[Setup]
AppId={{8F2C1A3E-9B4D-4E7A-A1C2-OKPOSAGENT01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\OkposAgent
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=OkposAgentSetup
SetupIconFile=
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
InfoBeforeFile=설치안내.txt
CloseApplications=force
RestartIfNeededByRun=no

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 수동 수집 바로가기 만들기"; GroupDescription: "추가 아이콘:"; Flags: checkedonce
Name: "autostart"; Description: "30분마다 자동 수집(작업 스케줄러) 등록"; GroupDescription: "자동 실행:"; Flags: checkedonce

[Files]
Source: "..\dist\okpos_agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\register_schedule.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\update_agent.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\VERSION"; DestDir: "{app}"; Flags: ignoreversion
Source: "설치안내.txt"; DestDir: "{app}"; Flags: ignoreversion
; 비밀 설정(config.json, 서비스계정 JSON)은 설치파일에 넣지 않음 — USB의 매장설정 폴더에서 복사

[Icons]
Name: "{group}\{#MyAppName} 수동 수집"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--manual"; WorkingDir: "{app}"
Name: "{group}\업데이트"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\update_agent.ps1"" -InstallDir ""{app}"""; WorkingDir: "{app}"
Name: "{group}\설치 폴더 열기"; Filename: "{app}"
Name: "{autodesktop}\OKPOS 판매수집"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--manual"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{autodesktop}\OKPOS 에이전트 업데이트"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\update_agent.ps1"" -InstallDir ""{app}"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\register_schedule.ps1"" -InstallDir ""{app}"""; StatusMsg: "자동 수집 일정을 등록하는 중..."; Tasks: autostart; Flags: runhidden waituntilterminated
Filename: "{win}\explorer.exe"; Parameters: "{app}"; Description: "설치 폴더 열기 (config.json · 서비스계정 JSON 복사)"; Flags: postinstall nowait skipifsilent

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ExampleFile, ConfigFile: string;
begin
  if CurStep = ssPostInstall then
  begin
    ExampleFile := ExpandConstant('{app}\config.example.json');
    ConfigFile := ExpandConstant('{app}\config.json');
    if (not FileExists(ConfigFile)) and FileExists(ExampleFile) then
      CopyFile(ExampleFile, ConfigFile, False);
  end;
end;
