# -*- coding: utf-8 -*-
"""일별날씨 동기화 (에이전트 exe에 포함). 서울 ASOS 108."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote

import gspread
import requests

ASOS_STN_ID = "108"
ASOS_URL = "https://apis.data.go.kr/1360000/AsosHourlyInfoService/getWthrDataList"
WEATHER_SHEET_NAME = "일별날씨"
WEATHER_HEADERS = ["일자", "오전_날씨", "오전_기온", "오후_날씨", "오후_기온"]
# 포스 전원 11~23시 기준 슬롯
AM_SLOT = (11, 0, 15, 59)   # 11:00~15:59 중 하루 1회
PM_SLOT = (18, 0, 22, 50)   # 18:00~22:50 중 하루 1회


def _stamp_path(app_dir: Path) -> Path:
    return app_dir / "weather_slots.json"


def _load_stamp(app_dir: Path) -> dict:
    path = _stamp_path(app_dir)
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_stamp(app_dir: Path, data: dict) -> None:
    _stamp_path(app_dir).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def current_slot(now: datetime | None = None) -> str | None:
    now = now or datetime.now()
    hm = now.hour * 60 + now.minute
    am0 = AM_SLOT[0] * 60 + AM_SLOT[1]
    am1 = AM_SLOT[2] * 60 + AM_SLOT[3]
    pm0 = PM_SLOT[0] * 60 + PM_SLOT[1]
    pm1 = PM_SLOT[2] * 60 + PM_SLOT[3]
    if am0 <= hm <= am1:
        return "am"
    if pm0 <= hm <= pm1:
        return "pm"
    return None


def should_run_weather(app_dir: Path, *, force: bool = False, now: datetime | None = None) -> str | None:
    """실행할 슬롯명(am/pm) 또는 None."""
    now = now or datetime.now()
    if force:
        return current_slot(now) or "am"
    slot = current_slot(now)
    if not slot:
        return None
    stamp = _load_stamp(app_dir)
    day = now.strftime("%Y-%m-%d")
    done = stamp.get(day) or {}
    if done.get(slot):
        return None
    return slot


def mark_weather_done(app_dir: Path, slot: str, now: datetime | None = None) -> None:
    now = now or datetime.now()
    day = now.strftime("%Y-%m-%d")
    stamp = _load_stamp(app_dir)
    day_map = stamp.get(day) or {}
    day_map[slot] = datetime.now().strftime("%H:%M:%S")
    stamp[day] = day_map
    # 오래된 날짜 정리
    keys = sorted(stamp.keys())
    for k in keys[:-14]:
        stamp.pop(k, None)
    _save_stamp(app_dir, stamp)


def describe_weather(item: dict) -> str:
    def fnum(key: str):
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
    return "맑음"


def fetch_asos(api_key: str, start: datetime, end: datetime) -> list[dict]:
    params = {
        "serviceKey": unquote(api_key.strip()),
        "pageNo": "1",
        "numOfRows": "999",
        "dataType": "JSON",
        "dataCd": "ASOS",
        "dateCd": "HR",
        "startDt": start.strftime("%Y%m%d"),
        "startHh": "00",
        "endDt": end.strftime("%Y%m%d"),
        "endHh": "23",
        "stnIds": ASOS_STN_ID,
    }
    resp = requests.get(ASOS_URL, params=params, timeout=60)
    resp.raise_for_status()
    payload = resp.json()
    header = (((payload or {}).get("response") or {}).get("header") or {})
    code = str(header.get("resultCode") or "")
    if code not in ("00", "0", ""):
        raise RuntimeError(f"ASOS {code} {header.get('resultMsg')}")
    body = (((payload or {}).get("response") or {}).get("body") or {})
    items = ((body.get("items") or {}).get("item")) or []
    if isinstance(items, dict):
        items = [items]
    return items


def pick_hour(items: list[dict], day: str, hour: int) -> dict | None:
    want = f"{day} {hour:02d}"
    exact = None
    near = []
    for it in items:
        tm = str(it.get("tm") or "")
        if not tm.startswith(day):
            continue
        if tm.startswith(want):
            return it
        near.append(it)
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


def ensure_sheet(ss, title: str, headers: list[str]):
    try:
        ws = ss.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = ss.add_worksheet(title=title, rows=2000, cols=8)
        ws.append_row(headers, value_input_option="USER_ENTERED")
        return ws
    values = ws.get_all_values()
    if not values:
        ws.append_row(headers, value_input_option="USER_ENTERED")
    elif [str(c).strip() for c in values[0][: len(headers)]] != headers:
        ws.update("A1", [headers], value_input_option="USER_ENTERED")
    return ws


def delete_dates(ws, dates: set[str]) -> None:
    if not dates:
        return
    values = ws.get_all_values()
    rows = []
    for i, row in enumerate(values):
        if i == 0:
            continue
        day = str(row[0]).strip()[:10] if row else ""
        if day in dates:
            rows.append(i + 1)
    if not rows:
        return
    ordered = sorted(set(rows))
    ranges = []
    start = prev = ordered[0]
    for n in ordered[1:]:
        if n == prev + 1:
            prev = n
            continue
        ranges.append((start, prev))
        start = prev = n
    ranges.append((start, prev))
    for a, b in reversed(ranges):
        ws.delete_rows(a, b)


def upsert_recent(api_key: str, sheet_url: str, sa_json: str, days: int = 2) -> int:
    end = datetime.now().date()
    start = end - timedelta(days=max(1, days) - 1)
    start_dt = datetime(start.year, start.month, start.day)
    end_dt = datetime(end.year, end.month, end.day)
    items = fetch_asos(api_key, start_dt, end_dt)
    by_day: dict[str, list] = {}
    for it in items:
        tm = str(it.get("tm") or "")
        if len(tm) >= 10:
            by_day.setdefault(tm[:10], []).append(it)

    rows = []
    cur = start
    wipe = set()
    while cur <= end:
        iso = cur.strftime("%Y-%m-%d")
        wipe.add(iso)
        day_items = by_day.get(iso) or []
        am = pick_hour(day_items, iso, 9)
        pm = pick_hour(day_items, iso, 18)
        rows.append(
            [
                iso,
                describe_weather(am) if am else "",
                (am or {}).get("ta", "") if am else "",
                describe_weather(pm) if pm else "",
                (pm or {}).get("ta", "") if pm else "",
            ]
        )
        cur += timedelta(days=1)

    gc = gspread.service_account(filename=sa_json)
    ss = gc.open_by_url(sheet_url)
    ws = ensure_sheet(ss, WEATHER_SHEET_NAME, WEATHER_HEADERS)
    delete_dates(ws, wipe)
    if rows:
        ws.append_rows(rows, value_input_option="USER_ENTERED")
    return len(rows)
