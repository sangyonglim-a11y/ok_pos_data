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
    sys.exit()

# 2. 실행용 배치 파일(.bat) 생성
bat_path = os.path.join(current_dir, "run_okpos_test.bat")
with open(bat_path, "w", encoding="euc-kr") as f:
    f.write("@echo off\n")
    f.write(f"cd /d \"{current_dir}\"\n")
    f.write(f"\"{python_exe}\" \"{script_name}\"\n")

# 3. 윈도우 작업 스케줄러 등록 (10분 간격)
task_name = "OKPOS_Crawler_1Min_Test"

# /sc minute: 분 단위 스케줄
# /mo 1: 10분마다 반복 실행
# /f: 기존 동일한 이름의 작업이 있으면 덮어쓰기
cmd = f'schtasks /create /tn "{task_name}" /tr "\"{bat_path}\"" /sc minute /mo 10 /f'

print("=== 포스기 10분 단위 자동화 테스트 등록 ===")
result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='cp949')

# 4. 결과 및 종료 안내 출력
if result.returncode == 0:
    print(f"\n🎉 성공적으로 등록되었습니다!")
    print(f"지금부터 10분마다 파이썬이 스스로 엑셀을 받고 구글 시트를 업데이트합니다.")
    print("\n=======================================================")
    print("⚠️ [중요] 구글 시트 과부하 방지를 위해 테스트가 끝나면 반드시 지워주세요!")
    print("스케줄러를 정지(삭제)하려면, 명령 프롬프트에 아래 명령어를 복사해서 치세요:")
    print(f'schtasks /delete /tn "{task_name}" /f')
    print("=======================================================")
else:
    print(f"\n❌ 등록 실패. 반드시 명령 프롬프트를 '관리자 권한'으로 실행해 주세요.")
    print(f"에러 상세: {result.stderr}")