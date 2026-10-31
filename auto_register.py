import os
import sys
import subprocess

# 1. 경로 자동 파악
current_dir = os.getcwd()
python_exe = sys.executable
script_name = "okpos_crawler.py"
script_path = os.path.join(current_dir, script_name)

if not os.path.exists(script_path):
    print(f"❌ 오류: '{script_name}' 파일을 찾을 수 없습니다.")
    print("크롤링 코드가 있는 폴더에서 이 등록 스크립트를 실행해 주세요.")
    sys.exit()

# 2. 실행용 배치 파일(.bat) 자동 생성 (경로 꼬임 방지)
bat_path = os.path.join(current_dir, "run_okpos.bat")
with open(bat_path, "w", encoding="euc-kr") as f:
    f.write("@echo off\n")
    f.write(f"cd /d \"{current_dir}\"\n")
    f.write(f"\"{python_exe}\" \"{script_name}\"\n")

# 3. 윈도우 작업 스케줄러 등록 (11시~22시, 30분 간격)
task_name = "OKPOS_Daily_Crawler_30min"

# /sc daily: 매일 실행
# /st 11:00: 오전 11시에 시작
# /ri 30: 30분 간격으로 반복 (Repeat Interval)
# /du 11:00: 11시간 동안 유지 (11시 + 11시간 = 밤 10시 종료)
cmd = f'schtasks /create /tn "{task_name}" /tr "\"{bat_path}\"" /sc daily /st 11:00 /ri 30 /du 11:00 /f'

print("=== 포스기 자동화 스케줄러 등록 (영업시간 30분 간격) ===")
print("매일 11:00 ~ 22:00 동안 30분마다 실행되도록 등록합니다...")
result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='cp949')

# 4. 결과 출력
if result.returncode == 0:
    print(f"\n🎉 성공적으로 등록되었습니다!")
    print("이제 포스기(PC)가 켜져 있으면 매일 11시부터 22시까지 30분마다 구글 시트가 갱신됩니다.")
else:
    print(f"\n❌ 등록 실패. 명령 프롬프트(cmd)를 '관리자 권한'으로 실행한 뒤 다시 시도해 주세요.")
    print(f"에러 상세: {result.stderr}")