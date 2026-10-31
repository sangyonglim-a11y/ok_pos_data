import os
import sys
import glob
import time
import ctypes
import gspread
import pandas as pd
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from webdriver_manager.chrome import ChromeDriverManager
import selenium.webdriver.chrome.options
import selenium.webdriver.chrome.webdriver
import selenium.webdriver.chrome.service

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

def app_dir():
    # exe로 실행하면 exe가 있는 폴더, py로 실행하면 현재 작업 폴더
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.getcwd()


def load_local_secrets():
    """agent/config.json 또는 실행 폴더 config.json 에서 로그인·시트 설정을 읽는다."""
    candidates = [
        os.path.join(app_dir(), "config.json"),
        os.path.join(app_dir(), "agent", "config.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent", "config.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
    ]
    for path in candidates:
        if not os.path.isfile(path):
            continue
        try:
            import json
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if data.get("okpos_id") and not os.environ.get("OKPOS_ID"):
            os.environ["OKPOS_ID"] = str(data["okpos_id"])
        if data.get("okpos_password") and not os.environ.get("OKPOS_PASSWORD"):
            os.environ["OKPOS_PASSWORD"] = str(data["okpos_password"])
        if data.get("sheet_url"):
            globals()["SHEET_URL"] = data["sheet_url"]
        sa = data.get("service_account_file")
        if sa:
            sa_path = sa if os.path.isabs(sa) else os.path.join(os.path.dirname(path), sa)
            if not os.path.isfile(sa_path):
                sa_path = os.path.join(app_dir(), os.path.basename(sa))
            if os.path.isfile(sa_path):
                globals()["JSON_FILE"] = sa_path
        break

def log_error(text):
    print(text)
    try:
        with open(os.path.join(app_dir(), "okpos_crawler.log"), "a", encoding="utf-8") as f:
            f.write(f"\n[{datetime.now():%Y-%m-%d %H:%M:%S}]\n{text}\n")
    except Exception:
        pass

def show_message(text, error=False):
    # 확인 버튼이 있는 안내 창. 작업 중에는 창을 띄우지 않는다.
    title = "OKPOS 연동 실패" if error else "OKPOS 연동 완료"
    flags = 0x00001000 | 0x00010000  # 항상 앞에 표시, 확인 버튼
    flags |= 0x00000010 if error else 0x00000040
    try:
        ctypes.windll.user32.MessageBoxW(0, str(text), title, flags)
    except Exception:
        print(text)

outcome = {"text": None, "error": False, "shown": False}

def finish(text, error=False):
    outcome["text"] = text
    outcome["error"] = error
    log_error(text)

def show_finish():
    if outcome["text"] and not outcome["shown"]:
        outcome["shown"] = True
        show_message(outcome["text"], outcome["error"])

def handle_crash(exc_type, exc, tb):
    import traceback
    text = "".join(traceback.format_exception(exc_type, exc, tb))
    log_error(text)
    show_message("실행 중 오류가 났습니다.\n자세한 내용은 okpos_crawler.log 파일을 확인하세요.", error=True)

def sales_stamp(period, moment):
    today = moment.strftime("%Y-%m-%d")
    if period == "month":
        start = moment.replace(day=1).strftime("%Y-%m-%d")
        return f"{start}~{today}"
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def row_in_replace_range(cell, period, moment):
    text = str(cell or "")
    today = moment.strftime("%Y-%m-%d")
    if period == "month":
        return text.startswith(moment.strftime("%Y-%m"))
    return text == today or text.startswith(today + " ")


def month_snapshot_covers_today(cell, moment):
    text = str(cell or "")
    if "~" not in text:
        return False
    start, end = text.split("~", 1)
    today = moment.strftime("%Y-%m-%d")
    return len(start) >= 10 and len(end) >= 10 and start[:10] <= today <= end[:10]


def delete_numbered_rows(worksheet, numbers):
    if not numbers:
        return
    ordered = sorted(set(numbers))
    ranges = []
    start = previous = ordered[0]
    for number in ordered[1:]:
        if number == previous + 1:
            previous = number
            continue
        ranges.append((start, previous))
        start = previous = number
    ranges.append((start, previous))
    for start, end in reversed(ranges):
        worksheet.delete_rows(start, end)


def main(show_dialog=True, period="today"):
    global outcome
    outcome = {"text": None, "error": False, "shown": False}
    run_crawler(show_dialog, period=period)
    return dict(outcome)

# --- 1. 기본 설정 및 엑셀 다운로드 폴더 준비 ---
BASE_DIR = app_dir()
JSON_FILE = os.path.join(BASE_DIR, "okpos-inventory-39f09512d81f.json")
SHEET_URL = "https://docs.google.com/spreadsheets/d/1JY9OGCLp0KlnilDdW3Oyl4vcSogRCMTmQyFsQeA2Gqg/edit?gid=0#gid=0"
SHEET_NAME = "pos판매내역"

# 엑셀 파일을 다운받을 전용 폴더 생성
DOWNLOAD_DIR = os.path.join(BASE_DIR, "pos_excel_data")

def run_crawler(show_dialog=True, period="today"):
    load_local_secrets()
    if period not in ("today", "month"):
        period = "today"
    driver = None
    if not os.path.exists(DOWNLOAD_DIR):
        os.makedirs(DOWNLOAD_DIR)

    # 이전 다운로드 파일이 남아있다면 충돌 방지를 위해 싹 지우기
    for f in glob.glob(os.path.join(DOWNLOAD_DIR, "*.xls*")):
        try: os.remove(f)
        except: pass

    print("구글 시트 접근 권한 확인 중...")
    try:
        gc = gspread.service_account(filename=JSON_FILE)
        worksheet = gc.open_by_url(SHEET_URL).worksheet(SHEET_NAME)
        print("구글 시트 연동 성공!\n")
    except Exception as e:
        print(f"구글 시트 연동 실패: {e}")
        finish(f"구글 시트 연동에 실패했습니다.\n{e}", error=True)
        if show_dialog:
            show_finish()
        return

    # --- 2. 셀레니움 크롤링 (엑셀 다운로드 옵션 추가) ---
    driver = None
    try:
        print("크롬을 여는 중...")
        options = webdriver.ChromeOptions()
        options.add_argument("--headless=new")
        options.add_argument("--disable-gpu")
        options.add_argument("--window-size=1920,1080")

        # 크롬 브라우저가 지정한 폴더로 엑셀을 묻지 않고 자동 다운로드하도록 설정
        prefs = {
            "download.default_directory": DOWNLOAD_DIR,
            "download.prompt_for_download": False,
            "download.directory_upgrade": True,
            "safebrowsing.enabled": True
        }
        options.add_experimental_option("prefs", prefs)

        service = Service(ChromeDriverManager().install())
        service.creation_flags = 0x08000000  # 크롬 드라이버 콘솔 창을 띄우지 않음
        driver = webdriver.Chrome(service=service, options=options)
        try:
            driver.execute_cdp_cmd("Browser.setDownloadBehavior", {
                "behavior": "allow",
                "downloadPath": DOWNLOAD_DIR,
                "eventsEnabled": True,
            })
        except Exception:
            pass
        driver.get("https://okasp.okpos.co.kr/login/login_form.jsp")
        wait = WebDriverWait(driver, 10)
        
        okpos_id = os.environ.get("OKPOS_ID", "").strip()
        okpos_password = os.environ.get("OKPOS_PASSWORD", "").strip()
        if not okpos_id or not okpos_password:
            finish(
                "OKPOS 로그인 정보가 없습니다.\n"
                "agent/config.json 에 okpos_id, okpos_password 를 넣거나\n"
                "환경변수 OKPOS_ID / OKPOS_PASSWORD 를 설정하세요.",
                error=True,
            )
            if show_dialog:
                show_finish()
            return
        wait.until(EC.presence_of_element_located((By.XPATH, "//input[@type='text']"))).send_keys(okpos_id)
        driver.find_element(By.XPATH, "//input[@type='password']").send_keys(okpos_password) 
        
        try:
            driver.find_element(By.XPATH, "//*[contains(text(), '로그인') and not(contains(text(), '자동'))]").click()
        except:
            driver.find_element(By.XPATH, "//input[@type='password']").submit()
        time.sleep(3)
        
        try:
            WebDriverWait(driver, 3).until(EC.alert_is_present()).accept()
        except:
            pass 

        try:
            for btn in driver.find_elements(By.XPATH, "//*[contains(text(), '하루동안 창 열리지 않음')]"):
                if btn.is_displayed(): btn.click(); time.sleep(0.5)
            for btn in driver.find_elements(By.XPATH, "//*[contains(text(), '닫기')]"):
                if btn.is_displayed(): btn.click(); time.sleep(0.5)
            driver.execute_script("document.querySelectorAll('[id^=\"divPopupBackground\"]').forEach(el => el.style.display='none');")
        except:
            pass
        time.sleep(2)

        # 메뉴 이동
        print("메뉴 이동 중...")
        driver.execute_script("arguments[0].click();", wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '매출관리')]"))))
        time.sleep(1)
        ActionChains(driver).move_to_element(wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '매출현황')]")))).perform()
        time.sleep(1)
        driver.execute_script("arguments[0].click();", wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '상품별')]"))))
        time.sleep(3)

        # 프레임 탐색 후 '조회' 및 '엑셀' 버튼 클릭
        print("데이터를 조회하고 엑셀 파일을 다운로드합니다...")
        def apply_period():
            if period != "month":
                return
            start = datetime.now().replace(day=1).strftime("%Y-%m-%d")
            end = datetime.now().strftime("%Y-%m-%d")
            applied = driver.execute_script("""
                const start = arguments[0];
                const end = arguments[1];
                const startEl = document.getElementById('date1_1');
                const endEl = document.getElementById('date1_2');
                if (!startEl || !endEl) return {ok: false};
                const write = (el, iso) => {
                    el.removeAttribute('readonly');
                    el.readOnly = false;
                    el.value = iso;
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                };
                write(startEl, start);
                write(endEl, end);
                return {ok: true, values: [startEl.value, endEl.value]};
            """, start, end)
            print(f"조회 기간을 {start} ~ {end} 로 맞췄습니다. {applied}")
            if not applied or not applied.get("ok"):
                raise RuntimeError("이번 달 조회 기간을 화면에서 바꾸지 못했습니다.")

        def click_search_and_excel(search_buttons):
            apply_period()
            driver.execute_script("arguments[0].click();", search_buttons[0])
            time.sleep(8 if period == "month" else 4)
            excel_btn = driver.find_elements(By.XPATH, "//button[contains(text(), '엑셀')]")
            if excel_btn:
                driver.execute_script("arguments[0].click();", excel_btn[0])
                print("엑셀 버튼 클릭 성공")
                return True
            return False

        def click_buttons_in_frames():
            driver.switch_to.default_content()
            for f1 in driver.find_elements(By.XPATH, "//iframe | //frame"):
                driver.switch_to.default_content()
                try:
                    driver.switch_to.frame(f1)
                    search_buttons = driver.find_elements(By.XPATH, "//button[contains(text(), '조회')]")
                    if search_buttons and click_search_and_excel(search_buttons):
                        return True
                    for f2 in driver.find_elements(By.XPATH, "//iframe | //frame"):
                        driver.switch_to.default_content()
                        driver.switch_to.frame(f1)
                        driver.switch_to.frame(f2)
                        search_buttons = driver.find_elements(By.XPATH, "//button[contains(text(), '조회')]")
                        if search_buttons and click_search_and_excel(search_buttons):
                            return True
                except RuntimeError:
                    raise
                except Exception:
                    continue
            return False

        click_buttons_in_frames()

        # 엑셀 파일이 폴더에 완전히 다운로드될 때까지 대기. 이번 달은 건수가 많아 더 기다린다.
        downloaded_file = None
        for _ in range(40 if period == "month" else 15):
            files = glob.glob(os.path.join(DOWNLOAD_DIR, "*.xls*"))
            # .crdownload (다운로드 중인 임시 파일) 제외
            valid_files = [f for f in files if not f.endswith('.crdownload')]
            if valid_files:
                downloaded_file = max(valid_files, key=os.path.getctime)
                break
            time.sleep(1)

        if not downloaded_file:
            print("엑셀 파일 다운로드에 실패했습니다.")
            finish("엑셀 파일 다운로드에 실패했습니다.", error=True)
            return

        print(f"엑셀 파일 다운로드 완료! 데이터 추출을 시작합니다.")

        # --- 3. 엑셀 파일 읽기 및 데이터 정제 (Pandas 활용) ---
        # 먼저 파일을 읽어서 '상품명'이 있는 진짜 헤더(제목) 줄 위치를 찾음
        df_temp = pd.read_excel(downloaded_file)
        header_idx = df_temp[df_temp.eq('상품명').any(axis=1)].index[0]
        
        # 진짜 제목 줄을 기준으로 다시 깔끔하게 읽기
        df = pd.read_excel(downloaded_file, header=header_idx+1)
        
        # 상품명과 No.가 없는 빈 줄, 합계 줄 등 불필요한 데이터 제거
        df_items = df.dropna(subset=['상품명', 'No.'])
        df_items = df_items[~df_items['No.'].astype(str).str.contains('합계')]

        moment = datetime.now()
        current_time = sales_stamp(period, moment)
        data_to_insert = []
        
        for index, row in df_items.iterrows():
            name = str(row['상품명']).strip()
            qty = str(row['수량']).replace(',', '').strip()
            
            if qty.isdigit():
                data_to_insert.append([current_time, name, int(qty)])

        print(f"총 {len(data_to_insert)}건의 고유 데이터를 완벽하게 추출했습니다.")

        # --- 4. 구글 시트 갱신. 당일은 오늘만, 이번 달은 이번 달 기록을 합계로 바꾼다. ---
        if data_to_insert:
            existing_data = worksheet.get_all_values()
            if period == "today" and any(month_snapshot_covers_today(row[0], moment) for row in existing_data if row):
                finish(
                    "이번 달 1일부터 오늘까지 합계가 이미 들어 있습니다.\n"
                    "오늘만 추가하면 수량이 두 번 들어갑니다.\n"
                    "다시 맞추려면 '이번 달'을 선택해 주세요."
                )
                return
            label = "이번 달" if period == "month" else "오늘"
            print(f"구글 시트의 기존 {label} 데이터를 확인 중입니다...")
            rows_to_delete = [
                i + 1 for i, row in enumerate(existing_data)
                if row and row_in_replace_range(row[0], period, moment)
            ]
            if rows_to_delete:
                print(f"기존 {label} 데이터 {len(rows_to_delete)}줄을 지우고 최신본으로 갱신합니다.")
                delete_numbered_rows(worksheet, rows_to_delete)
            
            worksheet.append_rows(data_to_insert)
            print(f"성공! 구글 시트 '{SHEET_NAME}' 탭에 {len(data_to_insert)}개의 전체 항목 업데이트가 완료되었습니다.")
            if period == "month":
                finish(
                    f"완료되었습니다.\n이번 달 1일부터 오늘까지 판매 {len(data_to_insert)}개를 반영했습니다.\n"
                    "이번 달에 있던 기존 판매 기록은 이 합계로 바꿨습니다."
                )
            else:
                finish(f"완료되었습니다.\n오늘 판매 {len(data_to_insert)}개를 구글 시트 '{SHEET_NAME}'에 반영했습니다.")
        else:
            finish("완료되었습니다.\n저장할 판매 데이터가 없습니다.")

    except Exception as e:
        import traceback
        log_error("에러 발생: " + "".join(traceback.format_exception(e)))
        finish(f"실행 중 오류가 났습니다.\n{e}\n\n자세한 내용은 okpos_crawler.log 파일을 확인하세요.", error=True)
    finally:
        try:
            driver.quit()
        except Exception:
            pass
        if show_dialog:
            show_finish()

if __name__ == "__main__":
    sys.excepthook = handle_crash
    main(show_dialog=True)
