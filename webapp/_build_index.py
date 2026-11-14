# -*- coding: utf-8 -*-
"""web/public/app → webapp/{Index,Styles,AppJs,AppJs_PosSales}.html (GAS include 구조)"""
from pathlib import Path
import re as _re

UI_VERSION = "2026-11-14-j138"

root = Path(__file__).resolve().parents[1]
src = root / "web/public/app"
out = root / "webapp"


def gas_safe_check_(js_raw, label):
    if "</script>" in js_raw.lower():
        raise SystemExit(f"{label} 안에 </script> 가 있어 빌드 중단")
    if "image/*" in js_raw:
        raise SystemExit(f"{label} 안에 image/* 금지 — GAS가 주석으로 오인합니다. MIME 목록을 쓰세요.")
    _code_only = _re.sub(r"/\*.*?\*/", "", js_raw, flags=_re.S)
    _code_only = _re.sub(r"(^|[^:])//.*?$", "", _code_only, flags=_re.M)
    if "https://" in _code_only:
        raise SystemExit(f'{label} 코드에 https: + // 금지 — "https:/" + "/host..." 로 분리하세요.')
    _in_tick = _re.findall(r"`(?:\\`|[^`])*`", js_raw, flags=_re.S)
    for _chunk in _in_tick:
        if "/*" in _chunk:
            raise SystemExit(f"{label} 템플릿 리터럴 안에 /* 가 있습니다. GAS 배포 시 코드가 삭제됩니다.")
        if "//" in _chunk:
            raise SystemExit(f"{label} 템플릿 리터럴 안에 // 가 있습니다. GAS가 줄을 잘라냅니다.")


css = (src / "styles.css").read_text(encoding="utf-8").strip() + "\n"
js_src = src / "app.js"
js_raw = js_src.read_text(encoding="utf-8")

# 표시 버전 동기화
js_raw = _re.sub(
    r'const UI_VERSION = "[^"]+";',
    f'const UI_VERSION = "{UI_VERSION}";',
    js_raw,
    count=1,
)
js_raw = _re.sub(r"(?m)^/\* ===== BUILD_MARK.*?===== \*/\s*", "", js_raw)
js_src.write_text(js_raw, encoding="utf-8")
gas_safe_check_(js_raw, "app.js")

pos_src = src / "posSales.js"
pos_raw = pos_src.read_text(encoding="utf-8") if pos_src.exists() else ""
if pos_raw:
    gas_safe_check_(pos_raw, "posSales.js")

# --- Styles.html : 커스텀 CSS + Tailwind config (CDN 직후 head 에서 적용) ---
styles_html = f"""<style>
{css}</style>
<script>
  window.__TW_CONFIG__ = {{
    theme: {{
      extend: {{
        colors: {{
          brand: {{ DEFAULT: "#163028", soft: "#1e3f34", mist: "#d7e3dc", ink: "#13241e" }},
          paper: {{ DEFAULT: "#f4f1eb", card: "#fffcf7", line: "#e4ddd2" }},
          ok: "#1f7a4c", wait: "#c46a1b"
        }},
        boxShadow: {{ panel: "0 10px 30px rgba(22,48,40,.08)" }}
      }}
    }}
  }};
  if (typeof tailwind !== "undefined") {{
    tailwind.config = window.__TW_CONFIG__;
  }}
</script>
"""

# --- AppJs.html : 메인 클라이언트 JS ---
appjs_html = f"""<script>
{js_raw.rstrip()}
</script>
"""

# --- AppJs_PosSales.html : POS 판매내역 모듈 ---
posjs_html = f"""<script>
{pos_raw.rstrip()}
</script>
""" if pos_raw else "<script>window.PosSales=window.PosSales||{html:function(){return '';},load:function(){},bind:function(){}};</script>\n"

# --- Index.html : 뼈대 + include ---
# Tailwind CDN 은 head 최상단(스타일·앱 JS 보다 앞) — body 끝에 두면 레이아웃이 깨진 채로 렌더됨
index_html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#163028" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <title>중계고기파티 재고</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <?!= include('Styles'); ?>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" />
</head>
<body class="bg-paper text-brand-ink antialiased">
  <div id="root">
    <div id="bootMsg" style="padding:28px;font-family:Malgun Gothic,sans-serif;color:#163028;font-size:14px">화면 불러오는 중… ({UI_VERSION})</div>
  </div>
  <script>
    window.__bootErr = false;
    window.onerror = function (msg, src, line, col) {{
      window.__bootErr = true;
      var r = document.getElementById("root");
      if (!r) return;
      r.setAttribute("data-err", "1");
      r.innerHTML = '<div style="padding:28px;font-family:Malgun Gothic,sans-serif;color:#b00020;max-width:640px">' +
        "<b>화면 스크립트 오류</b><br/>" + String(msg) +
        '<br/><span style="color:#666;font-size:12px">line ' + line + (col ? (":" + col) : "") + "</span>" +
        "</div>";
    }};
  </script>
  <?!= include('AppJs'); ?>
  <?!= include('AppJs_PosSales'); ?>
  <script>
    setTimeout(function () {{
      if (typeof UI_VERSION !== "undefined") return;
      if (window.__bootErr) return;
      var r = document.getElementById("root");
      if (!r || r.getAttribute("data-err")) return;
      r.innerHTML = '<div style="padding:28px;font-family:Malgun Gothic,sans-serif;color:#b00020;max-width:720px;line-height:1.5">' +
        "<b>화면 스크립트가 실행되지 않았습니다</b><br/><br/>" +
        "배포 관리에서 새 버전으로 다시 배포한 뒤 Ctrl+F5 로 새로고침하세요." +
        "</div>";
    }}, 1500);
  </script>
</body>
</html>
"""

(out / "Styles.html").write_text(styles_html, encoding="utf-8")
(out / "AppJs.html").write_text(appjs_html, encoding="utf-8")
(out / "AppJs_PosSales.html").write_text(posjs_html, encoding="utf-8")
(out / "Index.html").write_text(index_html, encoding="utf-8")

print("UI_VERSION", UI_VERSION)
print("Styles.html", (out / "Styles.html").stat().st_size, "bytes")
print("AppJs.html", (out / "AppJs.html").stat().st_size, "bytes")
print("AppJs_PosSales.html", (out / "AppJs_PosSales.html").stat().st_size, "bytes")
print("Index.html", (out / "Index.html").stat().st_size, "bytes")
print("include AppJs_PosSales", "include('AppJs_PosSales')" in index_html)
