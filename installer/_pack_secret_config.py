import argparse
import json
import re
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()
    root = Path(args.root)
    secret = Path(args.out)
    secret.mkdir(parents=True, exist_ok=True)
    cfg_path = root / "agent" / "config.json"
    ex_path = root / "agent" / "config.example.json"
    if cfg_path.is_file():
        cfg = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
    else:
        cfg = json.loads(ex_path.read_text(encoding="utf-8-sig"))
    cfg["service_account_file"] = "okpos-inventory.json"
    cfg.setdefault("business_hours", {})
    cfg["business_hours"]["start"] = "11:00"
    cfg["business_hours"]["end"] = "23:00"
    cfg["business_hours"].setdefault("days", list(range(7)))
    cfg["interval_minutes"] = 30
    if not str(cfg.get("weather_api_key") or "").strip():
        bf = (root / "backfill_data.py").read_text(encoding="utf-8", errors="ignore")
        m = re.search(r'WEATHER_API_KEY\s*=\s*["\']([^"\']+)["\']', bf)
        if m and m.group(1) and "공공" not in m.group(1):
            cfg["weather_api_key"] = m.group(1)
    out = secret / "config.json"
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("config.json ready; weather_api_key set:", bool(cfg.get("weather_api_key")))


if __name__ == "__main__":
    main()
