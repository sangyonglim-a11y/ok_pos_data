# -*- coding: utf-8 -*-
"""
pos판매내역을 OKPOS 상품별>시간대별 기준으로 재적재.
기본: 2026-08-01 ~ 오늘 (하루씩 조회, 시트 해당일 교체)

  python backfill_pos_hourly.py
  python backfill_pos_hourly.py --from 2026-08-01 --to 2026-11-13
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timedelta

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager

import okpos_crawler as oc

POS_APPEND_CHUNK = 400


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def parse_day(text: str) -> datetime:
    return datetime.strptime(str(text).strip()[:10], "%Y-%m-%d")


def date_list(start: datetime, end: datetime) -> list[str]:
    out = []
    cur = start.date()
    last = end.date()
    while cur <= last:
        out.append(cur.strftime("%Y-%m-%d"))
        cur += timedelta(days=1)
    return out


def bulk_append_(ws, rows: list[list]) -> int:
    if not rows:
        return 0
    total = 0
    for i in range(0, len(rows), POS_APPEND_CHUNK):
        part = rows[i : i + POS_APPEND_CHUNK]
        ws.append_rows(part, value_input_option="USER_ENTERED")
        total += len(part)
        log(f"  시트 append {total}/{len(rows)}")
        time.sleep(0.4)
    return total


def login_and_open_hourly_(driver) -> None:
    wait = WebDriverWait(driver, 20)
    driver.get("https://okasp.okpos.co.kr/login/login_form.jsp")
    oid = os.environ.get("OKPOS_ID", "").strip()
    opw = os.environ.get("OKPOS_PASSWORD", "").strip()
    if not oid or not opw:
        raise RuntimeError("OKPOS 로그인 정보가 없습니다. agent/config.json 확인")
    wait.until(EC.presence_of_element_located((By.XPATH, "//input[@type='text']"))).send_keys(oid)
    driver.find_element(By.XPATH, "//input[@type='password']").send_keys(opw)
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
    log("메뉴: 매출관리 > 매출현황 > 상품별 > 시간대별")
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
    if not oc.open_hourly_tab_(driver):
        raise RuntimeError("시간대별 탭을 열지 못했습니다.")
    time.sleep(2)


def wipe_from_(ws, start_iso: str) -> int:
    """start_iso 이상 행 제거. 전체 삭제는 Sheets API가 막으므로 clear+재작성."""
    values = ws.get_all_values()
    keep = [oc.POS_HEADERS]
    removed = 0
    for i, row in enumerate(values):
        if i == 0:
            continue
        parsed = oc.parse_pos_sheet_row_(row)
        day = (parsed or {}).get("date", "")[:10]
        if not day and row:
            day = str(row[0]).strip()[:10]
        if day and day < start_iso:
            # 구형 스키마 행도 일자만 맞춰 보존
            if parsed:
                keep.append([
                    parsed.get("date") or day,
                    parsed.get("sold_at") or "",
                    parsed.get("name") or "",
                    int(parsed.get("qty") or 0),
                ])
            else:
                keep.append(row[:4])
        else:
            removed += 1
    log(f"시트 재작성: {start_iso} 이전 보존 {len(keep) - 1}행 · 제거 {removed}행")
    ws.clear()
    # 한 번에 너무 크면 나눠 씀
    for i in range(0, len(keep), 500):
        part = keep[i : i + 500]
        if i == 0:
            ws.update("A1", part, value_input_option="USER_ENTERED")
        else:
            ws.append_rows(part, value_input_option="USER_ENTERED")
        time.sleep(0.3)
    return removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="date_from", default="2026-08-01")
    ap.add_argument("--to", dest="date_to", default="")
    ap.add_argument("--no-wipe", action="store_true", help="시트 삭제 없이 부족한 일자만 추가")
    ap.add_argument("--fill-missing", action="store_true", help="시트에 없는 일자만 수집")
    args = ap.parse_args()
    start = parse_day(args.date_from)
    end = parse_day(args.date_to) if args.date_to else datetime.now()
    days = date_list(start, end)
    log(f"=== POS 시간대별 백필 {days[0]} ~ {days[-1]} ({len(days)}일) ===")

    oc.load_local_secrets()
    oc.clear_download_dir_()
    gc = __import__("gspread").service_account(filename=oc.JSON_FILE)
    ws = gc.open_by_url(oc.SHEET_URL).worksheet(oc.SHEET_NAME)
    existing = ws.get_all_values()
    oc.ensure_pos_headers_(ws, existing)
    if args.no_wipe or args.fill_missing:
        have = set()
        for row in ws.get_all_values()[1:]:
            parsed = oc.parse_pos_sheet_row_(row)
            if parsed and parsed.get("date"):
                have.add(str(parsed["date"])[:10])
        if args.fill_missing:
            before = len(days)
            days = [d for d in days if d not in have]
            log(f"이미 있는 날 제외: {before - len(days)}일 · 수집 {len(days)}일")
        else:
            log("--no-wipe: 기존 행 유지, 지정 기간을 덮어쓰지 않고 append 만 합니다(중복 주의).")
    else:
        wipe_from_(ws, days[0])
    if not days:
        log("수집할 일자가 없습니다.")
        return 0

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
        login_and_open_hourly_(driver)
        buffer: list[list] = []
        ok_days = 0
        fail_days = 0
        fail_list: list[str] = []
        for idx, sale_date in enumerate(days, start=1):
            log(f"[{idx}/{len(days)}] {sale_date}")
            try:
                path = oc.download_hourly_excel_for_day_(driver, sale_date)
                items = oc.parse_hourly_excel_(path)
                rows = oc.build_hourly_rows_(sale_date, items)
                buffer.extend(rows)
                ok_days += 1
                log(f"  → {len(rows)}행")
            except oc.OkposEmptyDayError as exc:
                ok_days += 1
                log(f"  → 매출없음(휴무 등) 0행 · {exc}")
            except Exception as exc:
                # alert/프레임 꼬임 → 알림 닫고 시간대별 탭 재진입 후 1회 재시도
                try:
                    oc.dismiss_okpos_alerts_(driver, 1.0)
                except Exception:
                    pass
                retried = False
                try:
                    oc.open_hourly_tab_(driver)
                    time.sleep(1.5)
                    path = oc.download_hourly_excel_for_day_(driver, sale_date)
                    items = oc.parse_hourly_excel_(path)
                    rows = oc.build_hourly_rows_(sale_date, items)
                    buffer.extend(rows)
                    ok_days += 1
                    retried = True
                    log(f"  → 재시도 성공 {len(rows)}행")
                except oc.OkposEmptyDayError as exc2:
                    ok_days += 1
                    retried = True
                    log(f"  → 재시도 매출없음 0행 · {exc2}")
                except Exception as exc2:
                    fail_days += 1
                    fail_list.append(f"{sale_date}: {exc2}")
                    log(f"  → 실패: {exc2}")
                if not retried:
                    pass
            if len(buffer) >= POS_APPEND_CHUNK:
                bulk_append_(ws, buffer)
                buffer = []
        if buffer:
            bulk_append_(ws, buffer)
        oc.mark_sync_day_(datetime.now())
        log(f"완료: 성공 {ok_days}일 / 실패 {fail_days}일")
        if fail_list:
            log("실패 목록:")
            for line in fail_list[:30]:
                log("  " + line)
            if len(fail_list) > 30:
                log(f"  ... 외 {len(fail_list) - 30}건")
        return 0 if fail_days == 0 else 2
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
