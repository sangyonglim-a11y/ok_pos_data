"""같은 와이파이의 스마트폰 브라우저에서 재고관리를 쓰게 하는 화면.

POS 수집과 영수증 OCR은 이 컴퓨터에서 실행됩니다.
주소의 토큰이 없는 요청은 거절합니다. 시트 비밀번호나 계정 메일은 화면에 넣지 않습니다.
"""

import html
import secrets
import socket
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlencode, urlparse

import segno

import okpos_crawler
import sheet_jobs


JOB_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
SERVER_LOCK = threading.Lock()
JOB = {
    "running": False,
    "title": "",
    "lines": [],
    "error": False,
    "message": "",
}
SERVER = None


def job_running():
    with STATE_LOCK:
        return bool(JOB["running"])


def job_snapshot():
    with STATE_LOCK:
        return {
            "running": JOB["running"],
            "title": JOB["title"],
            "lines": list(JOB["lines"]),
            "error": JOB["error"],
            "message": JOB["message"],
        }


def begin_job(title):
    if not JOB_LOCK.acquire(blocking=False):
        return False
    with STATE_LOCK:
        JOB["running"] = True
        JOB["title"] = title
        JOB["lines"] = []
        JOB["error"] = False
        JOB["message"] = ""
    return True


def append_log(message):
    text = str(message).strip()
    if not text:
        return
    with STATE_LOCK:
        JOB["lines"].append(text)
        del JOB["lines"][:-80]


def finish_job(error, message):
    with STATE_LOCK:
        JOB["running"] = False
        JOB["error"] = bool(error)
        JOB["message"] = str(message or "")
    JOB_LOCK.release()


def public_error(exc):
    text = str(exc).strip()
    lowered = text.lower()
    if "@" in text or "private_key" in lowered or ".json" in lowered:
        return "시트를 열지 못했습니다. 컴퓨터의 재고관리 창을 확인해 주세요."
    if len(text) > 300:
        text = text[:300] + "..."
    return text or "처리하지 못했습니다."


def lan_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def allow_firewall(port):
    command = [
        "netsh", "advfirewall", "firewall", "add", "rule",
        f"name=재고관리 폰 {port}", "dir=in", "action=allow",
        "protocol=TCP", f"localport={port}",
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return "폰에서 페이지가 안 열리면 윈도우 방화벽에서 이 프로그램을 허용해 주세요."
    if result.returncode == 0:
        return ""
    return "폰에서 페이지가 안 열리면, 윈도우가 방화벽 창을 띄울 때 허용을 눌러 주세요."


def qr_photo(parent, url, scale=6):
    import tkinter as tk

    code = segno.make(url, error="m")
    rows = [tuple(row) for row in code.matrix_iter(scale=1, border=4)]
    if not rows:
        raise ValueError("QR을 만들지 못했습니다.")
    width = len(rows[0]) * scale
    height = len(rows) * scale
    image = tk.PhotoImage(master=parent, width=width, height=height)
    dark = "#1e3329"
    light = "#ffffff"
    lines = []
    for row in rows:
        expanded = " ".join(dark if cell else light for cell in row for _ in range(scale))
        band = "{" + expanded + "}"
        lines.extend([band] * scale)
    image.put(" ".join(lines))
    return image


def ensure_server():
    global SERVER
    with SERVER_LOCK:
        if SERVER is not None:
            return SERVER
        token = secrets.token_hex(3)
        last_error = None
        httpd = None
        port = None
        for candidate in range(8765, 8775):
            try:
                httpd = ThreadingHTTPServer(("0.0.0.0", candidate), Handler)
                port = candidate
                break
            except OSError as exc:
                last_error = exc
        if httpd is None:
            raise RuntimeError(f"폰 접속 포트를 열 수 없습니다. {last_error}")
        httpd.token = token
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        ip = lan_ip()
        info = {
            "url": f"http://{ip}:{port}/m/{token}/",
            "ip": ip,
            "port": port,
            "firewall": allow_firewall(port),
        }
        httpd.info = info
        SERVER = info
        return info


def cell(row, index):
    value = sheet_jobs.cell_or_blank(row, index)
    return "" if value is None else str(value).strip()


def load_stock(category=""):
    spreadsheet = sheet_jobs.open_sheet()
    values = sheet_jobs.sheet_or_raise(spreadsheet, "원재료_실시간재고").get_all_values()
    month = sheet_jobs.latest_month(values) if len(values) > 1 else sheet_jobs.month_text()
    rows = []
    for row in values[1:]:
        if sheet_jobs.text_month(row[0] if row else "") != month:
            continue
        item_category = cell(row, 13)
        if category and item_category != category:
            continue
        rows.append({
            "code": cell(row, 2),
            "name": cell(row, 3),
            "opening": cell(row, 4),
            "incoming": cell(row, 5),
            "used": cell(row, 6),
            "stock": cell(row, 8),
            "display": cell(row, 10) or cell(row, 8),
            "category": item_category,
        })
    rows.sort(key=lambda item: (item["category"], item["name"], item["code"]))
    return month, rows


def is_negative(value):
    text = str(value or "").replace(",", "").strip()
    if not text:
        return False
    try:
        return float(text) < 0
    except ValueError:
        return text.startswith("-")


def run_pos(log, period):
    if period == "month":
        log("컴퓨터의 OKPOS에서 이번 달 1일부터 오늘까지 판매를 가져옵니다.")
    else:
        log("컴퓨터의 OKPOS에서 오늘 판매를 가져옵니다.")
    result = okpos_crawler.main(show_dialog=False, period=period)
    message = result.get("text") or "완료되었습니다."
    return bool(result.get("error")), message


ACTIONS = {
    "quantities": ("입고 수량 환산", lambda log: sheet_jobs.update_receipt_quantities(log)),
    "calculate": ("실시간 재고 계산", lambda log: sheet_jobs.calculate_inventory(log)),
    "close": ("월마감 진행", lambda log: sheet_jobs.monthly_close(log)),
    "ocr": ("영수증 OCR 입고 등록", lambda log: sheet_jobs.process_receipts_ocr(log)),
    "pos-today": ("POS 당일 판매", lambda log: run_pos(log, "today")),
    "pos-month": ("POS 이번 달 판매", lambda log: run_pos(log, "month")),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def route(self):
        try:
            parsed = urlparse(self.path)
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) < 2 or parts[0] != "m" or parts[1] != getattr(self.server, "token", ""):
                self.send_html(page("재고관리", "<p>컴퓨터 화면에 나온 주소 전체를 입력해 주세요.</p>"), status=404)
                return
            self.parts = parts[2:]
            self.query = parse_qs(parsed.query)
            if self.command == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8", "replace") if length else ""
                self.form = parse_qs(raw)
            else:
                self.form = {}
            self.dispatch()
        except Exception as exc:
            self.send_html(page("재고관리", f"<p>{esc(public_error(exc))}</p><p><a href='{self.href()}'>처음으로</a></p>"), status=500)

    def dispatch(self):
        head = self.parts[0] if self.parts else ""
        if self.command == "GET" and head == "":
            self.send_html(self.home_page())
        elif head == "stock" and self.command == "GET":
            self.send_html(self.stock_page())
        elif head == "inspect" and self.command == "GET":
            self.send_html(self.inspect_page())
        elif head == "inspect" and self.command == "POST":
            self.save_inspect()
        elif head == "register" and self.command == "GET" and len(self.parts) == 1:
            self.send_html(self.register_list_page())
        elif head == "register" and len(self.parts) >= 2 and self.parts[1] == "form" and self.command == "GET":
            self.send_html(self.register_form_page())
        elif head == "register" and self.command == "POST":
            self.save_register()
        elif head == "balance" and self.command == "GET":
            self.send_html(self.balance_page())
        elif head == "balance" and self.command == "POST":
            self.rebuild_balance()
        elif head == "run" and self.command == "POST" and len(self.parts) == 2:
            self.start_action(self.parts[1])
        elif head == "job" and self.command == "GET":
            self.send_html(self.job_page())
        else:
            self.redirect(self.href())

    def field(self, name, source=None):
        values = (source or self.form).get(name) or []
        return values[0] if values else ""

    def href(self, *parts, **query):
        path = "/m/" + self.server.token + "/"
        if parts:
            path += "/".join(quote(str(part), safe="") for part in parts)
            if not path.endswith("/"):
                path += "/"
        clean = {key: value for key, value in query.items() if value not in ("", None)}
        if clean:
            path += "?" + urlencode(clean)
        return path

    def send_html(self, body, status=200):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location):
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def render(self, title, body, refresh=""):
        nav = (
            "<nav class='nav'>"
            f"<a href='{self.href()}'>홈</a>"
            f"<a href='{self.href('stock')}'>재고</a>"
            f"<a href='{self.href('inspect', pending='1')}'>검수</a>"
            f"<a href='{self.href('register')}'>등록</a>"
            f"<a href='{self.href('balance')}'>금액</a>"
            f"<a href='{self.href('job')}'>작업</a>"
            "</nav>"
        )
        return page(title, nav + body, self.banner(), refresh=refresh)

    def home_page(self):
        buttons = f"""
        <a class="btn" href="{self.href('stock')}">실시간 재고 보기</a>
        <a class="btn" href="{self.href('inspect', pending='1')}">실물 검수</a>
        <a class="btn" href="{self.href('register')}">미등록 품목 등록</a>
        <a class="btn" href="{self.href('balance', warn='1')}">거래처 금액 검증</a>
        <form method="post" action="{self.href('run', 'quantities')}"><button>입고 수량 환산</button></form>
        <form method="post" action="{self.href('run', 'calculate')}"><button>실시간 재고 계산</button></form>
        <form method="post" action="{self.href('run', 'pos-today')}"><button>POS 당일 판매 가져오기</button></form>
        <form method="post" action="{self.href('run', 'pos-month')}"><button>POS 이번 달 판매 가져오기</button></form>
        <form method="post" action="{self.href('run', 'ocr')}"><button>영수증 OCR 입고 등록</button></form>
        <form method="post" action="{self.href('run', 'close')}" onsubmit="return confirm('이번 달 기록은 그대로 두고, 남은 재고를 다음 달 기초재고로 추가할까요?');">
          <button class="danger">월마감 진행</button>
        </form>
        <p class="note">판매 수집과 영수증 인식은 이 컴퓨터에서 실행됩니다. 재고관리 프로그램을 끄면 이 페이지도 닫힙니다.</p>
        """
        return self.render("재고관리", buttons)

    def balance_page(self):
        warn_only = self.field("warn", self.query) == "1"
        rows = sheet_jobs.load_vendor_balances()
        warnings = [row for row in rows if row["status"] != "OK"]
        if warn_only and not warnings and rows:
            warn_only = False
        visible = warnings if warn_only else rows
        toggle = (
            f'<a href="{self.href("balance")}">전체 {len(rows)}건</a>'
            if warn_only else
            f'<a href="{self.href("balance", warn="1")}">확인요망 {len(warnings)}건</a>'
        )
        body = [
            "<h1>거래처 매입 금액</h1>",
            f"<form method='post' action='{self.href('balance')}'><button>검증 계산</button></form>",
            "<p class='note'>검증대상이 Y인 거래처만 계산합니다. 영수증 한 장당 한 줄입니다. 수금은 비워 두고, 확인요망 줄에 직접 넣은 금액만 다시 계산할 때 반영됩니다. 빈 수금은 0원입니다. "
            f"{toggle}</p>",
        ]
        if not visible:
            body.append("<p>표시할 거래가 없습니다. 검증 계산을 누르면 검증대상 Y 거래처가 여기에 나옵니다.</p>")
        for row in visible:
            klass = "neg" if row["status"] != "OK" else ""
            body.append(
                "<article class='rowcheck'>"
                f"<span><b class='{klass}'>{esc(row['status'] or '확인요망')}</b> {esc(row['date'])}<br>"
                f"<b>{esc(row['vendor'])}</b><br>"
                f"<span class='muted'>영수증합계 {esc(self.money(row['daily']))} · 수금 {esc(self.money(row.get('payment')))} · 당월 {esc(self.money(row['month']))}"
                f" · 검증누계 {esc(self.money(row.get('check_total')))}</span></span>"
                "</article>"
            )
        return self.render("거래처 금액", "".join(body))

    def rebuild_balance(self):
        if not begin_job("거래처 금액 검증"):
            self.send_html(self.render(
                "거래처 금액",
                f"<p>다른 작업이 진행 중입니다. 끝난 뒤에 다시 눌러 주세요.</p><p><a href='{self.href('balance')}'>돌아가기</a></p>",
            ))
            return
        try:
            _error, message = sheet_jobs.rebuild_vendor_balances()
            finish_job(False, message)
        except Exception as exc:
            message = public_error(exc)
            finish_job(True, message)
            self.send_html(self.render(
                "거래처 금액",
                f"<p>{esc(message)}</p><p><a href='{self.href('balance')}'>돌아가기</a></p>",
            ))
            return
        self.redirect(self.href("balance", warn="1"))

    def money(self, value):
        if value is None:
            return ""
        if abs(value - round(value)) < 1e-9:
            return f"{int(round(value)):,}"
        return f"{value:,.1f}"

    def banner(self):
        if not job_running():
            return ""
        title = esc(job_snapshot()["title"] or "작업")
        return f'<a class="banner" href="{self.href("job")}">{title} 진행 중 · 눌러서 보기</a>'

    def stock_page(self):
        category = self.field("category", self.query)
        month, rows = load_stock(category)
        chips = [f'<a href="{self.href("stock")}">전체</a>']
        for name in sheet_jobs.CATEGORY_PREFIX:
            chips.append(f'<a href="{self.href("stock", category=name)}">{esc(name)}</a>')
        body = [
            f"<h1>{esc(month)} 재고</h1>",
            f'<div class="chips">{"".join(chips)}</div>',
            '<input id="q" placeholder="품목 또는 코드" oninput="filterRows()">',
            "<table><tr><th>품목</th><th>현재</th><th>기초</th><th>입고</th><th>사용</th></tr>",
        ]
        for item in rows:
            klass = "neg" if is_negative(item["stock"]) else ""
            body.append(
                f"<tr data-name='{esc(item['name'])} {esc(item['code'])}'>"
                f"<td>{esc(item['name'])}<br><span class='muted'>{esc(item['code'])}</span></td>"
                f"<td class='{klass}'>{esc(item['display'])}</td>"
                f"<td>{esc(item['opening'])}</td><td>{esc(item['incoming'])}</td><td>{esc(item['used'])}</td></tr>"
            )
        if not rows:
            body.append("<tr><td colspan='5'>이 달의 재고 행이 없습니다.</td></tr>")
        body.append("</table>")
        body.append("<script>function filterRows(){var q=document.getElementById('q').value.trim().toLowerCase();document.querySelectorAll('tr[data-name]').forEach(function(tr){tr.style.display=tr.getAttribute('data-name').toLowerCase().indexOf(q)>=0?'':'none';});}</script>")
        return self.render("재고", "".join(body))

    def inspect_page(self):
        pending_only = self.field("pending", self.query) == "1"
        month, rows = sheet_jobs.load_inspection()
        if pending_only:
            visible = [row for row in rows if not row["checked"]]
            if not visible and rows:
                pending_only = False
                visible = rows
        else:
            visible = rows
        waiting = sum(1 for row in rows if not row["checked"])
        toggle = (
            f'<a href="{self.href("inspect")}">전체 {len(rows)}건 보기</a>'
            if pending_only else
            f'<a href="{self.href("inspect", pending="1")}">대기 {waiting}건만 보기</a>'
        )
        body = [
            f"<h1>{esc(month)} 실물 검수</h1>",
            f"<p class='note'>대기 {waiting}건. {toggle}</p>",
            f'<form method="post" action="{self.href("inspect")}">',
        ]
        if not visible:
            body.append("<p>검수할 입고가 없습니다.</p>")
        for row in visible:
            checked = " checked" if row["checked"] else ""
            nocode = " nocode" if not row["code"] else ""
            body.append(
                f'<input type="hidden" name="shown" value="{row["row"]}">'
                f'<label class="rowcheck{nocode}"><input type="checkbox" name="checked" value="{row["row"]}"{checked}>'
                f'<span><b>{esc(row["name"])}</b><br>'
                f'<span class="muted">{esc(row["date"])} {esc(row["vendor"])} · {esc(row["spec"])} · 수량 {esc(row["qty"])}'
                f' · {esc(row["code"] or "코드 없음")} · 반영 {esc(row["final"])}</span></span></label>'
            )
        body.append('<div class="sticky"><button type="submit">시트에 반영</button></div></form>')
        body.append("<p class='note'>체크는 검수 표시만 바꿉니다. 재고 수량은 재고 계산을 누를 때 반영됩니다.</p>")
        return self.render("실물 검수", "".join(body))

    def save_inspect(self):
        month, rows = sheet_jobs.load_inspection()
        shown = {int(value) for value in self.form.get("shown", []) if str(value).isdigit()}
        checked = {int(value) for value in self.form.get("checked", []) if str(value).isdigit()}
        changes = []
        for row in rows:
            if row["row"] not in shown:
                continue
            want = row["row"] in checked
            if want != row["checked"]:
                changes.append({"row": row["row"], "checked": want})
        _error, message = sheet_jobs.save_inspection(month, changes)
        self.send_html(self.render("실물 검수", f"<p>{esc(message).replace(chr(10), '<br>')}</p><p><a href='{self.href('inspect', pending='1')}'>검수로 돌아가기</a></p>"))

    def register_list_page(self):
        groups, _master = sheet_jobs.load_unregistered()
        body = [f"<h1>코드 없는 입고 {len(groups)}종</h1>"]
        if not groups:
            body.append("<p>등록할 품목이 없습니다.</p>")
        for group in groups:
            unit = " / ".join(group["units"])
            body.append(
                f'<a class="btn" href="{self.href("register", "form", key=group["key"])}">'
                f'<b>{esc(group["name"])}</b><br><span class="muted">{len(group["rows"])}건 · {esc(unit)}</span></a>'
            )
        body.append("<p class='note'>같은 물건인데 영수증 이름이 다르면 새 코드를 만들지 말고, 이미 있는 품목에 연결하세요. 재고는 코드별로 합쳐집니다.</p>")
        return self.render("미등록 품목", "".join(body))

    def register_form_page(self):
        key = self.field("key", self.query)
        group, _groups, master = find_group(key)
        if group is None:
            return self.render("미등록 품목", f"<p>이 품목을 찾지 못했습니다. 이미 코드가 들어갔을 수 있습니다.</p><p><a href='{self.href('register')}'>목록</a></p>")
        category = self.field("category", self.query) or "기타"
        if category not in sheet_jobs.CATEGORY_PREFIX:
            category = "기타"
        suggested = sheet_jobs.suggest_material_code(master, category)
        name = self.field("name", self.query) or group["name"]
        unit = group["units"][0] if group["units"] else ""
        stock_unit = "kg" if "kg" in unit.lower() else "개"
        options = []
        for code in sheet_jobs.CATEGORY_PREFIX:
            selected = " selected" if code == category else ""
            options.append(f'<option value="{esc(code)}"{selected}>{esc(code)}</option>')
        materials = []
        for code, info in sorted(master.items()):
            alias = " / ".join(info.get("aliases") or [])
            label = f'{code}  {info.get("name") or ""}'
            if alias:
                label += f"  ({alias})"
            materials.append(f'<option value="{esc(code)}">{esc(label)}</option>')
        body = f"""
        <h1>{esc(group["name"])}</h1>
        <p class="note">{len(group["rows"])}건 · {esc(" / ".join(group["units"]))}</p>
        <form method="post" action="{self.href('register')}">
          <input type="hidden" name="key" value="{esc(key)}">
          <label class="checkline"><input type="radio" name="mode" value="new" checked onchange="syncMode()"> 새 품목</label>
          <label class="checkline"><input type="radio" name="mode" value="link" onchange="syncMode()"> 기존 품목에 연결</label>
          <div id="newFields">
          <label class="field">구분</label>
          <select name="category" onchange="var u=new URL(location.href);u.searchParams.set('category',this.value);var n=document.querySelector('[name=name]');if(n&&n.value)u.searchParams.set('name',n.value);location.href=u;">{"".join(options)}</select>
          <label class="field">원재료명</label>
          <input name="name" value="{esc(name)}">
          <label class="field">원재료코드</label>
          <input name="code" value="{esc(suggested)}">
          <label class="field">입고단위/규격</label>
          <input name="spec" value="{esc(unit)}">
          <label class="field">재고수환산</label>
          <input name="conversion" value="1" inputmode="decimal">
          <label class="field">재고단위</label>
          <select name="stock_unit"><option{" selected" if stock_unit == "개" else ""}>개</option><option{" selected" if stock_unit == "kg" else ""}>kg</option></select>
          </div>
          <div id="linkFields" style="display:none">
          <label class="field">연결할 기존 품목</label>
          <select name="link_code">{"".join(materials)}</select>
          </div>
          <button type="submit">저장</button>
          <script>function syncMode(){{var link=document.querySelector('input[name=mode][value=link]').checked;document.getElementById('newFields').style.display=link?'none':'';document.getElementById('linkFields').style.display=link?'':'none';}}</script>
        </form>
        <p class="note">새 품목은 추천 코드를 확인한 뒤 저장하세요. 연결은 영수증 이름을 그 품목의 별칭으로 기억합니다.</p>
        """
        return self.render("품목 등록", body)

    def save_register(self):
        key = self.field("key")
        group, _groups, _master = find_group(key)
        if group is None:
            self.send_html(self.render("미등록 품목", f"<p>이 품목을 찾지 못했습니다.</p><p><a href='{self.href('register')}'>목록</a></p>"))
            return
        mode = self.field("mode")
        if mode == "link":
            code = self.field("link_code")
            name = ""
        else:
            mode = "new"
            code = self.field("code")
            name = self.field("name")
        error, message = sheet_jobs.register_unregistered(
            mode, group["name"], group["rows"], code, name,
            self.field("category"), self.field("spec"), self.field("conversion"), self.field("stock_unit"),
        )
        back = self.href("register", "form", key=key) if error else self.href("register")
        label = "다시 입력" if error else "목록으로"
        self.send_html(self.render("품목 등록", f"<p>{esc(message).replace(chr(10), '<br>')}</p><p><a href='{back}'>{label}</a></p>"))

    def start_action(self, action):
        spec = ACTIONS.get(action)
        if spec is None:
            self.redirect(self.href())
            return
        title, func = spec
        if not begin_job(title):
            self.send_html(self.render(title, f"<p>이미 다른 작업이 진행 중입니다.</p><p><a href='{self.href('job')}'>진행 상황</a></p>"))
            return

        def work():
            error, message = False, ""
            try:
                error, message = func(append_log)
            except Exception as exc:
                error, message = True, public_error(exc)
            finally:
                finish_job(error, message)

        threading.Thread(target=work, daemon=True).start()
        self.redirect(self.href("job"))

    def job_page(self):
        job = job_snapshot()
        title = job["title"] or "작업"
        lines = "<br>".join(esc(line) for line in job["lines"]) or "기다리는 중"
        if job["running"]:
            body = f"<h1>{esc(title)}</h1><p>컴퓨터에서 실행 중입니다.</p><p class='log'>{lines}</p>"
            refresh = "2"
        else:
            message = esc(job["message"]).replace("\n", "<br>") or "진행 중인 작업이 없습니다."
            body = f"<h1>{esc(title)}</h1><p>{message}</p><p class='log'>{lines}</p><p><a href='{self.href()}'>처음으로</a></p>"
            refresh = ""
        return self.render(title, body, refresh=refresh)


def find_group(key):
    groups, master = sheet_jobs.load_unregistered()
    for group in groups:
        if group["key"] == key:
            return group, groups, master
    return None, groups, master


def esc(value):
    return html.escape(str(value or ""), quote=True)


def page(title, body, banner="", refresh=""):
    refresh_tag = f'<meta http-equiv="refresh" content="{esc(refresh)}">' if refresh else ""
    return f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{refresh_tag}
<title>{esc(title)}</title>
<style>
body {{ margin:0; background:#f3f0ea; color:#1c1c1c; font-family:"Malgun Gothic",sans-serif; }}
header {{ background:#1e3329; color:#f7f4ee; padding:16px 16px 12px; }}
header h1 {{ margin:0; font-size:20px; }}
.banner {{ display:block; background:#8a3324; color:#fff; text-decoration:none; padding:10px 16px; }}
nav.nav {{ display:flex; gap:6px; margin:-14px -14px 12px; padding:10px 12px; background:#2c4a3b; }}
nav.nav a {{ flex:1; text-align:center; color:#f7f4ee; text-decoration:none; font-size:14px; padding:8px 0; }}
main {{ padding:14px; }}
h1 {{ font-size:20px; margin:6px 0 10px; }}
a.btn, button {{ display:block; width:100%; box-sizing:border-box; margin:8px 0; padding:14px 16px; border:1px solid #ddd6cb; border-radius:12px; background:#fff; color:#1c1c1c; font-size:16px; text-align:left; text-decoration:none; }}
button.danger {{ background:#f8ece8; color:#8a3324; }}
input, select {{ width:100%; box-sizing:border-box; font-size:16px; padding:12px; margin:4px 0 12px; border:1px solid #ddd6cb; border-radius:10px; background:#fff; }}
label.field {{ display:block; color:#5e584f; font-size:13px; }}
label.checkline {{ display:block; margin:8px 0; font-size:16px; }}
table {{ width:100%; border-collapse:collapse; background:#fff; }}
td, th {{ padding:8px; border-bottom:1px solid #eee6dc; font-size:14px; text-align:left; vertical-align:top; }}
.neg {{ color:#8a3324; font-weight:700; }}
.muted {{ color:#6d675e; font-size:12px; }}
.note {{ color:#5e584f; font-size:13px; line-height:1.45; }}
.chips a {{ display:inline-block; margin:4px 6px 8px 0; padding:6px 10px; background:#fff; border:1px solid #ddd6cb; border-radius:999px; text-decoration:none; color:#1e3329; font-size:13px; }}
.rowcheck {{ display:flex; gap:12px; align-items:flex-start; background:#fff; border-bottom:1px solid #eee6dc; padding:12px; }}
.rowcheck input {{ width:22px; height:22px; margin:2px 0 0; }}
.nocode {{ background:#fff6d8; }}
.sticky {{ position:sticky; bottom:0; background:#f3f0ea; padding:8px 0 4px; }}
.log {{ background:#fff; border-radius:10px; padding:12px; line-height:1.5; }}
</style>
</head>
<body>
{banner}
<header><h1>중계고기파티 재고</h1></header>
<main>{body}</main>
</body>
</html>"""
