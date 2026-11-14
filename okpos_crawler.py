import os
import sys
import glob
import json
import re
import time
import ctypes
import gspread
import pandas as pd
from datetime import datetime, timedelta
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
            with open(path, encoding="utf-8-sig") as f:
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

# 시트 스키마: 판매일자 | 판매시간(12시) | 상품명 | 수량
# 출처: OKPOS 매출관리 > 매출현황 > 상품별 > 시간대별 엑셀
POS_HEADERS = ["판매일자", "판매시간", "상품명", "수량"]
HOUR_LABEL_RE = re.compile(r"^(\d{1,2})\s*시$")


def sale_date_text(moment):
    return moment.strftime("%Y-%m-%d")


def hour_label_(hour):
    return f"{int(hour)}시"


def hour_from_label_(text):
    raw = str(text or "").strip()
    m = HOUR_LABEL_RE.match(raw)
    if m:
        return int(m.group(1))
    m2 = re.search(r"(\d{1,2})\s*시", raw)
    if m2:
        return int(m2.group(1))
    m3 = re.search(r"(\d{1,2}):\d{2}", raw)
    if m3:
        return int(m3.group(1))
    return None


def meal_from_hour_(hour):
    """~15시=lunch, 16시~=dinner."""
    if hour is None:
        return None
    return "lunch" if int(hour) <= 15 else "dinner"


def meal_slot_of_datetime(dt):
    if dt is None:
        return None
    return meal_from_hour_(dt.hour)


def parse_dt_(text):
    raw = str(text or "").strip()
    if not raw or raw in POS_HEADERS:
        return None
    if "~" in raw:
        return None
    hour = hour_from_label_(raw)
    if hour is not None and HOUR_LABEL_RE.match(raw):
        return None
    candidates = (
        (raw[:19], "%Y-%m-%d %H:%M:%S"),
        (raw[:16], "%Y-%m-%d %H:%M"),
        (raw[:10], "%Y-%m-%d"),
    )
    for chunk, fmt in candidates:
        try:
            return datetime.strptime(chunk, fmt)
        except ValueError:
            continue
    return None


def is_header_row_(row):
    if not row:
        return False
    joined = [str(c).strip() for c in row[:4]]
    return (
        "판매일자" in joined
        or "판매시간" in joined
        or "판매일시" in joined
        or joined[:3] == ["판매일시", "상품명", "수량"]
    )


def parse_pos_sheet_row_(row):
    """시트 한 줄 → {date, sold_at(판매시간), name, qty, meal, hour, stamp}."""
    if not row or is_header_row_(row):
        return None
    cells = [str(c).strip() if c is not None else "" for c in row]
    while cells and cells[-1] == "":
        cells.pop()
    if len(cells) < 3:
        return None

    # 현재: 판매일자 | 판매시간(12시) | 상품명 | 수량
    if len(cells) >= 4 and len(cells[0]) == 10 and cells[0][4] == "-" and cells[0][7] == "-":
        sale_date = cells[0]
        sold_at = cells[1]
        name = cells[2]
        qty_raw = cells[3]
    else:
        # 구형: 판매일시 | 상품명 | 수량
        stamp0 = cells[0]
        name = cells[1]
        qty_raw = cells[2]
        sold_at = stamp0
        sale_date = stamp0[:10] if len(stamp0) >= 10 else ""

    try:
        qty = int(float(str(qty_raw).replace(",", "").strip() or 0))
    except ValueError:
        qty = 0
    if not name:
        return None
    hour = hour_from_label_(sold_at)
    dt = parse_dt_(sold_at) or parse_dt_(sale_date)
    if hour is None and dt is not None:
        hour = dt.hour
        sold_at = hour_label_(hour)
    meal = meal_from_hour_(hour)
    day = (sale_date[:10] if sale_date else (dt.strftime("%Y-%m-%d") if dt else ""))
    return {
        "date": day,
        "sold_at": sold_at,
        "name": name,
        "qty": qty,
        "meal": meal,
        "hour": hour,
        "stamp": f"{day} {sold_at}".strip(),
    }


def ensure_pos_headers_(worksheet, existing_data):
    if not existing_data:
        worksheet.append_row(POS_HEADERS, value_input_option="USER_ENTERED")
        return [POS_HEADERS]
    if is_header_row_(existing_data[0]):
        head = [str(c).strip() for c in existing_data[0][:4]]
        if head != POS_HEADERS:
            worksheet.update("A1:D1", [POS_HEADERS], value_input_option="USER_ENTERED")
            existing_data[0] = POS_HEADERS
        return existing_data
    worksheet.insert_row(POS_HEADERS, 1, value_input_option="USER_ENTERED")
    return [POS_HEADERS] + existing_data


def build_hourly_rows_(sale_date, hourly_items):
    """hourly_items: [(hour_label, name, qty), ...] → 시트 행."""
    rows = []
    for hour_label, name, qty in hourly_items:
        q = int(qty)
        if q <= 0 or not name:
            continue
        rows.append([sale_date, str(hour_label), name, q])
    return rows


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


class OkposEmptyDayError(Exception):
    """해당일 매출 없음(휴무 등)."""


def clear_download_dir_():
    if not os.path.exists(DOWNLOAD_DIR):
        os.makedirs(DOWNLOAD_DIR)
    for f in glob.glob(os.path.join(DOWNLOAD_DIR, "*.xls*")):
        try:
            os.remove(f)
        except OSError:
            pass


def wait_download_(timeout=40):
    for _ in range(timeout):
        files = [
            f
            for f in glob.glob(os.path.join(DOWNLOAD_DIR, "*.xls*"))
            if not f.endswith(".crdownload")
        ]
        if files:
            return max(files, key=os.path.getctime)
        time.sleep(1)
    return None


def parse_hourly_excel_(path):
    """상품시간대별 엑셀 → [(12시, 상품명, 수량), ...]. 수량 0·소계/합계 제외."""
    raw = pd.read_excel(path, header=None)
    hour_row_idx = None
    for i in range(min(12, len(raw))):
        vals = [str(v).strip() if pd.notna(v) else "" for v in raw.iloc[i].tolist()]
        if any(HOUR_LABEL_RE.match(v) for v in vals) and "상품명" in vals:
            hour_row_idx = i
            break
    if hour_row_idx is None:
        raise RuntimeError("시간대별 엑셀에서 시(시간) 헤더를 찾지 못했습니다.")
    sub_idx = hour_row_idx + 1
    if sub_idx >= len(raw):
        raise RuntimeError("시간대별 엑셀 하위 헤더(수량/매출액)가 없습니다.")

    hour_cells = raw.iloc[hour_row_idx].tolist()
    sub_cells = raw.iloc[sub_idx].tolist()
    name_col = None
    for i, v in enumerate(hour_cells):
        if str(v).strip() == "상품명":
            name_col = i
            break
    if name_col is None:
        name_col = 1

    hour_qty_cols = []
    for i, v in enumerate(hour_cells):
        label = str(v).strip() if pd.notna(v) else ""
        m = HOUR_LABEL_RE.match(label)
        if not m:
            continue
        sub = str(sub_cells[i]).strip() if i < len(sub_cells) and pd.notna(sub_cells[i]) else ""
        # 시 헤더가 수량/매출액 쌍 → 수량 열만 사용
        if sub == "수량":
            hour_qty_cols.append((i, hour_label_(int(m.group(1)))))
    if not hour_qty_cols:
        raise RuntimeError("시간대별 엑셀에서 수량 열을 찾지 못했습니다.")

    out = []
    for _, row in raw.iloc[sub_idx + 1 :].iterrows():
        name = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""
        if not name or "소계" in name or "합계" in name:
            continue
        code = str(row[0]).strip() if pd.notna(row[0]) else ""
        if code in ("합계", "소계") or name in ("합계",):
            continue
        for ci, label in hour_qty_cols:
            if ci >= len(row):
                continue
            cell = row[ci]
            if pd.isna(cell) or cell == "":
                continue
            try:
                qty = int(float(str(cell).replace(",", "").strip()))
            except ValueError:
                continue
            if qty > 0:
                out.append((label, name, qty))
    return out


def click_in_frames_(driver, finder):
    """finder() → True 이면 성공. default + iframe/frame 2단 탐색.
    OkposEmptyDayError 는 삼키지 않고 그대로 올린다."""
    driver.switch_to.default_content()
    if finder():
        return True
    for f1 in driver.find_elements(By.XPATH, "//iframe | //frame"):
        driver.switch_to.default_content()
        try:
            driver.switch_to.frame(f1)
            if finder():
                return True
            for f2 in driver.find_elements(By.XPATH, "//iframe | //frame"):
                driver.switch_to.default_content()
                driver.switch_to.frame(f1)
                driver.switch_to.frame(f2)
                if finder():
                    return True
        except OkposEmptyDayError:
            raise
        except Exception:
            continue
    driver.switch_to.default_content()
    return False


def open_hourly_tab_(driver):
    xpaths = [
        "//*[normalize-space()='시간대별']",
        "//a[contains(normalize-space(),'시간대별')]",
        "//li[contains(normalize-space(),'시간대별')]",
        "//span[contains(normalize-space(),'시간대별')]",
        "//td[contains(normalize-space(),'시간대별')]",
    ]

    def try_click():
        for xp in xpaths:
            for el in driver.find_elements(By.XPATH, xp):
                try:
                    if el.is_displayed():
                        driver.execute_script("arguments[0].click();", el)
                        return True
                except Exception:
                    continue
        return False

    return click_in_frames_(driver, try_click)


def apply_okpos_dates_(driver, start_iso, end_iso):
    return driver.execute_script(
        """
        const start = arguments[0];
        const end = arguments[1];
        let startEl = document.getElementById('date1_1');
        let endEl = document.getElementById('date1_2');
        if (!startEl || !endEl) {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
          const dateInputs = inputs.filter(el => /date|일자|기간/i.test((el.id||'') + (el.name||'') + (el.className||''))
            || /^\\d{4}-\\d{2}-\\d{2}$/.test(String(el.value||'')));
          if (dateInputs.length >= 2) {
            startEl = dateInputs[0];
            endEl = dateInputs[1];
          }
        }
        if (!startEl || !endEl) return {ok: false, reason: 'no-date-inputs'};
        const write = (el, iso) => {
            el.removeAttribute('readonly');
            el.readOnly = false;
            el.disabled = false;
            el.value = iso;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            el.dispatchEvent(new Event('blur', {bubbles: true}));
        };
        write(startEl, start);
        write(endEl, end);
        return {ok: true, values: [startEl.value, endEl.value]};
        """,
        start_iso,
        end_iso,
    )


def dismiss_okpos_alerts_(driver, timeout=1.5):
    """매출 없음 등 알림 닫기. 알림 문구 반환(없으면 "")."""
    texts = []
    end = time.time() + timeout
    while time.time() < end:
        try:
            alert = driver.switch_to.alert
            msg = str(alert.text or "").strip()
            if msg:
                texts.append(msg)
            alert.accept()
            time.sleep(0.2)
        except Exception:
            break
    return " | ".join(texts)


def download_hourly_excel_for_day_(driver, sale_date):
    """시간대별 화면에서 하루 조회 → 엑셀 경로. 매출 없으면 OkposEmptyDayError."""
    clear_download_dir_()
    dismiss_okpos_alerts_(driver, 0.5)

    def try_search_excel():
        search_buttons = driver.find_elements(By.XPATH, "//button[contains(text(), '조회')]")
        if not search_buttons:
            # button 외 a/span 조회
            search_buttons = driver.find_elements(
                By.XPATH, "//*[self::button or self::a or self::span][contains(normalize-space(),'조회')]"
            )
        if not search_buttons:
            return False
        applied = apply_okpos_dates_(driver, sale_date, sale_date)
        if not applied or not applied.get("ok"):
            return False
        driver.execute_script("arguments[0].click();", search_buttons[0])
        time.sleep(5)
        alert_msg = dismiss_okpos_alerts_(driver, 1.0)
        if "자료가 없" in alert_msg or "없습니다" in alert_msg:
            raise OkposEmptyDayError(alert_msg or "자료 없음")
        excel_btn = driver.find_elements(By.XPATH, "//button[contains(text(), '엑셀')]")
        if not excel_btn:
            excel_btn = driver.find_elements(
                By.XPATH, "//*[self::button or self::a or self::span][contains(normalize-space(),'엑셀')]"
            )
        if not excel_btn:
            # 조회는 됐는데 엑셀만 없음 → 자료 없음으로 간주
            raise OkposEmptyDayError("엑셀 버튼 없음(자료 없을 수 있음)")
        driver.execute_script("arguments[0].click();", excel_btn[0])
        time.sleep(0.8)
        alert_msg = dismiss_okpos_alerts_(driver, 1.5)
        if "자료가 없" in alert_msg or "출력할 자료" in alert_msg:
            raise OkposEmptyDayError(alert_msg or "엑셀 자료 없음")
        return True

    try:
        ok = click_in_frames_(driver, try_search_excel)
    except OkposEmptyDayError:
        raise
    except Exception as exc:
        alert_msg = dismiss_okpos_alerts_(driver, 1.0)
        if "자료가 없" in alert_msg or "출력할 자료" in str(exc) or "자료가 없" in str(exc):
            raise OkposEmptyDayError(alert_msg or str(exc)) from exc
        raise
    if not ok:
        alert_msg = dismiss_okpos_alerts_(driver, 1.0)
        if "자료가 없" in alert_msg:
            raise OkposEmptyDayError(alert_msg)
        raise RuntimeError(f"OKPOS 조회/엑셀 버튼을 찾지 못했습니다 ({sale_date})")
    path = wait_download_(30)
    if not path:
        alert_msg = dismiss_okpos_alerts_(driver, 1.0)
        if "자료가 없" in alert_msg:
            raise OkposEmptyDayError(alert_msg)
        # 한 번 더 재시도
        clear_download_dir_()
        try:
            click_in_frames_(driver, try_search_excel)
        except OkposEmptyDayError:
            raise
        path = wait_download_(25)
        if not path:
            raise RuntimeError(f"엑셀 다운로드 실패 ({sale_date})")
    return path


def sync_state_path_():
    return os.path.join(app_dir(), "pos_sync_state.json")


def days_to_sync_(moment, period):
    """오늘 첫 수집이면 최근 3일, 아니면 오늘만. period=month 이면 1일~오늘."""
    today = moment.date()
    if period == "month":
        start = today.replace(day=1)
        out = []
        cur = start
        while cur <= today:
            out.append(cur.strftime("%Y-%m-%d"))
            cur += timedelta(days=1)
        return out, True

    state_path = sync_state_path_()
    first_today = True
    try:
        with open(state_path, encoding="utf-8") as f:
            data = json.load(f)
        if str(data.get("last_sync_day") or "") == today.strftime("%Y-%m-%d"):
            first_today = False
    except Exception:
        first_today = True

    if first_today:
        days = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in (2, 1, 0)]
    else:
        days = [today.strftime("%Y-%m-%d")]
    return days, first_today


def mark_sync_day_(moment):
    path = sync_state_path_()
    payload = {
        "last_sync_day": moment.strftime("%Y-%m-%d"),
        "updated_at": moment.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "hourly",
    }
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"동기화 상태 저장 실패: {e}")


def replace_sheet_dates_(worksheet, dates, new_rows):
    """지정 일자 행 삭제 후 new_rows append. dates: set/list of YYYY-MM-DD."""
    date_set = {str(d)[:10] for d in dates}
    existing = worksheet.get_all_values()
    existing = ensure_pos_headers_(worksheet, existing)
    to_delete = []
    for i, row in enumerate(existing):
        if i == 0:
            continue
        parsed = parse_pos_sheet_row_(row)
        day = (parsed or {}).get("date", "")[:10]
        if day in date_set:
            to_delete.append(i + 1)
    if to_delete:
        print(f"기존 {sorted(date_set)} 데이터 {len(to_delete)}줄 삭제")
        delete_numbered_rows(worksheet, to_delete)
    if new_rows:
        worksheet.append_rows(new_rows, value_input_option="USER_ENTERED")
        print(f"신규 {len(new_rows)}줄 추가")
    return len(to_delete), len(new_rows or [])


def main(show_dialog=True, period="today"):
    global outcome
    outcome = {"text": None, "error": False, "shown": False}
    run_crawler(show_dialog, period=period)
    return dict(outcome)


# --- 기본 설정 ---
BASE_DIR = app_dir()
JSON_FILE = os.path.join(BASE_DIR, "okpos-inventory-39f09512d81f.json")
SHEET_URL = "https://docs.google.com/spreadsheets/d/1JY9OGCLp0KlnilDdW3Oyl4vcSogRCMTmQyFsQeA2Gqg/edit?gid=0#gid=0"
SHEET_NAME = "pos판매내역"
DOWNLOAD_DIR = os.path.join(BASE_DIR, "pos_excel_data")


def run_crawler(show_dialog=True, period="today"):
    load_local_secrets()
    if period not in ("today", "month"):
        period = "today"
    driver = None
    clear_download_dir_()

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

    try:
        print("크롬을 여는 중...")
        options = webdriver.ChromeOptions()
        options.add_argument("--headless=new")
        options.add_argument("--disable-gpu")
        options.add_argument("--window-size=1920,1080")
        options.add_experimental_option(
            "prefs",
            {
                "download.default_directory": DOWNLOAD_DIR,
                "download.prompt_for_download": False,
                "download.directory_upgrade": True,
                "safebrowsing.enabled": True,
            },
        )
        service = Service(ChromeDriverManager().install())
        service.creation_flags = 0x08000000
        driver = webdriver.Chrome(service=service, options=options)
        try:
            driver.execute_cdp_cmd(
                "Browser.setDownloadBehavior",
                {"behavior": "allow", "downloadPath": DOWNLOAD_DIR, "eventsEnabled": True},
            )
        except Exception:
            pass

        driver.get("https://okasp.okpos.co.kr/login/login_form.jsp")
        wait = WebDriverWait(driver, 15)
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
        except Exception:
            driver.find_element(By.XPATH, "//input[@type='password']").submit()
        time.sleep(3)
        try:
            WebDriverWait(driver, 3).until(EC.alert_is_present()).accept()
        except Exception:
            pass
        try:
            for btn in driver.find_elements(By.XPATH, "//*[contains(text(), '하루동안 창 열리지 않음')]"):
                if btn.is_displayed():
                    btn.click()
                    time.sleep(0.5)
            for btn in driver.find_elements(By.XPATH, "//*[contains(text(), '닫기')]"):
                if btn.is_displayed():
                    btn.click()
                    time.sleep(0.5)
            driver.execute_script(
                "document.querySelectorAll('[id^=\"divPopupBackground\"]').forEach(el => el.style.display='none');"
            )
        except Exception:
            pass
        time.sleep(2)

        print("메뉴 이동 중... (매출관리 > 매출현황 > 상품별 > 시간대별)")
        driver.execute_script(
            "arguments[0].click();",
            wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '매출관리')]"))),
        )
        time.sleep(1)
        ActionChains(driver).move_to_element(
            wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '매출현황')]")))
        ).perform()
        time.sleep(1)
        driver.execute_script(
            "arguments[0].click();",
            wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '상품별')]"))),
        )
        time.sleep(3)
        if not open_hourly_tab_(driver):
            raise RuntimeError("OKPOS '시간대별' 탭을 찾지 못했습니다.")
        time.sleep(2)
        print("시간대별 탭 진입 완료")

        moment = datetime.now()
        days, first_today = days_to_sync_(moment, period)
        print(f"수집 일자: {', '.join(days)}" + (" (오늘 첫 수집→최근 3일)" if first_today and period == "today" else ""))

        all_rows = []
        ok_days = 0
        fail_days = 0
        for sale_date in days:
            print(f"조회 중: {sale_date}")
            try:
                path = download_hourly_excel_for_day_(driver, sale_date)
                items = parse_hourly_excel_(path)
                day_rows = build_hourly_rows_(sale_date, items)
                all_rows.extend(day_rows)
                ok_days += 1
                print(f"  → {len(day_rows)}행 (상품×시간)")
            except Exception as exc:
                fail_days += 1
                print(f"  → 실패: {exc}")
                log_error(f"시간대별 수집 실패 {sale_date}: {exc}")

        if ok_days == 0:
            finish("엑셀 수집에 모두 실패했습니다. okpos_crawler.log 를 확인하세요.", error=True)
            return

        deleted, inserted = replace_sheet_dates_(worksheet, days, all_rows)
        mark_sync_day_(moment)
        finish(
            "완료되었습니다.\n"
            f"시간대별 판매 {inserted}행을 반영했습니다.\n"
            f"대상일 {ok_days}일 성공 / {fail_days}일 실패 · 기존 {deleted}행 교체.\n"
            f"기간: {days[0]} ~ {days[-1]}"
        )

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
