; Inno Setup 6 — 매장 PC용 OKPOS 수집 에이전트 설치 파일
; 빌드: 먼저 build_agent.ps1 실행 후, Inno Setup으로 이 파일 컴파일

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
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 수동 수집 바로가기 만들기"; GroupDescription: "추가 아이콘:"; Flags: checkedonce
Name: "autostart"; Description: "로그인 시 백그라운드 자동 수집 등록"; GroupDescription: "자동 실행:"; Flags: checkedonce

[Files]
Source: "..\dist\okpos_agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\register_schedule.ps1"; DestDir: "{app}"; Flags: ignoreversion
; 서비스 계정 JSON은 설치 후 매장에서 직접 복사 (GitHub/설치파일에 넣지 않음)

[Icons]
Name: "{group}\{#MyAppName} 수동 수집"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--manual"; WorkingDir: "{app}"
Name: "{autodesktop}\OKPOS 판매수집"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--manual"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\register_schedule.ps1"" -InstallDir ""{app}"""; StatusMsg: "자동 수집 일정을 등록하는 중..."; Tasks: autostart; Flags: runhidden waituntilterminated
Filename: "{app}\config.example.json"; Description: "설정 예시 파일 열기 (config.json 으로 저장하세요)"; Flags: postinstall shellexec skipifsilent

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ExampleFile, ConfigFile: string;
begin
  if CurStep = ssPostInstall then
  begin
    ExampleFile := ExpandConstant('{app}\config.example.json');
    ConfigFile := ExpandConstant('{app}\config.json');
    if not FileExists(ConfigFile) and FileExists(ExampleFile) then
      FileCopy(ExampleFile, ConfigFile, False);
  end;
end;
