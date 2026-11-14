# -*- coding: utf-8 -*-
"""
1회성 백필 스크립트
- POS: OKPOS 상품별 매출을 D-1 ~ D-90 일자별로 수집 → pos판매내역
- 날씨: 기상청 ASOS 시간자료(서울 108, 노원 인근) → 일별날씨

사용 예:
  python backfill_data.py
  python backfill_data.py --weather-only
  python backfill_data.py --pos-only --days 90
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import unquote

import gspread
import pandas as pd
import requests
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager

import okpos_crawler as oc

# =============================================================================
# [필수] 공공데이터포털 일반 인증키 (Decoding 키 권장)
# 발급: https://www.data.go.kr → 기상청_지상(종관, ASOS) 시간자료 조회서비스 활용신청
# 환경변수 WEATHER_API_KEY 가 있으면 그 값을 우선 사용합니다.
# =============================================================================
WEATHER_API_KEY = "415631e6c49fc56cd765273478ebe4ef5d8f0c749be4461d5eaf29dd41697ce1"

# ASOS 지점: 108=서울(종관). 노원구 중계본동 인근 대표 관측소.
# (노원 AWS 407 은 공공데이터 ASOS API 지점이 아니므로 서울 ASOS 사용)
ASOS_STN_ID = "108"
ASOS_URL = "https://apis.data.go.kr/1360000/AsosHourlyInfoService/getWthrDataList"

POS_SHEET_NAME = "pos판매내역"
WEATHER_SHEET_NAME = "일별날씨"
WEATHER_HEADERS = ["일자", "오전_날씨", "오전_기온", "오후_날씨", "오후_기온"]

# 이미 시트에 있는 날짜는 건너뜀(재실행 안전). False 면 해당 기간을 지우고 다시 넣음.
SKIP_EXISTING_DATES = True
POS_APPEND_CHUNK = 400
REQUEST_SLEEP_SEC = 0.35


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def weather_api_key_() -> str:
    return (os.environ.get("WEATHER_API_KEY") or WEATHER_API_KEY or "").strip()


def open_spreadsheet_():
    oc.load_local_secrets()
    gc = gspread.service_account(filename=oc.JSON_FILE)
    return gc.open_by_url(oc.SHEET_URL)


def ensure_worksheet_(ss, title: str, headers: list[str]):
    try:
        ws = ss.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = ss.add_worksheet(title=title, rows=2000, cols=max(8, len(headers)))
        ws.append_row(headers, value_input_option="USER_ENTERED")
        return ws
    values = ws.get_all_values()
    if not values:
        ws.append_row(headers, value_input_option="USER_ENTERED")
    elif [str(c).strip() for c in values[0][: len(headers)]] != headers:
        ws.update("A1", [headers], value_input_option="USER_ENTERED")
    return ws


def date_range_backfill_(days: int) -> list[datetime]:
    """어제(D-1)부터 days일 전까지 (오래된 날 → 최근 날)."""
    end = datetime.now().date() - timedelta(days=1)
    start = end - timedelta(days=days - 1)
    out = []
    cur = start
    while cur <= end:
        out.append(datetime(cur.year, cur.month, cur.day))
        cur += timedelta(days=1)
    return out


def existing_pos_dates_(ws) -> set[str]:
    dates = set()
    for row in ws.get_all_values()[1:]:
        parsed = oc.parse_pos_sheet_row_(row)
        if parsed and parsed.get("date"):
            dates.add(str(parsed["date"])[:10])
    return dates


def existing_weather_dates_(ws) -> set[str]:
    dates = set()
    for row in ws.get_all_values()[1:]:
        if not row:
            continue
        d = str(row[0]).strip()[:10]
        if len(d) == 10 and d[4] == "-":
            dates.add(d)
    return dates


def delete_sheet_dates_(ws, dates: set[str], kind: str) -> int:
    """지정 일자의 행만 삭제. 전체 clear 금지."""
    if not dates:
        return 0
    values = ws.get_all_values()
    to_delete = []
    for i, row in enumerate(values):
        if i == 0:
            continue
        if kind == "pos":
            parsed = oc.parse_pos_sheet_row_(row)
            day = (parsed or {}).get("date", "")[:10]
        else:
            day = str(row[0]).strip()[:10] if row else ""
        if day in dates:
            to_delete.append(i + 1)
    if to_delete:
        oc.delete_numbered_rows(ws, to_delete)
    return len(to_delete)


def bulk_append_(ws, rows: list[list], chunk: int = POS_APPEND_CHUNK) -> int:
    if not rows:
        return 0
    total = 0
    for i in range(0, len(rows), chunk):
        part = rows[i : i + chunk]
        ws.append_rows(part, value_input_option="USER_ENTERED")
        total += len(part)
        log(f"  시트 append {total}/{len(rows)}")
        time.sleep(0.5)
    return total


# ---------------------------------------------------------------------------
# POS 백필
# ---------------------------------------------------------------------------
def parse_okpos_excel_(path: str) -> list[tuple[str, int]]:
    df_temp = pd.read_excel(path)
    hits = df_temp[df_temp.eq("상품명").any(axis=1)]
    if hits.empty:
        return []
    header_idx = hits.index[0]
    df = pd.read_excel(path, header=header_idx + 1)
    items = df.dropna(subset=["상품명", "No."])
    items = items[~items["No."].astype(str).str.contains("합계")]
    out = []
    for _, row in items.iterrows():
        name = str(row["상품명"]).strip()
        qty = str(row["수량"]).replace(",", "").strip()
        if name and qty.isdigit():
            out.append((name, int(qty)))
    return out


def apply_okpos_dates_(driver, start_iso: str, end_iso: str) -> None:
    applied = driver.execute_script(
        """
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
        """,
        start_iso,
        end_iso,
    )
    if not applied or not applied.get("ok"):
        raise RuntimeError(f"OKPOS 조회 기간을 설정하지 못했습니다: {start_iso} ~ {end_iso}")


def clear_download_dir_() -> None:
    for f in glob.glob(os.path.join(oc.DOWNLOAD_DIR, "*.xls*")):
        try:
            os.remove(f)
        except OSError:
            pass


def wait_download_(timeout: int = 40) -> str | None:
    for _ in range(timeout):
        files = [
            f
            for f in glob.glob(os.path.join(oc.DOWNLOAD_DIR, "*.xls*"))
            if not f.endswith(".crdownload")
        ]
        if files:
            return max(files, key=os.path.getctime)
        time.sleep(1)
    return None


def find_search_and_download_(driver, start_iso: str, end_iso: str) -> str:
    clear_download_dir_()

    def try_in_context() -> bool:
        search_buttons = driver.find_elements(By.XPATH, "//button[contains(text(), '조회')]")
        if not search_buttons:
            return False
        apply_okpos_dates_(driver, start_iso, end_iso)
        driver.execute_script("arguments[0].click();", search_buttons[0])
        time.sleep(5)
        excel_btn = driver.find_elements(By.XPATH, "//button[contains(text(), '엑셀')]")
        if not excel_btn:
            return False
        driver.execute_script("arguments[0].click();", excel_btn[0])
        return True

    driver.switch_to.default_content()
    clicked = False
    for f1 in driver.find_elements(By.XPATH, "//iframe | //frame"):
        driver.switch_to.default_content()
        try:
            driver.switch_to.frame(f1)
            if try_in_context():
                clicked = True
                break
            for f2 in driver.find_elements(By.XPATH, "//iframe | //frame"):
                driver.switch_to.default_content()
                driver.switch_to.frame(f1)
                driver.switch_to.frame(f2)
                if try_in_context():
                    clicked = True
                    break
            if clicked:
                break
        except Exception:
            continue

    if not clicked:
        raise RuntimeError("OKPOS 조회/엑셀 버튼을 찾지 못했습니다.")
    path = wait_download_()
    if not path:
        raise RuntimeError("엑셀 다운로드 실패")
    return path


def login_okpos_(driver) -> None:
    wait = WebDriverWait(driver, 15)
    driver.get("https://okasp.okpos.co.kr/login/login_form.jsp")
    okpos_id = os.environ.get("OKPOS_ID", "").strip()
    okpos_password = os.environ.get("OKPOS_PASSWORD", "").strip()
    if not okpos_id or not okpos_password:
        raise RuntimeError("OKPOS 로그인 정보가 없습니다. agent/config.json 을 확인하세요.")
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
                time.sleep(0.3)
        for btn in driver.find_elements(By.XPATH, "//*[contains(text(), '닫기')]"):
            if btn.is_displayed():
                btn.click()
                time.sleep(0.3)
        driver.execute_script(
            "document.querySelectorAll('[id^=\"divPopupBackground\"]').forEach(el => el.style.display='none');"
        )
    except Exception:
        pass
    time.sleep(1.5)
    log("메뉴 이동 중...")
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


def backfill_pos_(days: int = 90) -> None:
    log(f"=== POS 백필 시작 ({days}일, D-1 기준) ===")
    if not os.path.exists(oc.DOWNLOAD_DIR):
        os.makedirs(oc.DOWNLOAD_DIR)

    ss = open_spreadsheet_()
    ws = ensure_worksheet_(ss, POS_SHEET_NAME, oc.POS_HEADERS)
    oc.ensure_pos_headers_(ws, ws.get_all_values())

    targets = date_range_backfill_(days)
    have = existing_pos_dates_(ws)
    if SKIP_EXISTING_DATES:
        todo = [d for d in targets if d.strftime("%Y-%m-%d") not in have]
        log(f"대상 {len(targets)}일 중 이미 있음 {len(targets) - len(todo)}일 → 수집 {len(todo)}일")
    else:
        todo = list(targets)
        wipe = {d.strftime("%Y-%m-%d") for d in targets}
        n = delete_sheet_dates_(ws, wipe, "pos")
        log(f"기존 {n}행 삭제 후 재적재 ({len(todo)}일)")

    if not todo:
        log("POS: 추가 수집할 날짜가 없습니다.")
        return

    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_experimental_option(
        "prefs",
        {
            "download.default_directory": oc.DOWNLOAD_DIR,
            "download.prompt_for_download": False,
            "download.directory_upgrade": True,
            "safebrowsing.enabled": True,
        },
    )
    service = Service(ChromeDriverManager().install())
    service.creation_flags = 0x08000000
    driver = webdriver.Chrome(service=service, options=options)
    try:
        try:
            driver.execute_cdp_cmd(
                "Browser.setDownloadBehavior",
                {"behavior": "allow", "downloadPath": oc.DOWNLOAD_DIR, "eventsEnabled": True},
            )
        except Exception:
            pass

        login_okpos_(driver)
        buffer: list[list] = []
        ok_days = 0
        fail_days = 0

        for idx, day in enumerate(todo, start=1):
            iso = day.strftime("%Y-%m-%d")
            log(f"[{idx}/{len(todo)}] POS {iso}")
            try:
                path = find_search_and_download_(driver, iso, iso)
                items = parse_okpos_excel_(path)
                # 과거일은 끼니 분리 없이 하루 스냅샷 1회 적재 (판매일시는 해당일 23:59:59)
                sold_at = f"{iso} 23:59:59"
                for name, qty in items:
                    buffer.append([iso, sold_at, name, int(qty)])
                ok_days += 1
                log(f"  → {len(items)}품목")
            except Exception as exc:
                fail_days += 1
                log(f"  → 실패: {exc}")
            # 중간 저장(중단 대비)
            if len(buffer) >= POS_APPEND_CHUNK:
                bulk_append_(ws, buffer)
                buffer = []

        if buffer:
            bulk_append_(ws, buffer)
        log(f"POS 백필 완료: 성공 {ok_days}일 / 실패 {fail_days}일")
    finally:
        try:
            driver.quit()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 날씨 백필 (ASOS 서울)
# ---------------------------------------------------------------------------
def describe_weather_(item: dict) -> str:
    def fnum(key: str) -> float | None:
        v = item.get(key)
        if v is None or v == "":
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    rn = fnum("rn") or 0.0
    dsnw = fnum("dsnw") or 0.0
    if rn > 0:
        return "비"
    if dsnw > 0:
        return "눈"
    ca = fnum("dc10Tca")
    if ca is not None:
        if ca >= 8:
            return "흐림"
        if ca >= 3:
            return "구름많음"
        return "맑음"
    hm = fnum("hm")
    if hm is not None and hm >= 90 and rn == 0:
        return "흐림"
    return "맑음"


def fetch_asos_range_(start_dt: datetime, end_dt: datetime) -> list[dict]:
    key = weather_api_key_()
    if not key:
        raise RuntimeError(
            "WEATHER_API_KEY 가 비어 있습니다. 스크립트 상단 변수 또는 환경변수에 넣어 주세요."
        )
    params = {
        "serviceKey": unquote(key),
        "pageNo": "1",
        "numOfRows": "999",
        "dataType": "JSON",
        "dataCd": "ASOS",
        "dateCd": "HR",
        "startDt": start_dt.strftime("%Y%m%d"),
        "startHh": "00",
        "endDt": end_dt.strftime("%Y%m%d"),
        "endHh": "23",
        "stnIds": ASOS_STN_ID,
    }
    resp = requests.get(ASOS_URL, params=params, timeout=60)
    resp.raise_for_status()
    payload = resp.json()
    header = (((payload or {}).get("response") or {}).get("header") or {})
    code = str(header.get("resultCode") or "")
    if code not in ("00", "0", ""):
        raise RuntimeError(f"ASOS API 오류: {code} {header.get('resultMsg')}")
    body = (((payload or {}).get("response") or {}).get("body") or {})
    items = ((body.get("items") or {}).get("item")) or []
    if isinstance(items, dict):
        items = [items]
    return items


def pick_hour_(items: list[dict], day: str, hour: int) -> dict | None:
    """day=YYYY-MM-DD, hour=9 or 18. 없으면 가까운 시각."""
    want = f"{day} {hour:02d}"
    exact = None
    near = []
    for it in items:
        tm = str(it.get("tm") or "")
        if not tm.startswith(day):
            continue
        if tm.startswith(want):
            exact = it
            break
        near.append(it)
    if exact:
        return exact
    if not near:
        return None
    # HH 차이가 가장 작은 것
    best = None
    best_diff = 99
    for it in near:
        tm = str(it.get("tm") or "")
        try:
            hh = int(tm[11:13])
        except ValueError:
            continue
        diff = abs(hh - hour)
        if diff < best_diff:
            best_diff = diff
            best = it
    return best


def build_weather_rows_(days: list[datetime]) -> list[list]:
    if not days:
        return []
    rows_out: list[list] = []
    # API 한 번에 너무 길면 실패할 수 있어 10일 단위
    chunk_days = 10
    for i in range(0, len(days), chunk_days):
        chunk = days[i : i + chunk_days]
        start = chunk[0]
        end = chunk[-1]
        log(f"날씨 API {start:%Y-%m-%d} ~ {end:%Y-%m-%d} (서울 ASOS {ASOS_STN_ID})")
        try:
            items = fetch_asos_range_(start, end)
        except Exception as exc:
            log(f"  API 실패: {exc}")
            time.sleep(1)
            continue
        by_day: dict[str, list[dict]] = {}
        for it in items:
            tm = str(it.get("tm") or "")
            if len(tm) < 10:
                continue
            by_day.setdefault(tm[:10], []).append(it)

        for d in chunk:
            iso = d.strftime("%Y-%m-%d")
            day_items = by_day.get(iso) or []
            am = pick_hour_(day_items, iso, 9)
            pm = pick_hour_(day_items, iso, 18)
            am_w = describe_weather_(am) if am else ""
            pm_w = describe_weather_(pm) if pm else ""
            am_t = (am or {}).get("ta", "") if am else ""
            pm_t = (pm or {}).get("ta", "") if pm else ""
            rows_out.append([iso, am_w, am_t, pm_w, pm_t])
        time.sleep(REQUEST_SLEEP_SEC)
    return rows_out


def backfill_weather_(days: int = 90) -> None:
    log(f"=== 날씨 백필 시작 ({days}일, 서울 ASOS) ===")
    if not weather_api_key_():
        raise RuntimeError(
            "WEATHER_API_KEY 가 없습니다.\n"
            "1) 공공데이터포털에서 ASOS 시간자료 API 활용신청\n"
            "2) backfill_data.py 상단 WEATHER_API_KEY 에 Decoding 키 붙여넣기"
        )

    ss = open_spreadsheet_()
    ws = ensure_worksheet_(ss, WEATHER_SHEET_NAME, WEATHER_HEADERS)
    targets = date_range_backfill_(days)
    have = existing_weather_dates_(ws)

    if SKIP_EXISTING_DATES:
        todo = [d for d in targets if d.strftime("%Y-%m-%d") not in have]
        log(f"대상 {len(targets)}일 중 이미 있음 {len(targets) - len(todo)}일 → 수집 {len(todo)}일")
    else:
        todo = list(targets)
        wipe = {d.strftime("%Y-%m-%d") for d in targets}
        n = delete_sheet_dates_(ws, wipe, "weather")
        log(f"기존 {n}행 삭제 후 재적재")

    if not todo:
        log("날씨: 추가 수집할 날짜가 없습니다.")
        return

    rows = build_weather_rows_(todo)
    # 빈 날(모두 공란)도 일자 자리 남김 — 대시보드 조인 편의
    if not SKIP_EXISTING_DATES:
        pass
    else:
        # 재실행 시 겹치면 삭제 후 삽입
        overlap = {r[0] for r in rows} & have
        if overlap:
            delete_sheet_dates_(ws, overlap, "weather")

    n = bulk_append_(ws, rows)
    log(f"날씨 백필 완료: {n}행 → '{WEATHER_SHEET_NAME}'")


def main() -> int:
    parser = argparse.ArgumentParser(description="POS·날씨 90일 1회성 백필")
    parser.add_argument("--days", type=int, default=90, help="백필 일수 (기본 90, D-1 기준)")
    parser.add_argument("--pos-only", action="store_true", help="POS만")
    parser.add_argument("--weather-only", action="store_true", help="날씨만")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="이미 있는 날짜도 지우고 다시 넣기 (기본은 건너뜀)",
    )
    args = parser.parse_args()

    global SKIP_EXISTING_DATES
    if args.replace:
        SKIP_EXISTING_DATES = False

    do_pos = not args.weather_only
    do_weather = not args.pos_only
    if args.pos_only and args.weather_only:
        do_pos = do_weather = True

    try:
        if do_weather:
            backfill_weather_(args.days)
        if do_pos:
            log("POS 백필은 일자마다 OKPOS 엑셀 다운로드라 수십 분~수 시간 걸릴 수 있습니다.")
            backfill_pos_(args.days)
    except Exception as exc:
        log(f"실패: {exc}")
        return 1
    log("전체 완료")
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(errors="replace")
        except Exception:
            pass
    raise SystemExit(main())
