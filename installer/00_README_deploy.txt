매장 PC 업데이트/설치 (v1.1.1 — POS + 날씨 + 23시 강제종료)
================================================
[이미 설치되어 돌고 있는 PC — 업데이트]
1) OkposAgentSetup.exe 실행 (덮어쓰기 설치)
2) 설치 옵션에서 '자동 수집 등록' 체크 유지
3) 끝나면 설치 폴더의 config.json 확인
   - business_hours start=11:00 end=23:00
   - weather_api_key
   (없으면 02_store_secrets_first_time\config.json 덮어쓰기)
4) 바탕화면 'OKPOS 판매수집' 한 번 실행
5) 작업 스케줄러에 다음 3개 확인
   - 중계고기파티_OKPOS수집 (30분)
   - 중계고기파티_일별날씨 (11:40, 19:10)
   - 중계고기파티_매장PC강제종료 (매일 23:00, 강제 종료)

[처음 설치]
1) OkposAgentSetup.exe 실행
2) 열린 폴더에 [02_store_secrets_first_time] 파일 전부 복사
   대상: %LOCALAPPDATA%\OkposAgent
3) 위 4)~5) 동일

주의
- 23:00 강제종료는 저장 안 된 작업도 끊깁니다. 마감 전 문서는 저장하세요.
- 강제종료가 안 되면 설치 폴더에서 PowerShell(관리자)로:
  .\register_schedule.ps1
- 02_store_secrets 폴더는 비밀정보. 공개 채팅에 올리지 마세요.
