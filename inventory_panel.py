import threading
import tkinter as tk
from tkinter import messagebox, ttk

import mobile_web
import okpos_crawler
import sheet_jobs


def run_pos_sales(log, period="today"):
    if period == "month":
        log("OKPOS에서 이번 달 1일부터 오늘까지 판매를 가져옵니다. 브라우저 창은 뜨지 않습니다.")
    else:
        log("OKPOS에서 오늘 판매를 가져옵니다. 브라우저 창은 뜨지 않습니다.")
    result = okpos_crawler.main(show_dialog=False, period=period)
    message = result.get("text") or "완료되었습니다."
    return bool(result.get("error")), message


JOBS = [
    {
        "title": "1. 영수증 OCR 입고 등록",
        "desc": "입고대기 폴더의 명세서를 읽어 원재료입고에 기록합니다. 사업자번호, 영수증합계금액, 당월누적금액도 같이 넣습니다.",
        "run": sheet_jobs.process_receipts_ocr,
        "confirm": None,
        "bg": "#ffffff",
        "fg": "#1c1c1c",
    },
    {
        "title": "2. 미등록 품목 등록",
        "desc": "코드 없는 입고를 새 원재료로 등록하거나, 이미 있는 품목에 연결합니다.",
        "run": None,
        "register": True,
        "confirm": None,
        "bg": "#ffffff",
        "fg": "#1c1c1c",
    },
    {
        "title": "3. 입고 수량 환산",
        "desc": "열린 달의 최종반영수량을 다시 계산합니다. 고기류는 무게, 그 외는 재고수환산 × 영수증 수량입니다.",
        "run": sheet_jobs.update_receipt_quantities,
        "confirm": None,
        "bg": "#ffffff",
        "fg": "#1c1c1c",
    },
    {
        "title": "4. 실물 검수",
        "desc": "열린 달 입고를 목록에서 체크합니다. 재고 수량은 재고 계산 때 반영됩니다.",
        "run": None,
        "inspect": True,
        "confirm": None,
        "bg": "#ffffff",
        "fg": "#1c1c1c",
    },
    {
        "title": "5. POS 판매내역 가져오기",
        "desc": "당일 또는 이번 달을 고른 뒤 누르세요. 이번 달은 1일부터 오늘까지입니다.",
        "run": run_pos_sales,
        "choose_period": True,
        "confirm": None,
        "bg": "#ffffff",
        "fg": "#1c1c1c",
    },
    {
        "title": "6. 실시간 재고 계산",
        "desc": "열린 달의 입고와 판매만 다시 계산합니다. 결과는 상단 실시간 재고에서 보고, 안전재고와 조정을 고칠 수 있습니다.",
        "run": sheet_jobs.calculate_inventory,
        "confirm": None,
        "bg": "#ffffff",
        "fg": "#1c1c1c",
    },
    {
        "title": "7. 거래처 금액 검증",
        "desc": "검증대상이 Y인 거래처만 봅니다. 확인요망 줄의 수금은 직접 입력하고, 검증 계산을 다시 누르면 반영됩니다.",
        "run": None,
        "balance": True,
        "confirm": None,
        "bg": "#ffffff",
        "fg": "#1c1c1c",
    },
    {
        "title": "8. 월마감 진행",
        "desc": "이번 달 행은 남기고, 남은 재고를 다음 달 기초재고로 같은 시트에 추가합니다.",
        "run": sheet_jobs.monthly_close,
        "confirm": (
            "월마감 진행",
            "이번 달 기록은 그대로 두고,\n남은 재고를 다음 달 기초재고로 같은 시트에 추가할까요?",
        ),
        "bg": "#f8ece8",
        "fg": "#8a3324",
    },
]


class App:
    def __init__(self, root):
        self.root = root
        self.busy = False
        self.running_job = None
        self.buttons = []
        self.sales_period = tk.StringVar(value="today")
        root.title("중계고기파티 재고관리")
        root.configure(bg="#f3f0ea")
        root.geometry("460x1100")
        root.minsize(420, 1000)
        root.protocol("WM_DELETE_WINDOW", self.on_close)

        header = tk.Frame(root, bg="#1e3329")
        header.pack(fill="x")
        title_row = tk.Frame(header, bg="#1e3329")
        title_row.pack(fill="x", padx=18, pady=(16, 2))
        tk.Label(
            title_row, text="중계고기파티 재고관리", bg="#1e3329", fg="#f7f4ee",
            font=("Malgun Gothic", 16, "bold"), anchor="w",
        ).pack(side="left")
        tk.Button(
            title_row, text="실시간 재고", command=self.open_stock,
            bg="#f3efe4", fg="#1e3329", activebackground="#ffffff", activeforeground="#1e3329",
            font=("Malgun Gothic", 9, "bold"), bd=0, padx=8, pady=4, cursor="hand2",
        ).pack(side="right", padx=(0, 6))
        tk.Button(
            title_row, text="단가 추이", command=self.open_prices,
            bg="#f3efe4", fg="#1e3329", activebackground="#ffffff", activeforeground="#1e3329",
            font=("Malgun Gothic", 9, "bold"), bd=0, padx=10, pady=4, cursor="hand2",
        ).pack(side="right", padx=(0, 6))
        tk.Button(
            title_row, text="스마트폰", command=self.show_phone,
            bg="#f3efe4", fg="#1e3329", activebackground="#ffffff", activeforeground="#1e3329",
            font=("Malgun Gothic", 9, "bold"), bd=0, padx=10, pady=4, cursor="hand2",
        ).pack(side="right")
        tk.Label(
            header, text="버튼을 누르면 백그라운드에서 실행됩니다.\n스마트폰 버튼은 같은 와이파이의 폰에서 이 기능을 엽니다.",
            bg="#1e3329", fg="#d5ddd6", font=("Malgun Gothic", 10), justify="left", anchor="w",
        ).pack(fill="x", padx=22, pady=(0, 16))

        body = tk.Frame(root, bg="#f3f0ea")
        body.pack(fill="both", expand=True, padx=18, pady=16)
        for job in JOBS:
            self.buttons.append(self.make_button(body, job))

        self.status = tk.Label(
            root, text="대기 중", bg="#f3f0ea", fg="#6d675e",
            font=("Malgun Gothic", 9), anchor="w",
        )
        self.status.pack(fill="x", padx=22)

        log_frame = tk.Frame(root, bg="#f3f0ea")
        log_frame.pack(fill="both", expand=True, padx=18, pady=(4, 8))
        self.log = tk.Text(
            log_frame, height=8, wrap="word", bd=0, bg="#fffdf9", fg="#2b2b2b",
            font=("Malgun Gothic", 9), padx=10, pady=8,
        )
        self.log.pack(fill="both", expand=True)
        self.log.configure(state="disabled")
        tk.Label(
            root, text="실물 검수는 위 버튼에서 할 수 있습니다. 재고 수량은 재고 계산 때 반영됩니다.",
            bg="#f3f0ea", fg="#8a847a", font=("Malgun Gothic", 8), anchor="w",
        ).pack(fill="x", padx=22, pady=(0, 12))

    def make_button(self, parent, job):
        frame = tk.Frame(parent, bg=job["bg"], highlightbackground="#ddd6cb", highlightthickness=1, cursor="hand2")
        frame.pack(fill="x", pady=5)
        title = tk.Label(frame, text=job["title"], bg=job["bg"], fg=job["fg"], font=("Malgun Gothic", 13, "bold"), anchor="w")
        desc = tk.Label(frame, text=job["desc"], bg=job["bg"], fg="#5e584f", font=("Malgun Gothic", 9), anchor="w")
        title.pack(fill="x", padx=16, pady=(11, 0))
        desc.pack(fill="x", padx=16, pady=(2, 4 if job.get("choose_period") else 11))
        extras = []
        if job.get("choose_period"):
            period_row = tk.Frame(frame, bg=job["bg"])
            period_row.pack(fill="x", padx=16, pady=(0, 10))
            extras.append(period_row)
            for text, value in (("당일", "today"), ("이번 달", "month")):
                radio = tk.Radiobutton(
                    period_row, text=text, value=value, variable=self.sales_period,
                    bg=job["bg"], fg=job["fg"], selectcolor="#ffffff",
                    activebackground=job["bg"], activeforeground=job["fg"],
                    font=("Malgun Gothic", 10), anchor="w",
                )
                radio.pack(side="left", padx=(0, 16))
                extras.append(radio)
        for widget in (frame, title, desc):
            widget.bind("<Button-1>", lambda _event, item=job: self.start(item))
        return frame, title, desc, job, extras

    def refresh_cards(self):
        for frame, title, desc, job, extras in self.buttons:
            running = self.busy and job is self.running_job
            if running:
                bg, fg, desc_fg = "#1e3329", "#f7f4ee", "#d5ddd6"
                title_text = "실행 중  ·  " + job["title"]
                frame.configure(highlightbackground="#163028", highlightthickness=2)
            elif self.busy:
                bg, fg, desc_fg = "#e7e2d8", "#9a948a", "#9a948a"
                title_text = job["title"]
                frame.configure(highlightbackground="#ddd6cb", highlightthickness=1)
            else:
                bg, fg, desc_fg = job["bg"], job["fg"], "#5e584f"
                title_text = job["title"]
                frame.configure(highlightbackground="#ddd6cb", highlightthickness=1)
            frame.configure(bg=bg, cursor="watch" if self.busy else "hand2")
            title.configure(bg=bg, fg=fg, text=title_text, cursor="watch" if self.busy else "hand2")
            desc.configure(bg=bg, fg=desc_fg, cursor="watch" if self.busy else "hand2")
            for widget in extras:
                if isinstance(widget, tk.Frame):
                    widget.configure(bg=bg)
                else:
                    widget.configure(bg=bg, fg=fg, activebackground=bg, activeforeground=fg)

    def write_log(self, message):
        def append():
            self.log.configure(state="normal")
            self.log.insert("end", message + "\n")
            self.log.see("end")
            self.log.configure(state="disabled")
        self.root.after(0, append)

    def mark_running(self, job):
        self.busy = True
        self.running_job = job
        self.refresh_cards()
        self.status.configure(text=f"실행 중: {job['title']}", fg="#1e3329")
        self.root.update_idletasks()

    def mark_idle(self, text="대기 중"):
        self.busy = False
        self.running_job = None
        self.refresh_cards()
        self.status.configure(text=text, fg="#6d675e")

    def start(self, job):
        if self.busy:
            current = self.running_job["title"] if self.running_job else "작업"
            self.status.configure(text=f"이미 실행 중: {current}. 끝날 때까지 기다려 주세요.", fg="#8a3324")
            return
        self.mark_running(job)
        if job.get("inspect") or job.get("register") or job.get("balance"):
            openers = {
                "inspect": self.open_inspection,
                "register": self.open_register,
                "balance": self.open_balance,
            }
            key = "inspect" if job.get("inspect") else "register" if job.get("register") else "balance"
            try:
                openers[key]()
            finally:
                self.mark_idle()
            return
        if job["confirm"]:
            title, question = job["confirm"]
            if not messagebox.askyesno(title, question):
                self.mark_idle("취소했습니다")
                return
        if mobile_web.job_running():
            self.mark_idle("대기 중")
            messagebox.showinfo("실행 중", "스마트폰에서 작업이 진행 중입니다. 끝난 뒤에 다시 눌러 주세요.")
            return
        period = self.sales_period.get() if job.get("choose_period") else None
        period_label = {"today": "당일", "month": "이번 달"}.get(period, "")
        suffix = f" ({period_label})" if period_label else ""
        self.write_log(f"시작: {job['title']}{suffix}")
        threading.Thread(target=self.worker, args=(job, period), daemon=True).start()

    def worker(self, job, period):
        if not mobile_web.begin_job(job["title"]):
            self.root.after(0, lambda: self.finish(job, True, "스마트폰에서 작업이 진행 중입니다. 끝난 뒤에 다시 눌러 주세요."))
            return
        error, message = False, ""
        try:
            def log(text):
                mobile_web.append_log(text)
                self.write_log(text)
            if period:
                error, message = job["run"](log, period)
            else:
                error, message = job["run"](log)
        except Exception as exc:
            error, message = True, "실행 중 오류가 났습니다.\n" + mobile_web.public_error(exc)
        finally:
            mobile_web.finish_job(error, message)
        self.root.after(0, lambda error=error, message=message: self.finish(job, error, message))

    def finish(self, job, error, message):
        self.mark_idle()
        self.write_log(message)
        if error:
            messagebox.showerror(job["title"], message)
        else:
            messagebox.showinfo(job["title"], message)

    def open_register(self):
        window = getattr(self, "register_window", None)
        if window is not None and window.winfo_exists():
            window.lift()
            return
        self.register_window = RegisterWindow(self)

    def open_stock(self):
        window = getattr(self, "stock_window", None)
        if window is not None and window.winfo_exists():
            window.lift()
            return
        self.stock_window = LiveStockWindow(self)

    def open_prices(self):
        window = getattr(self, "price_window", None)
        if window is not None and window.winfo_exists():
            window.lift()
            return
        self.price_window = PriceTrendWindow(self)

    def open_balance(self):
        window = getattr(self, "balance_window", None)
        if window is not None and window.winfo_exists():
            window.lift()
            return
        self.balance_window = BalanceWindow(self)

    def open_inspection(self):
        window = getattr(self, "inspection_window", None)
        if window is not None and window.winfo_exists():
            window.lift()
            return
        self.inspection_window = InspectionWindow(self)

    def show_phone(self):
        window = getattr(self, "phone_window", None)
        if window is not None and window.winfo_exists():
            window.lift()
            return
        try:
            info = mobile_web.ensure_server()
        except Exception as exc:
            messagebox.showerror("스마트폰", "주소를 만들지 못했습니다.\n" + mobile_web.public_error(exc))
            return
        self.phone_window = PhoneWindow(self.root, info)

    def on_close(self):
        if self.busy or mobile_web.job_running():
            messagebox.showinfo("실행 중", "작업이 끝난 뒤에 닫을 수 있습니다.")
            return
        self.root.destroy()


class PhoneWindow(tk.Toplevel):
    def __init__(self, master, info):
        super().__init__(master)
        self.info = info
        self.title("스마트폰에서 열기")
        self.configure(bg="#f3f0ea")
        self.geometry("420x640")
        self.minsize(360, 520)
        tk.Label(
            self, text="삼성폰 브라우저에서 이 주소를 여세요.",
            bg="#f3f0ea", fg="#1c1c1c", font=("Malgun Gothic", 12, "bold"),
        ).pack(anchor="w", padx=18, pady=(16, 4))
        tk.Label(
            self, text="같은 와이파이에 연결되어 있어야 합니다.\n이 프로그램을 끄면 폰에서도 끊깁니다.",
            bg="#f3f0ea", fg="#5e584f", font=("Malgun Gothic", 9), justify="left",
        ).pack(anchor="w", padx=18)
        try:
            self.qr_image = mobile_web.qr_photo(self, info["url"], scale=7)
            tk.Label(self, image=self.qr_image, bg="#f3f0ea").pack(pady=12)
        except Exception:
            tk.Label(self, text="QR을 만들지 못했습니다. 아래 주소를 입력하세요.", bg="#f3f0ea", fg="#8a3324").pack(pady=12)
        url = tk.Entry(self, font=("Consolas", 11), justify="center", readonlybackground="#fffdf9")
        url.insert(0, info["url"])
        url.configure(state="readonly")
        url.pack(fill="x", padx=18, pady=(0, 8))
        tk.Button(
            self, text="주소 복사", command=self.copy_url,
            bg="#1e3329", fg="#f7f4ee", activebackground="#2c4a3b", activeforeground="#f7f4ee",
            font=("Malgun Gothic", 10, "bold"), bd=0, padx=12, pady=8, cursor="hand2",
        ).pack(pady=(0, 8))
        if info.get("firewall"):
            tk.Label(
                self, text=info["firewall"], bg="#f3f0ea", fg="#8a3324",
                font=("Malgun Gothic", 9), wraplength=360, justify="left",
            ).pack(anchor="w", padx=18, pady=(4, 8))

    def copy_url(self):
        self.clipboard_clear()
        self.clipboard_append(self.info["url"])
        self.update()


class BalanceWindow(tk.Toplevel):
    columns = ("vendor", "date", "daily", "payment", "month", "check_total", "status")
    headings = {
        "vendor": "거래처",
        "date": "거래일자",
        "daily": "영수증합계금액",
        "payment": "수금",
        "month": "당월누적금액",
        "check_total": "검증누계금액",
        "status": "검증",
    }
    widths = {
        "vendor": 180,
        "date": 110,
        "daily": 130,
        "payment": 110,
        "month": 130,
        "check_total": 130,
        "status": 90,
    }

    def __init__(self, app):
        super().__init__(app.root)
        self.app = app
        self.rows = []
        self.warn_only = True
        self.working = False
        self.editor = None
        self.edit_item = None
        self.title("거래처 금액 검증")
        self.configure(bg="#f3f0ea")
        self.geometry("1120x580")
        self.minsize(820, 420)
        self.transient(app.root)

        header = tk.Frame(self, bg="#1e3329")
        header.pack(fill="x")
        self.heading = tk.Label(
            header, text="거래처 금액을 불러오는 중...", bg="#1e3329", fg="#f7f4ee",
            font=("Malgun Gothic", 16, "bold"), anchor="w",
        )
        self.heading.pack(fill="x", padx=18, pady=(14, 12))

        tools = tk.Frame(self, bg="#f3f0ea")
        tools.pack(fill="x", padx=14, pady=(10, 4))
        self.calc_button = tk.Button(
            tools, text="검증 계산", command=self.rebuild,
            font=("Malgun Gothic", 9, "bold"), bg="#1e3329", fg="#f7f4ee",
            activebackground="#2c4a3b", activeforeground="#f7f4ee", relief="flat", padx=10,
        )
        self.calc_button.pack(side="left")
        self.filter_button = tk.Button(
            tools, text="전체 보기", command=self.toggle_filter,
            font=("Malgun Gothic", 9), bg="#ffffff", relief="groove",
        )
        self.filter_button.pack(side="left", padx=(8, 0))
        tk.Button(
            tools, text="다시 불러오기", command=self.load,
            font=("Malgun Gothic", 9), bg="#ffffff", relief="groove",
        ).pack(side="left", padx=(8, 0))

        style = ttk.Style(self)
        style.configure("Balance.Treeview", font=("Malgun Gothic", 10), rowheight=26)
        style.configure("Balance.Treeview.Heading", font=("Malgun Gothic", 10, "bold"))
        table = tk.Frame(self, bg="#f3f0ea")
        table.pack(fill="both", expand=True, padx=14, pady=6)
        self.tree = ttk.Treeview(table, columns=self.columns, show="headings", style="Balance.Treeview")
        for name in self.columns:
            anchor = "e" if name in ("daily", "payment", "month", "check_total") else "w"
            self.tree.heading(name, text=self.headings[name])
            self.tree.column(name, width=self.widths[name], anchor=anchor, stretch=(name == "vendor"))
        scroll = ttk.Scrollbar(table, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.tree.tag_configure("ok", background="#ffffff")
        self.tree.tag_configure("warn", background="#f8ece8")
        self.tree.bind("<Button-1>", self.begin_edit)
        self.tree.bind("<MouseWheel>", lambda _event: self.commit_edit())

        footer = tk.Frame(self, bg="#f3f0ea")
        footer.pack(fill="x", padx=14, pady=(0, 12))
        tk.Label(
            footer,
            text="수금 칸을 누르면 금액을 넣을 수 있습니다. 검증 계산을 누르면 그 금액이 반영되고, 비우면 0원입니다.",
            bg="#f3f0ea", fg="#8a847a", font=("Malgun Gothic", 8), anchor="w", wraplength=1080, justify="left",
        ).pack(fill="x")
        self.load()

    def load(self):
        if self.working:
            return
        self.heading.configure(text="거래처 금액을 불러오는 중...")

        def work():
            try:
                rows = sheet_jobs.load_vendor_balances()
                error = ""
            except Exception as exc:
                rows = []
                error = mobile_web.public_error(exc)
            self.after(0, lambda: self.show(rows, error))

        threading.Thread(target=work, daemon=True).start()

    def rebuild(self):
        if self.working:
            return
        self.commit_edit()
        payments = [
            {
                "vendor": row["vendor"],
                "date": row["date"],
                "daily": row.get("daily"),
                "payment": row.get("payment"),
            }
            for row in self.rows
        ]
        self.working = True
        self.calc_button.configure(state="disabled")
        self.heading.configure(text="검증 계산 중...")

        def work():
            message = ""
            locked = False
            try:
                if not mobile_web.begin_job("거래처 금액 검증"):
                    rows = []
                    error = "다른 작업이 진행 중입니다. 끝난 뒤에 다시 눌러 주세요."
                else:
                    locked = True
                    _error, message = sheet_jobs.rebuild_vendor_balances(payments=payments)
                    rows = sheet_jobs.load_vendor_balances()
                    error = ""
            except Exception as exc:
                rows = []
                error = mobile_web.public_error(exc)
                message = error
            finally:
                if locked:
                    mobile_web.finish_job(bool(error), message)
            self.after(0, lambda: self.show_rebuilt(rows, error, message))

        threading.Thread(target=work, daemon=True).start()

    def show_rebuilt(self, rows, error, message):
        self.working = False
        self.calc_button.configure(state="normal")
        self.show(rows, error)
        if error:
            return
        messagebox.showinfo("거래처 금액 검증", message, parent=self)

    def show(self, rows, error):
        self.rows = rows
        if error:
            self.heading.configure(text="불러오지 못했습니다")
            messagebox.showerror("거래처 금액 검증", error, parent=self)
            return
        warnings = sum(1 for row in rows if row["status"] != "OK")
        if self.warn_only and warnings == 0 and rows:
            self.warn_only = False
        self.fill()
        self.heading.configure(text=f"확인요망 {warnings}건 · 전체 {len(rows)}건")

    def toggle_filter(self):
        self.warn_only = not self.warn_only
        self.fill()

    def fill(self):
        self.commit_edit()
        self.filter_button.configure(text="전체 보기" if self.warn_only else "확인요망만")
        self.tree.delete(*self.tree.get_children())
        for row in self.rows:
            if self.warn_only and row["status"] == "OK":
                continue
            tag = "warn" if row["status"] != "OK" else "ok"
            self.tree.insert("", "end", values=(
                row["vendor"],
                row["date"],
                self.money(row["daily"]),
                self.money(row.get("payment")),
                self.money(row["month"]),
                self.money(row.get("check_total")),
                row["status"] or "확인요망",
            ), tags=(tag,))

    def begin_edit(self, event):
        if self.working:
            return
        row_id = self.tree.identify_row(event.y)
        column = self.tree.identify_column(event.x)
        if column != "#4" or not row_id:
            self.commit_edit()
            return
        if self.editor is not None and self.edit_item == row_id:
            return
        self.commit_edit()
        box = self.tree.bbox(row_id, column)
        if not box:
            return
        x, y, width, height = box
        current = str(self.tree.set(row_id, "payment") or "").replace(",", "")
        self.editor = tk.Entry(self.tree, font=("Malgun Gothic", 10), justify="right", bg="#fffdf6")
        self.editor.insert(0, current)
        self.editor.select_range(0, "end")
        self.editor.place(x=x, y=y, width=width, height=height)
        self.editor.focus_set()
        self.edit_item = row_id
        self.editor.bind("<Return>", self.commit_edit)
        self.editor.bind("<Escape>", self.cancel_edit)
        self.after(80, self.bind_edit_focus)
        return "break"

    def bind_edit_focus(self):
        if self.editor is not None:
            self.editor.bind("<FocusOut>", self.commit_edit)

    def cancel_edit(self, _event=None):
        editor = self.editor
        self.editor = None
        self.edit_item = None
        if editor is not None:
            editor.destroy()
        return "break"

    def commit_edit(self, _event=None):
        editor = self.editor
        row_id = self.edit_item
        if editor is None or row_id is None:
            return
        self.editor = None
        self.edit_item = None
        text = editor.get().strip().replace(",", "").replace("원", "")
        editor.destroy()
        if text:
            try:
                number = float(text)
            except ValueError:
                self.heading.configure(text="수금에는 숫자만 넣을 수 있습니다.")
                return
            if number < 0:
                self.heading.configure(text="수금에는 0 이상의 금액을 넣어 주세요.")
                return
            payment = int(round(number)) if abs(number - round(number)) < 1e-9 else number
        else:
            payment = None
        values = self.tree.item(row_id, "values")
        if not values:
            return
        for row in self.rows:
            if row["vendor"] == values[0] and row["date"] == values[1] and self.money(row.get("daily")) == values[2]:
                row["payment"] = payment
                break
        self.tree.set(row_id, "payment", self.money(payment))
        warnings = sum(1 for row in self.rows if row["status"] != "OK")
        self.heading.configure(text=f"확인요망 {warnings}건 · 전체 {len(self.rows)}건 · 수금 입력 후 검증 계산을 누르세요")

    def money(self, value):
        if value is None:
            return ""
        if abs(value - round(value)) < 1e-9:
            return f"{int(round(value)):,}"
        return f"{value:,.1f}"


class LiveStockWindow(tk.Toplevel):
    columns = (
        ("category", "구분", 70, "w"),
        ("name", "원재료", 160, "w"),
        ("display", "현재고", 100, "e"),
        ("stock", "잔여량", 80, "e"),
        ("safety", "안전재고", 90, "e"),
        ("short", "부족", 70, "e"),
        ("adjustment", "조정(로스)", 90, "e"),
    )
    editable = {"#5": "safety", "#7": "adjustment"}

    def __init__(self, app):
        super().__init__(app.root)
        self.app = app
        self.rows = []
        self.month = ""
        self.category = tk.StringVar(value="전체")
        self.query = tk.StringVar()
        self.low_only = tk.BooleanVar(value=False)
        self.working = False
        self.saving = False
        self.editor = None
        self.edit_item = None
        self.edit_kind = None
        self.title("원재료 실시간 재고")
        self.configure(bg="#f3f0ea")
        self.geometry("1080x680")
        self.minsize(860, 520)
        self.transient(app.root)

        header = tk.Frame(self, bg="#1e3329")
        header.pack(fill="x")
        self.heading = tk.Label(
            header, text="실시간 재고를 불러오는 중...", bg="#1e3329", fg="#f7f4ee",
            font=("Malgun Gothic", 16, "bold"), anchor="w",
        )
        self.heading.pack(fill="x", padx=18, pady=(14, 12))

        tools = tk.Frame(self, bg="#f3f0ea")
        tools.pack(fill="x", padx=14, pady=(10, 4))
        tk.Label(tools, text="구분", bg="#f3f0ea", fg="#5e584f", font=("Malgun Gothic", 10)).pack(side="left")
        self.category_box = ttk.Combobox(
            tools, textvariable=self.category, values=["전체"], state="readonly",
            width=10, font=("Malgun Gothic", 10),
        )
        self.category_box.pack(side="left", padx=(4, 12))
        self.category_box.bind("<<ComboboxSelected>>", lambda _event: self.draw())
        tk.Checkbutton(
            tools, text="안전재고 이하만", variable=self.low_only, command=self.draw,
            bg="#f3f0ea", fg="#1c1c1c", selectcolor="#f3efe4",
            activebackground="#f3f0ea", font=("Malgun Gothic", 10),
        ).pack(side="left")
        tk.Button(
            tools, text="다시 불러오기", command=self.load,
            font=("Malgun Gothic", 9), bg="#ffffff", relief="groove",
        ).pack(side="right")
        self.search = tk.Entry(tools, textvariable=self.query, font=("Malgun Gothic", 10), width=18)
        self.search.pack(side="right", padx=(0, 8))
        tk.Label(tools, text="찾기", bg="#f3f0ea", fg="#5e584f", font=("Malgun Gothic", 10)).pack(side="right")
        self.query.trace_add("write", lambda *_args: self.draw())

        body = tk.Frame(self, bg="#f3f0ea")
        body.pack(fill="both", expand=True, padx=14, pady=6)
        self.tree = ttk.Treeview(body, columns=[name for name, *_rest in self.columns], show="headings")
        for name, label, width, anchor in self.columns:
            self.tree.heading(name, text=label)
            self.tree.column(name, width=width, anchor=anchor)
        self.tree.tag_configure("low", background="#f8ece8")
        self.tree.tag_configure("ok", background="#fffdf9")
        scroll = ttk.Scrollbar(body, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.tree.bind("<Button-1>", self.begin_edit)
        self.tree.bind("<MouseWheel>", lambda _event: self.commit_edit())
        tk.Label(
            self,
            text="안전재고와 조정 칸을 누르면 바로 저장됩니다. 조정은 현재고에 더해집니다. 로스나 폐기는 마이너스로 입력하세요. 안전재고를 비우면 기준이 없습니다.",
            bg="#f3f0ea", fg="#8a847a", font=("Malgun Gothic", 8), anchor="w", wraplength=1040, justify="left",
        ).pack(fill="x", padx=14, pady=(0, 10))
        self.load()

    def load(self):
        if self.working or self.saving:
            return
        self.cancel_edit()
        self.working = True
        self.heading.configure(text="실시간 재고를 불러오는 중...")

        def work():
            try:
                month, rows = sheet_jobs.load_live_stock()
                error = ""
            except Exception as exc:
                month, rows = "", []
                error = mobile_web.public_error(exc)
            self.after(0, lambda: self.show(month, rows, error))

        threading.Thread(target=work, daemon=True).start()

    def show(self, month, rows, error=""):
        self.working = False
        self.month = month
        self.rows = rows
        if error:
            self.heading.configure(text="불러오지 못했습니다")
            messagebox.showerror("원재료 실시간 재고", error, parent=self)
            return
        self.refresh_categories()
        self.draw()

    def refresh_categories(self):
        present = {item.get("category", "") for item in self.rows}
        ordered = [name for name in sheet_jobs.CATEGORY_PREFIX if name in present]
        extras = sorted(name for name in present if name and name not in sheet_jobs.CATEGORY_PREFIX)
        options = ["전체", *ordered, *extras]
        if "" in present:
            options.append("미분류")
        self.category_box["values"] = options
        if self.category.get() not in options:
            self.category.set("전체")

    def visible_rows(self):
        category = self.category.get()
        keyword = self.query.get().strip()
        visible = []
        for item in self.rows:
            item_category = item.get("category") or ""
            if category == "미분류" and item_category:
                continue
            if category and category not in ("전체", "미분류") and item_category != category:
                continue
            if keyword and keyword not in item["name"] and keyword not in item["code"] and keyword not in item_category:
                continue
            if self.low_only.get() and not sheet_jobs.below_safety(item["stock"], item["safety"]):
                continue
            visible.append(item)
        return visible

    def draw(self):
        if self.editor is not None:
            self.commit_edit()
        if self.editor is not None:
            return
        selected = self.tree.selection()
        chosen = selected[0] if selected else None
        self.tree.delete(*self.tree.get_children())
        visible = self.visible_rows()
        low = sum(1 for item in self.rows if sheet_jobs.below_safety(item["stock"], item["safety"]))
        for item in visible:
            short = sheet_jobs.stock_shortage(item["stock"], item["safety"])
            tag = "low" if short is not None else "ok"
            self.tree.insert("", "end", iid=str(item["row"]), values=(
                item.get("category") or "",
                item["name"],
                item.get("display") or self.qty(item["stock"]),
                self.qty(item["stock"]),
                self.qty(item["safety"]),
                self.qty(short),
                self.qty(item["adjustment"]),
            ), tags=(tag,))
        if chosen and self.tree.exists(chosen):
            self.tree.selection_set(chosen)
            self.tree.see(chosen)
        label = self.month or "실시간 재고"
        state = "저장 중..." if self.saving else f"안전재고 이하 {low}개 · 전체 {len(self.rows)}개"
        shown = f" · 표시 {len(visible)}개" if len(visible) != len(self.rows) else ""
        self.heading.configure(text=f"{label} · {state}{shown}")

    def begin_edit(self, event):
        if self.working or self.saving:
            return
        row_id = self.tree.identify_row(event.y)
        column = self.tree.identify_column(event.x)
        kind = self.editable.get(column)
        if not kind or not row_id:
            self.commit_edit()
            return
        if self.editor is not None and self.edit_item == row_id and self.edit_kind == kind:
            return
        self.commit_edit()
        if self.saving:
            return
        box = self.tree.bbox(row_id, column)
        if not box:
            return
        x, y, width, height = box
        field = "safety" if kind == "safety" else "adjustment"
        current = str(self.tree.set(row_id, field) or "").replace(",", "")
        self.editor = tk.Entry(self.tree, font=("Malgun Gothic", 10), justify="right", bg="#fffdf6")
        self.editor.insert(0, current)
        self.editor.select_range(0, "end")
        self.editor.place(x=x, y=y, width=width, height=height)
        self.editor.focus_set()
        self.edit_item = row_id
        self.edit_kind = kind
        self.editor.bind("<Return>", self.commit_edit)
        self.editor.bind("<Escape>", self.cancel_edit)
        self.after(80, self.bind_edit_focus)
        return "break"

    def bind_edit_focus(self):
        if self.editor is not None:
            self.editor.bind("<FocusOut>", self.commit_edit)

    def cancel_edit(self, _event=None):
        editor = self.editor
        self.editor = None
        self.edit_item = None
        self.edit_kind = None
        if editor is not None:
            editor.destroy()
        return "break"

    def commit_edit(self, _event=None):
        editor = self.editor
        row_id = self.edit_item
        kind = self.edit_kind
        if editor is None or row_id is None or not kind:
            return
        self.editor = None
        self.edit_item = None
        self.edit_kind = None
        text = editor.get().strip().replace(",", "")
        editor.destroy()
        if text:
            try:
                number = float(text)
            except ValueError:
                self.heading.configure(text="숫자만 넣을 수 있습니다.")
                return
            value = sheet_jobs.tidy_number(number)
        else:
            value = None
        if kind == "safety" and value is not None and value < 0:
            self.heading.configure(text="안전재고는 0 이상으로 입력하세요.")
            return
        if kind == "adjustment" and value is None:
            value = 0
        item = next((row for row in self.rows if str(row["row"]) == row_id), None)
        if item is None:
            return
        previous = item["safety"] if kind == "safety" else item["adjustment"]
        if previous == value or (previous is None and value is None):
            return
        if kind == "safety":
            item["safety"] = value
        else:
            item["adjustment"] = value
        item["stock"] = sheet_jobs.live_stock_level(
            item["opening"], item["incoming"], item["used"], item["adjustment"],
        )
        self.saving = True
        self.draw()
        self.save_async(item["row"], kind, value)

    def save_async(self, row_number, kind, value):
        def work():
            try:
                stock, display = sheet_jobs.save_live_stock_cell(row_number, kind, value)
                error = ""
            except Exception as exc:
                stock, display = None, ""
                error = mobile_web.public_error(exc)
            self.after(0, lambda: self.saved(row_number, stock, display, error))

        threading.Thread(target=work, daemon=True).start()

    def saved(self, row_number, stock, display, error):
        self.saving = False
        if error:
            messagebox.showerror("원재료 실시간 재고", error, parent=self)
            self.load()
            return
        for item in self.rows:
            if item["row"] != row_number:
                continue
            if stock is not None:
                item["stock"] = stock
            if display:
                item["display"] = display
            break
        self.draw()

    def qty(self, value):
        if value is None or value == "":
            return ""
        number = sheet_jobs.as_number(value)
        if abs(number - round(number)) < 1e-9:
            return f"{int(round(number)):,}"
        return f"{number:,.4f}".rstrip("0").rstrip(".")


class PriceTrendWindow(tk.Toplevel):
    periods = (("1", "최근 1개월", 1), ("6", "최근 6개월", 6), ("12", "최근 1년", 12))

    def __init__(self, app):
        super().__init__(app.root)
        self.app = app
        self.records = []
        self.materials = []
        self.selected = None
        self.period = tk.StringVar(value="6")
        self.category = tk.StringVar(value="전체")
        self.query = tk.StringVar()
        self.working = False
        self._chart_size = (0, 0)
        self.title("원재료 단가 추이")
        self.configure(bg="#f3f0ea")
        self.geometry("1180x760")
        self.minsize(900, 560)
        self.transient(app.root)

        header = tk.Frame(self, bg="#1e3329")
        header.pack(fill="x")
        self.heading = tk.Label(
            header, text="원재료 단가를 불러오는 중...", bg="#1e3329", fg="#f7f4ee",
            font=("Malgun Gothic", 16, "bold"), anchor="w",
        )
        self.heading.pack(fill="x", padx=18, pady=(14, 12))

        tools = tk.Frame(self, bg="#f3f0ea")
        tools.pack(fill="x", padx=14, pady=(10, 4))
        for key, label, _months in self.periods:
            tk.Radiobutton(
                tools, text=label, value=key, variable=self.period, command=self.apply_period,
                bg="#f3f0ea", fg="#1c1c1c", selectcolor="#f3efe4",
                activebackground="#f3f0ea", font=("Malgun Gothic", 10),
            ).pack(side="left", padx=(0, 8))
        tk.Label(tools, text="구분", bg="#f3f0ea", fg="#5e584f", font=("Malgun Gothic", 10)).pack(side="left", padx=(10, 4))
        self.category_box = ttk.Combobox(
            tools, textvariable=self.category, values=["전체"], state="readonly",
            width=10, font=("Malgun Gothic", 10),
        )
        self.category_box.pack(side="left")
        self.category_box.bind("<<ComboboxSelected>>", self.on_category)
        tk.Button(
            tools, text="다시 불러오기", command=self.load,
            font=("Malgun Gothic", 9), bg="#ffffff", relief="groove",
        ).pack(side="right")

        body = tk.Frame(self, bg="#f3f0ea")
        body.pack(fill="both", expand=True, padx=14, pady=6)
        left = tk.Frame(body, bg="#f3f0ea", width=300)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)
        tk.Label(left, text="원재료", bg="#f3f0ea", fg="#5e584f", font=("Malgun Gothic", 9)).pack(anchor="w")
        self.search = tk.Entry(left, textvariable=self.query, font=("Malgun Gothic", 10))
        self.search.pack(fill="x", pady=(2, 6))
        self.query.trace_add("write", lambda *_args: self.fill_list())
        list_wrap = tk.Frame(left, bg="#f3f0ea")
        list_wrap.pack(fill="both", expand=True)
        self.materials_view = ttk.Treeview(
            list_wrap, columns=("name", "average"), show="headings", height=18,
        )
        self.materials_view.heading("name", text="품목")
        self.materials_view.heading("average", text="평균 단가")
        self.materials_view.column("name", width=170, anchor="w")
        self.materials_view.column("average", width=100, anchor="e")
        list_scroll = ttk.Scrollbar(list_wrap, orient="vertical", command=self.materials_view.yview)
        self.materials_view.configure(yscrollcommand=list_scroll.set)
        self.materials_view.pack(side="left", fill="both", expand=True)
        list_scroll.pack(side="right", fill="y")
        self.materials_view.bind("<<TreeviewSelect>>", self.on_select)

        right = tk.Frame(body, bg="#f3f0ea")
        right.pack(side="left", fill="both", expand=True, padx=(12, 0))
        self.summary = tk.Label(
            right, text="품목을 고르면 기간 평균 단가와 추이가 나옵니다.",
            bg="#f3f0ea", fg="#1c1c1c", font=("Malgun Gothic", 11, "bold"), anchor="w",
        )
        self.summary.pack(fill="x")
        self.canvas = tk.Canvas(right, bg="#fffdf9", height=280, highlightthickness=1, highlightbackground="#e7e2d8")
        self.canvas.pack(fill="x", pady=(6, 8))
        self.canvas.bind("<Configure>", self.on_canvas_configure)
        detail = tk.Frame(right, bg="#f3f0ea")
        detail.pack(fill="both", expand=True)
        self.detail = ttk.Treeview(
            detail, columns=("date", "vendor", "unit", "qty", "price"), show="headings",
        )
        for name, label, width, anchor in (
            ("date", "거래일자", 110, "w"),
            ("vendor", "거래처", 180, "w"),
            ("unit", "단위/규격", 160, "w"),
            ("qty", "수량", 70, "e"),
            ("price", "단가", 110, "e"),
        ):
            self.detail.heading(name, text=label)
            self.detail.column(name, width=width, anchor=anchor)
        detail_scroll = ttk.Scrollbar(detail, orient="vertical", command=self.detail.yview)
        self.detail.configure(yscrollcommand=detail_scroll.set)
        self.detail.pack(side="left", fill="both", expand=True)
        detail_scroll.pack(side="right", fill="y")
        tk.Label(
            self, text="평균 단가는 수량으로 가중 평균한 값입니다. 단가는 영수증의 부가세 포함 단가입니다.",
            bg="#f3f0ea", fg="#8a847a", font=("Malgun Gothic", 8), anchor="w",
        ).pack(fill="x", padx=14, pady=(0, 10))
        self.load()

    def load(self):
        if self.working:
            return
        self.working = True
        self.heading.configure(text="원재료 단가를 불러오는 중...")

        def work():
            try:
                rows = sheet_jobs.load_unit_prices()
                error = ""
            except Exception as exc:
                rows = []
                error = mobile_web.public_error(exc)
            self.after(0, lambda: self.show_records(rows, error))

        threading.Thread(target=work, daemon=True).start()

    def show_records(self, records, error=""):
        self.working = False
        self.records = records
        if error:
            self.heading.configure(text="불러오지 못했습니다")
            messagebox.showerror("원재료 단가 추이", error, parent=self)
            return
        self.apply_period()

    def period_start(self):
        months = {key: count for key, _label, count in self.periods}[self.period.get()]
        today = sheet_jobs.datetime.now(sheet_jobs.KST).date()
        return sheet_jobs.shift_months(today, months).isoformat()

    def apply_period(self):
        start = self.period_start()
        end = sheet_jobs.datetime.now(sheet_jobs.KST).date().isoformat()
        self.materials = sheet_jobs.material_price_summary(self.records, start, end)
        self.refresh_categories()
        self.update_heading()
        self.fill_list()

    def category_options(self):
        present = {item.get("category", "") for item in self.materials}
        ordered = [name for name in sheet_jobs.CATEGORY_PREFIX if name in present]
        extras = sorted(name for name in present if name and name not in sheet_jobs.CATEGORY_PREFIX)
        options = ["전체", *ordered, *extras]
        if "" in present:
            options.append("미분류")
        return options

    def refresh_categories(self):
        options = self.category_options()
        self.category_box["values"] = options
        if self.category.get() not in options:
            self.category.set("전체")

    def on_category(self, _event=None):
        self.update_heading()
        self.fill_list()

    def shown_materials(self):
        category = self.category.get()
        if category == "미분류":
            return [item for item in self.materials if not item.get("category")]
        if category and category != "전체":
            return [item for item in self.materials if item.get("category") == category]
        return list(self.materials)

    def update_heading(self):
        label = {key: text for key, text, _count in self.periods}[self.period.get()]
        category = self.category.get()
        prefix = f"{label} · {category}" if category and category != "전체" else label
        self.heading.configure(text=f"{prefix} · 원재료 {len(self.shown_materials())}개")

    def fill_list(self):
        selected = self.selected["key"] if self.selected else None
        keyword = self.query.get().strip()
        self.materials_view.delete(*self.materials_view.get_children())
        self.list_keys = {}
        visible = []
        for index, item in enumerate(self.shown_materials()):
            if keyword and keyword not in item["name"] and keyword not in item["code"]:
                continue
            iid = str(index)
            visible.append((iid, item))
            self.list_keys[iid] = item
            self.materials_view.insert("", "end", iid=iid, values=(
                item["name"], self.money(item["average"]),
            ))
        chosen = next((iid for iid, item in visible if item["key"] == selected), None)
        if chosen:
            self.materials_view.selection_set(chosen)
            self.materials_view.see(chosen)
            self.show_material(self.list_keys[chosen])
            return
        if visible:
            self.materials_view.selection_set(visible[0][0])
            self.show_material(visible[0][1])
            return
        self.selected = None
        self.summary.configure(text="이 조건에 표시할 단가가 없습니다.")
        self.detail.delete(*self.detail.get_children())
        self.draw_chart()

    def on_select(self, _event=None):
        chosen = self.materials_view.selection()
        if not chosen:
            return
        item = getattr(self, "list_keys", {}).get(chosen[0])
        if item:
            self.show_material(item)

    def show_material(self, item):
        self.selected = item
        note = " 단위가 섞여 있습니다." if item["mixed_units"] else ""
        category = f"{item['category']}  ·  " if item.get("category") else ""
        self.summary.configure(
            text=(
                f"{category}{item['name']}  ·  평균 단가 {self.money(item['average'])}원"
                f"  ·  최저 {self.money(item['low'])}  ·  최고 {self.money(item['high'])}"
                f"  ·  {item['count']}건{note}"
            )
        )
        self.detail.delete(*self.detail.get_children())
        for point in item["points"]:
            self.detail.insert("", "end", values=(
                point["date"],
                point["vendor"],
                point["unit"],
                self.money(point["qty"]),
                self.money(point["price"]),
            ))
        self.draw_chart()

    def on_canvas_configure(self, event):
        size = (event.width, event.height)
        if size == self._chart_size:
            return
        self._chart_size = size
        self.draw_chart()

    def draw_chart(self):
        canvas = self.canvas
        canvas.delete("all")
        width = max(canvas.winfo_width(), 480)
        height = max(canvas.winfo_height(), 240)
        points = self.selected["points"] if self.selected else []
        if not points:
            canvas.create_text(
                width / 2, height / 2, text="품목을 고르면 단가 추이가 나옵니다.",
                fill="#8a847a", font=("Malgun Gothic", 11),
            )
            return
        pad_l, pad_r, pad_t, pad_b = 78, 24, 28, 36
        prices = [sheet_jobs.as_number(point["price"]) for point in points]
        low = min(prices)
        high = max(prices)
        if low == high:
            padding = low * 0.08 if low else 1
            low -= padding
            high += padding
        else:
            span = high - low
            low -= span * 0.08
            high += span * 0.08
        count = len(points)

        def x_of(index):
            if count == 1:
                return (pad_l + width - pad_r) / 2
            return pad_l + (width - pad_l - pad_r) * index / (count - 1)

        def y_of(price):
            return pad_t + (height - pad_t - pad_b) * (high - price) / (high - low)

        for step in range(5):
            value = low + (high - low) * step / 4
            y = y_of(value)
            canvas.create_line(pad_l, y, width - pad_r, y, fill="#e7e2d8")
            canvas.create_text(pad_l - 8, y, text=self.money(value), anchor="e", fill="#6d675e", font=("Malgun Gothic", 8))
        coords = []
        for index, point in enumerate(points):
            coords.extend([x_of(index), y_of(sheet_jobs.as_number(point["price"]))])
        if len(coords) >= 4:
            canvas.create_line(*coords, fill="#1e3329", width=2, smooth=False)
        average = self.selected["average"]
        if average is not None:
            y = y_of(sheet_jobs.as_number(average))
            canvas.create_line(pad_l, y, width - pad_r, y, fill="#8a3324", dash=(5, 3))
            canvas.create_text(
                width - pad_r, max(y - 12, 12), text=f"평균 {self.money(average)}",
                anchor="e", fill="#8a3324", font=("Malgun Gothic", 9),
            )
        for index, point in enumerate(points):
            x = x_of(index)
            y = y_of(sheet_jobs.as_number(point["price"]))
            canvas.create_oval(x - 4, y - 4, x + 4, y + 4, fill="#1e3329", outline="#fffdf9")
        labels = range(count) if count <= 8 else (0, count // 2, count - 1)
        for index in labels:
            canvas.create_text(
                x_of(index), height - 14, text=points[index]["date"][5:],
                fill="#6d675e", font=("Malgun Gothic", 8),
            )

    def money(self, value):
        if value is None or value == "":
            return ""
        number = sheet_jobs.as_number(value)
        if abs(number - round(number)) < 1e-9:
            return f"{int(round(number)):,}"
        return f"{number:,.1f}"


class InspectionWindow(tk.Toplevel):
    columns = ("check", "date", "vendor", "name", "spec", "qty", "code", "final")
    headings = {
        "check": "검수",
        "date": "거래일자",
        "vendor": "거래처",
        "name": "품목",
        "spec": "단위/규격",
        "qty": "수량",
        "code": "코드",
        "final": "반영수량",
    }
    widths = {
        "check": 50,
        "date": 100,
        "vendor": 140,
        "name": 220,
        "spec": 150,
        "qty": 60,
        "code": 80,
        "final": 80,
    }

    def __init__(self, app):
        super().__init__(app.root)
        self.app = app
        self.rows = []
        self.by_row = {}
        self.open_month = ""
        self.pending_only = True
        self.saving = False
        self.title("실물 검수")
        self.configure(bg="#f3f0ea")
        self.geometry("1080x680")
        self.minsize(860, 480)
        self.transient(app.root)
        self.protocol("WM_DELETE_WINDOW", self.close)

        header = tk.Frame(self, bg="#1e3329")
        header.pack(fill="x")
        self.heading = tk.Label(
            header, text="입고 목록을 불러오는 중...", bg="#1e3329", fg="#f7f4ee",
            font=("Malgun Gothic", 16, "bold"), anchor="w",
        )
        self.heading.pack(fill="x", padx=18, pady=(14, 12))

        tools = tk.Frame(self, bg="#f3f0ea")
        tools.pack(fill="x", padx=14, pady=(10, 4))
        self.filter_button = tk.Button(
            tools, text="전체 보기", command=self.toggle_filter,
            font=("Malgun Gothic", 9), bg="#ffffff", relief="groove",
        )
        self.filter_button.pack(side="left")
        tk.Button(
            tools, text="보이는 항목 체크", command=lambda: self.set_visible(True),
            font=("Malgun Gothic", 9), bg="#ffffff", relief="groove",
        ).pack(side="left", padx=(8, 0))
        tk.Button(
            tools, text="보이는 항목 해제", command=lambda: self.set_visible(False),
            font=("Malgun Gothic", 9), bg="#ffffff", relief="groove",
        ).pack(side="left", padx=(8, 0))
        tk.Label(tools, text="찾기", bg="#f3f0ea", fg="#5e584f", font=("Malgun Gothic", 9)).pack(side="left", padx=(16, 4))
        self.query = tk.StringVar()
        self.query.trace_add("write", lambda *_args: self.fill())
        tk.Entry(tools, textvariable=self.query, font=("Malgun Gothic", 10), width=24).pack(side="left")

        style = ttk.Style(self)
        style.configure("Inspect.Treeview", font=("Malgun Gothic", 10), rowheight=26)
        style.configure("Inspect.Treeview.Heading", font=("Malgun Gothic", 10, "bold"))
        table = tk.Frame(self, bg="#f3f0ea")
        table.pack(fill="both", expand=True, padx=14, pady=6)
        self.tree = ttk.Treeview(table, columns=self.columns, show="headings", style="Inspect.Treeview")
        for name in self.columns:
            anchor = "center" if name in ("check", "qty", "code", "final") else "w"
            self.tree.heading(name, text=self.headings[name])
            self.tree.column(name, width=self.widths[name], anchor=anchor, stretch=(name == "name"))
        scroll = ttk.Scrollbar(table, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.tree.tag_configure("wait", background="#ffffff")
        self.tree.tag_configure("done", background="#e8e8e8")
        self.tree.tag_configure("nocode", background="#fff4d6")
        self.tree.bind("<Button-1>", self.on_click)
        self.tree.bind("<space>", self.on_space)
        self.tree.bind("<MouseWheel>", self.on_wheel)

        footer = tk.Frame(self, bg="#f3f0ea")
        footer.pack(fill="x", padx=14, pady=(0, 12))
        self.status = tk.Label(footer, text="", bg="#f3f0ea", fg="#5e584f", font=("Malgun Gothic", 9), anchor="w")
        self.status.pack(fill="x", pady=(0, 6))
        tk.Label(
            footer, text="노란 행은 원재료 코드가 없어 재고 계산에 포함되지 않습니다.",
            bg="#f3f0ea", fg="#8a847a", font=("Malgun Gothic", 8), anchor="w",
        ).pack(fill="x", pady=(0, 6))
        actions = tk.Frame(footer, bg="#f3f0ea")
        actions.pack(fill="x")
        self.save_button = tk.Button(
            actions, text="시트에 반영", command=self.save,
            font=("Malgun Gothic", 11, "bold"), bg="#1e3329", fg="#f7f4ee",
            activebackground="#2c4a3b", activeforeground="#f7f4ee", relief="flat", padx=16, pady=6,
        )
        self.save_button.pack(side="right")
        tk.Button(
            actions, text="닫기", command=self.close,
            font=("Malgun Gothic", 10), bg="#ffffff", relief="groove", padx=14, pady=6,
        ).pack(side="right", padx=(0, 8))
        self.load()

    def load(self):
        self.save_button.configure(state="disabled")

        def work():
            try:
                month, rows = sheet_jobs.load_inspection()
                self.after(0, lambda: self.show_rows(month, rows))
            except Exception as exc:
                detail = str(exc).strip()
                self.after(0, lambda: self.fail(detail))

        threading.Thread(target=work, daemon=True).start()

    def fail(self, detail):
        messagebox.showerror("실물 검수", f"입고 목록을 읽지 못했습니다.\n{detail[:400]}", parent=self)
        self.destroy()

    def show_rows(self, month, rows):
        for item in rows:
            item["original"] = item["checked"]
        self.open_month = month
        self.rows = rows
        self.by_row = {item["row"]: item for item in rows}
        waiting = sum(1 for item in rows if not item["checked"])
        if waiting == 0:
            self.pending_only = False
            self.filter_button.configure(text="대기만 보기")
        self.heading.configure(text=f"{month} 실물 검수  ·  검수대기 {waiting}건")
        self.save_button.configure(state="normal")
        self.fill()

    def toggle_filter(self):
        self.pending_only = not self.pending_only
        self.filter_button.configure(text="전체 보기" if self.pending_only else "대기만 보기")
        self.fill()

    def matches(self, item):
        if self.pending_only and item["checked"]:
            return False
        query = self.query.get().strip()
        if not query:
            return True
        blob = " ".join((item["date"], item["vendor"], item["name"], item["code"], item["spec"]))
        return query in blob

    def values_of(self, item):
        return (
            "✓" if item["checked"] else "",
            item["date"],
            item["vendor"],
            item["name"],
            item["spec"],
            item["qty"],
            item["code"],
            item["final"],
        )

    def tag_of(self, item):
        if not item["code"]:
            return "nocode"
        return "done" if item["checked"] else "wait"

    def fill(self):
        if not self.rows and not self.open_month:
            return
        children = self.tree.get_children()
        if children:
            self.tree.delete(*children)
        for item in self.rows:
            if not self.matches(item):
                continue
            self.tree.insert("", "end", iid=str(item["row"]), values=self.values_of(item), tags=(self.tag_of(item),))
        self.refresh_status()

    def refresh_status(self):
        waiting = sum(1 for item in self.rows if not item["checked"])
        done = len(self.rows) - waiting
        changed = sum(1 for item in self.rows if item["checked"] != item["original"])
        visible = len(self.tree.get_children())
        self.status.configure(text=f"화면 {visible}건  ·  검수대기 {waiting}건  ·  반영완료 {done}건  ·  저장 안 한 변경 {changed}건")

    def paint(self, item):
        iid = str(item["row"])
        if not self.tree.exists(iid):
            return
        self.tree.item(iid, values=self.values_of(item), tags=(self.tag_of(item),))

    def toggle_row(self, row_number):
        item = self.by_row.get(int(row_number))
        if item is None:
            return
        item["checked"] = not item["checked"]
        self.paint(item)
        self.refresh_status()

    def on_click(self, event):
        if self.tree.identify_region(event.x, event.y) != "cell":
            return
        row_id = self.tree.identify_row(event.y)
        if row_id:
            self.toggle_row(row_id)

    def on_space(self, _event):
        selected = self.tree.selection()
        if selected:
            self.toggle_row(selected[0])
        return "break"

    def on_wheel(self, event):
        self.tree.yview_scroll(int(-event.delta / 120), "units")

    def set_visible(self, checked):
        for row_id in self.tree.get_children():
            item = self.by_row[int(row_id)]
            item["checked"] = checked
            self.paint(item)
        self.refresh_status()

    def changes(self):
        return [
            {"row": item["row"], "checked": item["checked"]}
            for item in self.rows
            if item["checked"] != item["original"]
        ]

    def save(self):
        if self.saving:
            return
        changes = self.changes()
        if not changes:
            messagebox.showinfo("실물 검수", "바뀐 검수 항목이 없습니다.", parent=self)
            return
        done = sum(1 for item in changes if item["checked"])
        waiting = len(changes) - done
        if not messagebox.askyesno(
            "실물 검수",
            f"반영완료 {done}건, 검수대기 {waiting}건으로 시트에 기록할까요?\n재고 수량은 바뀌지 않습니다.",
            parent=self,
        ):
            return
        self.saving = True
        self.save_button.configure(state="disabled")
        self.status.configure(text="시트에 기록하는 중...")

        def work():
            try:
                error, message = sheet_jobs.save_inspection(self.open_month, changes)
            except Exception as exc:
                error, message = True, f"기록 중 오류가 났습니다.\n{str(exc).strip()[:400]}"
            self.after(0, lambda: self.saved(error, message, changes))

        threading.Thread(target=work, daemon=True).start()

    def saved(self, error, message, changes):
        self.saving = False
        self.save_button.configure(state="normal")
        if error:
            self.refresh_status()
            messagebox.showerror("실물 검수", message, parent=self)
            return
        changed_rows = {item["row"] for item in changes}
        for item in self.rows:
            if item["row"] in changed_rows:
                item["original"] = item["checked"]
        self.app.write_log(message)
        self.refresh_status()
        messagebox.showinfo("실물 검수", message, parent=self)

    def close(self):
        if self.saving:
            messagebox.showinfo("실물 검수", "기록 중에는 닫을 수 없습니다.", parent=self)
            return
        if self.changes():
            if not messagebox.askyesno("실물 검수", "저장하지 않은 체크가 있습니다. 닫을까요?", parent=self):
                return
        self.destroy()


class RegisterWindow(tk.Toplevel):
    def __init__(self, app):
        super().__init__(app.root)
        self.app = app
        self.groups = []
        self.catalog = {}
        self.selected = None
        self.saving = False
        self.code_manual = False
        self.suggestion = ""
        self._filling_code = False
        self.title("미등록 품목 등록")
        self.configure(bg="#f3f0ea")
        self.geometry("1040x680")
        self.minsize(880, 520)
        self.transient(app.root)
        self.protocol("WM_DELETE_WINDOW", self.close)

        header = tk.Frame(self, bg="#1e3329")
        header.pack(fill="x")
        self.heading = tk.Label(
            header, text="코드 없는 입고를 불러오는 중...", bg="#1e3329", fg="#f7f4ee",
            font=("Malgun Gothic", 16, "bold"), anchor="w",
        )
        self.heading.pack(fill="x", padx=18, pady=(14, 4))
        tk.Label(
            header,
            text="새 코드로 등록하거나, 이미 있는 품목에 연결하면 같은 재고로 합쳐집니다.",
            bg="#1e3329", fg="#d5ddd6", font=("Malgun Gothic", 9), anchor="w",
        ).pack(fill="x", padx=18, pady=(0, 12))

        body = tk.Frame(self, bg="#f3f0ea")
        body.pack(fill="both", expand=True, padx=14, pady=10)
        left = tk.Frame(body, bg="#f3f0ea")
        left.pack(side="left", fill="both", expand=True)
        style = ttk.Style(self)
        style.configure("Register.Treeview", font=("Malgun Gothic", 10), rowheight=26)
        style.configure("Register.Treeview.Heading", font=("Malgun Gothic", 10, "bold"))
        self.tree = ttk.Treeview(
            left, columns=("count", "name", "unit"), show="headings", style="Register.Treeview",
        )
        self.tree.heading("count", text="건수")
        self.tree.heading("name", text="영수증 품목명")
        self.tree.heading("unit", text="단위/규격")
        self.tree.column("count", width=50, anchor="center", stretch=False)
        self.tree.column("name", width=280, anchor="w")
        self.tree.column("unit", width=140, anchor="w")
        scroll = ttk.Scrollbar(left, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.tree.bind("<<TreeviewSelect>>", self.on_select)

        form = tk.Frame(body, bg="#fffdf9", highlightbackground="#ddd6cb", highlightthickness=1)
        form.pack(side="right", fill="y", padx=(12, 0))
        inner = tk.Frame(form, bg="#fffdf9")
        inner.pack(fill="both", expand=True, padx=14, pady=12)
        self.receipt_label = tk.Label(inner, text="품목을 선택하세요", bg="#fffdf9", fg="#1c1c1c", font=("Malgun Gothic", 12, "bold"), wraplength=320, justify="left", anchor="w")
        self.receipt_label.pack(fill="x")
        self.count_label = tk.Label(inner, text="", bg="#fffdf9", fg="#5e584f", font=("Malgun Gothic", 9), anchor="w")
        self.count_label.pack(fill="x", pady=(2, 8))

        self.mode = tk.StringVar(value="new")
        modes = tk.Frame(inner, bg="#fffdf9")
        modes.pack(fill="x", pady=(0, 8))
        tk.Radiobutton(modes, text="새 품목", value="new", variable=self.mode, command=self.apply_mode, bg="#fffdf9", font=("Malgun Gothic", 10)).pack(side="left")
        tk.Radiobutton(modes, text="기존 품목에 연결", value="link", variable=self.mode, command=self.apply_mode, bg="#fffdf9", font=("Malgun Gothic", 10)).pack(side="left", padx=(12, 0))

        self.new_box = tk.Frame(inner, bg="#fffdf9")
        self.new_box.pack(fill="x")
        self.name_var = tk.StringVar()
        self.category_var = tk.StringVar(value="기타")
        self.code_var = tk.StringVar()
        self.spec_var = tk.StringVar()
        self.conversion_var = tk.StringVar(value="1")
        self.unit_var = tk.StringVar(value="개")
        self.code_var.trace_add("write", self.on_code_edit)
        self._add_field(self.new_box, "원재료명", self.name_var)
        self._add_combo(self.new_box, "구분", self.category_var, list(sheet_jobs.CATEGORY_PREFIX))
        self._add_field(self.new_box, "원재료코드", self.code_var)
        self._add_field(self.new_box, "입고단위/규격", self.spec_var)
        self._add_field(self.new_box, "재고수환산", self.conversion_var)
        self._add_combo(self.new_box, "재고단위", self.unit_var, ["개", "kg"])

        self.link_box = tk.Frame(inner, bg="#fffdf9")
        tk.Label(self.link_box, text="찾을 품목", bg="#fffdf9", fg="#5e584f", font=("Malgun Gothic", 9), anchor="w").pack(fill="x")
        self.link_query = tk.StringVar()
        self.link_query.trace_add("write", lambda *_args: self.refresh_links())
        tk.Entry(self.link_box, textvariable=self.link_query, font=("Malgun Gothic", 10)).pack(fill="x", pady=(2, 6))
        self.link_list = tk.Listbox(self.link_box, font=("Malgun Gothic", 10), height=12, activestyle="none")
        self.link_list.pack(fill="both", expand=True)
        self.link_list.bind("<<ListboxSelect>>", self.on_link_select)
        self.link_codes = []

        footer = tk.Frame(self, bg="#f3f0ea")
        footer.pack(fill="x", padx=14, pady=(0, 12))
        self.status = tk.Label(footer, text="", bg="#f3f0ea", fg="#5e584f", font=("Malgun Gothic", 9), anchor="w")
        self.status.pack(fill="x", pady=(0, 6))
        actions = tk.Frame(footer, bg="#f3f0ea")
        actions.pack(fill="x")
        self.save_button = tk.Button(
            actions, text="확인 후 저장", command=self.save,
            font=("Malgun Gothic", 11, "bold"), bg="#1e3329", fg="#f7f4ee",
            activebackground="#2c4a3b", activeforeground="#f7f4ee", relief="flat", padx=16, pady=6,
        )
        self.save_button.pack(side="right")
        tk.Button(
            actions, text="닫기", command=self.close,
            font=("Malgun Gothic", 10), bg="#ffffff", relief="groove", padx=14, pady=6,
        ).pack(side="right", padx=(0, 8))
        self.apply_mode()
        self.load()

    def _add_field(self, parent, label, variable):
        tk.Label(parent, text=label, bg="#fffdf9", fg="#5e584f", font=("Malgun Gothic", 9), anchor="w").pack(fill="x", pady=(6, 0))
        tk.Entry(parent, textvariable=variable, font=("Malgun Gothic", 10)).pack(fill="x")

    def _add_combo(self, parent, label, variable, values):
        tk.Label(parent, text=label, bg="#fffdf9", fg="#5e584f", font=("Malgun Gothic", 9), anchor="w").pack(fill="x", pady=(6, 0))
        combo = ttk.Combobox(parent, textvariable=variable, values=values, font=("Malgun Gothic", 10))
        combo.pack(fill="x")
        if label == "구분":
            combo.bind("<<ComboboxSelected>>", lambda _event: self.refresh_code())
            combo.bind("<KeyRelease>", lambda _event: self.refresh_code())

    def load(self):
        self.save_button.configure(state="disabled")

        def work():
            try:
                groups, master = sheet_jobs.load_unregistered()
                self.after(0, lambda: self.show(groups, master))
            except Exception as exc:
                detail = str(exc).strip()
                self.after(0, lambda: self.fail(detail))

        threading.Thread(target=work, daemon=True).start()

    def fail(self, detail):
        messagebox.showerror("미등록 품목", f"목록을 읽지 못했습니다.\n{detail[:400]}", parent=self)
        self.destroy()

    def show(self, groups, master):
        self.groups = groups
        self.catalog = master
        self.heading.configure(text=f"코드 없는 입고 {len(groups)}종")
        self.save_button.configure(state="normal")
        self.fill_tree()
        self.refresh_links()
        children = self.tree.get_children()
        if children:
            self.tree.selection_set(children[0])
            self.tree.focus(children[0])
        else:
            self.status.configure(text="등록할 품목이 없습니다.")

    def fill_tree(self):
        children = self.tree.get_children()
        if children:
            self.tree.delete(*children)
        for index, group in enumerate(self.groups):
            unit = group["units"][0] if group["units"] else ""
            if len(group["units"]) > 1:
                unit = f"{unit} 외 {len(group['units']) - 1}"
            self.tree.insert("", "end", iid=str(index), values=(len(group["rows"]), group["name"], unit))

    def refresh_links(self):
        query = self.link_query.get().strip().casefold()
        self.link_list.delete(0, "end")
        self.link_codes = []
        for code, info in sorted(self.catalog.items()):
            label = f"{code}  {info.get('name') or ''}"
            if info.get("aliases"):
                label += "  /  " + ", ".join(info["aliases"][:2])
            if query and query not in label.casefold():
                continue
            self.link_codes.append(code)
            self.link_list.insert("end", label)

    def apply_mode(self):
        if self.mode.get() == "link":
            self.new_box.pack_forget()
            self.link_box.pack(fill="both", expand=True, pady=(4, 0))
        else:
            self.link_box.pack_forget()
            self.new_box.pack(fill="x")

    def on_select(self, _event):
        selected = self.tree.selection()
        if not selected:
            return
        group = self.groups[int(selected[0])]
        self.selected = group
        self.receipt_label.configure(text=group["name"])
        self.count_label.configure(text=f"입고 {len(group['rows'])}건에 코드를 넣습니다.")
        self.name_var.set(group["name"])
        units = " / ".join(group["units"])
        self.spec_var.set(units)
        self.conversion_var.set("1")
        self.unit_var.set("kg" if "kg" in units.lower() else "개")
        self.code_manual = False
        if self.category_var.get() not in sheet_jobs.CATEGORY_PREFIX:
            self.category_var.set("기타")
        self.refresh_code()

    def refresh_code(self):
        if self.code_manual or self.mode.get() != "new":
            return
        self.suggestion = sheet_jobs.suggest_material_code(self.catalog, self.category_var.get())
        self._filling_code = True
        self.code_var.set(self.suggestion)
        self._filling_code = False

    def on_code_edit(self, *_args):
        if self._filling_code:
            return
        if self.code_var.get().strip() != self.suggestion:
            self.code_manual = True

    def on_link_select(self, _event):
        picked = self.link_list.curselection()
        if not picked:
            return
        code = self.link_codes[picked[0]]
        info = self.catalog.get(code, {})
        self.status.configure(text=f"{code} {info.get('name', '')}에 이 영수증 이름을 별칭으로 붙입니다.")

    def chosen_link(self):
        picked = self.link_list.curselection()
        if not picked:
            return ""
        return self.link_codes[picked[0]]

    def save(self):
        if self.saving or self.selected is None:
            if self.selected is None:
                messagebox.showinfo("미등록 품목", "등록할 품목을 선택해 주세요.", parent=self)
            return
        mode = self.mode.get()
        if mode == "link":
            code = self.chosen_link()
            if not code:
                messagebox.showinfo("미등록 품목", "연결할 기존 품목을 선택해 주세요.", parent=self)
                return
            info = self.catalog.get(code, {})
            official = info.get("name") or code
            question = f"{self.selected['name']}\n을 {code} {official}에 연결할까요?"
        else:
            code = self.code_var.get().strip()
            official = self.name_var.get().strip()
            if not official:
                messagebox.showinfo("미등록 품목", "원재료명을 입력해 주세요.", parent=self)
                return
            if not code:
                messagebox.showinfo("미등록 품목", "원재료코드를 확인해 주세요.", parent=self)
                return
            question = f"{code} {official}\n으로 등록하고, 입고 {len(self.selected['rows'])}건에 넣을까요?"
        if not messagebox.askyesno("미등록 품목", question, parent=self):
            return
        group = self.selected
        payload = {
            "mode": mode,
            "receipt_name": group["name"],
            "row_numbers": list(group["rows"]),
            "code": code,
            "name": self.name_var.get().strip(),
            "category": self.category_var.get().strip(),
            "spec": self.spec_var.get().strip(),
            "conversion": self.conversion_var.get().strip(),
            "stock_unit": self.unit_var.get().strip(),
        }
        self.saving = True
        self.save_button.configure(state="disabled")
        self.status.configure(text="저장하는 중...")

        def work():
            try:
                error, message = sheet_jobs.register_unregistered(**payload)
            except Exception as exc:
                error, message = True, f"저장 중 오류가 났습니다.\n{str(exc).strip()[:400]}"
            self.after(0, lambda: self.saved(error, message, group["key"]))

        threading.Thread(target=work, daemon=True).start()

    def saved(self, error, message, key):
        self.saving = False
        self.save_button.configure(state="normal")
        if error:
            self.status.configure(text="")
            messagebox.showerror("미등록 품목", message, parent=self)
            return
        self.groups = [group for group in self.groups if group["key"] != key]
        self.selected = None
        self.app.write_log(message)
        messagebox.showinfo("미등록 품목", message, parent=self)
        self.load()

    def close(self):
        if self.saving:
            messagebox.showinfo("미등록 품목", "저장 중에는 닫을 수 없습니다.", parent=self)
            return
        self.destroy()


def build_app():
    root = tk.Tk()
    App(root)
    return root


if __name__ == "__main__":
    build_app().mainloop()
