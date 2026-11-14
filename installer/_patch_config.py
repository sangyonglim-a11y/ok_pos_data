import json
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
cfg_path = root / "agent" / "config.json"
cfg = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
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
cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("agent config updated; weather_key=", bool(cfg.get("weather_api_key")))
