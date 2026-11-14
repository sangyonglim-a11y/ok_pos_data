"""매장 PC용 OKPOS 수집 에이전트.

- 자동: 영업시간(기본 11~23시) 중 30분 간격, 화면 없이 실행
- 날씨: 하루 2회(오전 슬롯·저녁 슬롯) 일별날씨 시트 갱신
- 수동: 바탕화면 바로가기에서 한 번 실행(완료 안내 창)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

# 프로젝트 루트 또는 설치 폴더에서 okpos_crawler 를 찾는다.
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
INSTALL_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT if (ROOT / "okpos_crawler.py").exists() else INSTALL_DIR.parent))
if str(INSTALL_DIR.parent) not in sys.path:
    sys.path.insert(0, str(INSTALL_DIR.parent))
if str(INSTALL_DIR) not in sys.path:
    sys.path.insert(0, str(INSTALL_DIR))

import okpos_crawler  # noqa: E402

try:
    import weather_sync  # noqa: E402
except ImportError:
    weather_sync = None  # type: ignore


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def load_config() -> dict:
    path = app_dir() / "config.json"
    if not path.exists():
        example = app_dir() / "config.example.json"
        raise FileNotFoundError(
            f"설정 파일이 없습니다: {path}\n"
            f"{example.name} 을 config.json 으로 복사한 뒤 값을 채워 주세요."
        )
    with path.open(encoding="utf-8-sig") as f:
        return json.load(f)


def apply_config(config: dict) -> None:
    sa = config.get("service_account_file") or "okpos-inventory.json"
    sa_path = Path(sa)
    if not sa_path.is_absolute():
        sa_path = app_dir() / sa_path
    okpos_crawler.JSON_FILE = str(sa_path)
    if config.get("sheet_url"):
        okpos_crawler.SHEET_URL = config["sheet_url"]
    okpos_crawler.BASE_DIR = str(app_dir())
    okpos_crawler.DOWNLOAD_DIR = str(app_dir() / "pos_excel_data")
    os.environ["OKPOS_ID"] = str(config.get("okpos_id") or "")
    os.environ["OKPOS_PASSWORD"] = str(config.get("okpos_password") or "")


def service_account_path_(config: dict) -> Path:
    sa = config.get("service_account_file") or "okpos-inventory.json"
    sa_path = Path(sa)
    if not sa_path.is_absolute():
        sa_path = app_dir() / sa_path
    return sa_path


def parse_hhmm(text: str) -> tuple[int, int]:
    hour, minute = str(text).strip().split(":")
    return int(hour), int(minute)


def within_business_hours(config: dict, now: datetime | None = None) -> bool:
    now = now or datetime.now()
    hours = config.get("business_hours") or {}
    days = hours.get("days", list(range(7)))
    if now.weekday() not in days:
        return False
    start_h, start_m = parse_hhmm(hours.get("start", "11:00"))
    end_h, end_m = parse_hhmm(hours.get("end", "23:00"))
    start = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
    end = now.replace(hour=end_h, minute=end_m, second=0, microsecond=0)
    return start <= now <= end


def log(message: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}"
    print(line)
    try:
        with (app_dir() / "okpos_agent.log").open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def run_weather_once_(config: dict, *, force: bool = False) -> None:
    """하루 최대 2회(am/pm 슬롯). force=True 면 슬롯 무시하고 1회 실행."""
    if weather_sync is None:
        log("weather_sync 모듈 없음 — 날씨 건너뜀")
        return
    key = str(config.get("weather_api_key") or config.get("WEATHER_API_KEY") or "").strip()
    if not key:
        log("weather_api_key 없음 — 날씨 건너뜀")
        return
    slot = weather_sync.should_run_weather(app_dir(), force=force)
    if not slot:
        return
    sheet_url = str(config.get("sheet_url") or "").strip()
    sa = service_account_path_(config)
    if not sheet_url or not sa.is_file():
        log("시트 URL 또는 서비스계정 파일 없음 — 날씨 건너뜀")
        return
    try:
        n = weather_sync.upsert_recent(key, sheet_url, str(sa), days=2)
        weather_sync.mark_weather_done(app_dir(), slot if slot in ("am", "pm") else "am")
        log(f"일별날씨 갱신({slot}): {n}행")
    except Exception as exc:
        log(f"일별날씨 실패: {exc}")


def run_once(config: dict, *, silent: bool, weather_only: bool = False) -> int:
    apply_config(config)
    if weather_only:
        run_weather_once_(config, force=True)
        return 0

    period = config.get("period") or "today"
    if silent and not within_business_hours(config):
        log("영업시간이 아니라 POS 수집을 건너뜁니다.")
        run_weather_once_(config, force=False)
        return 0

    log(f"OKPOS 수집 시작 (period={period}, silent={silent})")
    result = okpos_crawler.main(show_dialog=not silent, period=period)
    text = (result or {}).get("text") or "완료"
    error = bool((result or {}).get("error"))
    log(("실패: " if error else "성공: ") + str(text).replace("\n", " / "))
    # POS 주기(30분)마다 호출되지만, 슬롯당 1회만 실제 API/시트 갱신
    run_weather_once_(config, force=False)
    return 1 if error else 0


def run_daemon(config: dict) -> int:
    interval = max(5, int(config.get("interval_minutes") or 30))
    log(f"백그라운드 수집 시작. {interval}분 간격, 화면 없음.")
    while True:
        try:
            if within_business_hours(config):
                run_once(config, silent=True)
            else:
                log("영업시간 외 — 대기")
                run_weather_once_(config, force=False)
        except Exception as exc:
            log(f"예외: {exc}")
        time.sleep(interval * 60)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OKPOS 매장 수집 에이전트")
    parser.add_argument("--once", action="store_true", help="한 번만 실행")
    parser.add_argument("--daemon", action="store_true", help="백그라운드 반복")
    parser.add_argument("--silent", action="store_true", help="안내 창 없이 실행")
    parser.add_argument("--manual", action="store_true", help="수동 실행(안내 창 표시)")
    parser.add_argument("--weather-only", action="store_true", help="날씨만 강제 1회")
    args = parser.parse_args(argv)

    try:
        config = load_config()
    except Exception as exc:
        if not args.silent and not args.weather_only:
            okpos_crawler.show_message(str(exc), error=True)
        log(str(exc))
        return 2

    if args.weather_only:
        return run_once(config, silent=True, weather_only=True)

    if args.daemon:
        return run_daemon(config)
    silent = args.silent or (not args.manual and not args.once)
    if args.manual:
        silent = False
    if args.once or args.manual or not args.daemon:
        if not args.once and not args.manual and not args.silent:
            silent = False
        return run_once(config, silent=silent)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
