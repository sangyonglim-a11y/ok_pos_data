# -*- coding: utf-8 -*-
"""일별 날씨 갱신 (스케줄러용).

- 어제(D-1) + 오늘 오전/오후(가능하면) ASOS 서울(108) 자료를 구글 시트 `일별날씨`에 upsert
- API 키: 환경변수 WEATHER_API_KEY 또는 agent/config.json 의 weather_api_key
  또는 backfill_data.WEATHER_API_KEY

사용:
  python weather_daily.py
  python weather_daily.py --days 3
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# backfill_data 의 ASOS/시트 유틸 재사용
import backfill_data as bf


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def load_weather_key_() -> str:
    env = (os.environ.get("WEATHER_API_KEY") or "").strip()
    if env:
        return env
    for path in (
        app_dir() / "config.json",
        app_dir() / "agent" / "config.json",
        Path(__file__).resolve().parent / "agent" / "config.json",
        Path(__file__).resolve().parent / "config.json",
    ):
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        key = str(data.get("weather_api_key") or data.get("WEATHER_API_KEY") or "").strip()
        if key:
            return key
    try:
        import backfill_data as b2

        return (b2.WEATHER_API_KEY or "").strip()
    except Exception:
        return ""


def upsert_weather_days_(days: int = 2) -> int:
    """최근 days일(오늘 포함, 오래된→최근) 날씨를 시트에 반영."""
    key = load_weather_key_()
    if not key:
        raise RuntimeError(
            "weather_api_key 가 없습니다. config.json 에 weather_api_key 를 넣거나 "
            "환경변수 WEATHER_API_KEY 를 설정하세요."
        )
    os.environ["WEATHER_API_KEY"] = key
    bf.WEATHER_API_KEY = key
    bf.SKIP_EXISTING_DATES = False  # 오늘/어제는 덮어씀

    end = datetime.now().date()
    # ASOS는 보통 전일까지 완전. 오늘은 있는 시간만.
    start = end - timedelta(days=max(1, days) - 1)
    targets = []
    cur = start
    while cur <= end:
        targets.append(datetime(cur.year, cur.month, cur.day))
        cur += timedelta(days=1)

    ss = bf.open_spreadsheet_()
    ws = bf.ensure_worksheet_(ss, bf.WEATHER_SHEET_NAME, bf.WEATHER_HEADERS)
    wipe = {d.strftime("%Y-%m-%d") for d in targets}
    bf.delete_sheet_dates_(ws, wipe, "weather")
    rows = bf.build_weather_rows_(targets)
    return bf.bulk_append_(ws, rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="일별 날씨 시트 갱신")
    parser.add_argument("--days", type=int, default=2, help="오늘 포함 최근 N일 (기본 2=어제+오늘)")
    args = parser.parse_args(argv)
    try:
        n = upsert_weather_days_(args.days)
        bf.log(f"일별날씨 갱신 완료: {n}행")
        return 0
    except Exception as exc:
        bf.log(f"일별날씨 실패: {exc}")
        return 1


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(errors="replace")
        except Exception:
            pass
    raise SystemExit(main())
