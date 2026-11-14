import io
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from okpos_crawler import JSON_FILE, SHEET_URL

KST = timezone(timedelta(hours=9))
SHEET_ID = SHEET_URL.split("/d/")[1].split("/")[0]
UPLOAD_FOLDER_ID = "1ztTltg0EWyulTaiBi5KAr9F2nnUvkaUW"
DONE_FOLDER_ID = "1DffmS6pSKNcioZd6f-5kjE_Ho1a04OxA"


def _read_local_config():
    roots = [Path.cwd(), Path(__file__).resolve().parent, Path(__file__).resolve().parent / "agent"]
    for root in roots:
        path = root / "config.json"
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8-sig"))
            except Exception:
                return {}
        path = root / "agent" / "config.json"
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8-sig"))
            except Exception:
                return {}
    return {}


def gemini_api_key():
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if key:
        return key
    return str(_read_local_config().get("gemini_api_key") or "").strip()


# 하위 호환: 예전 코드가 GEMINI_API_KEY 상수를 참조할 수 있음
GEMINI_API_KEY = gemini_api_key()
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def now_text():
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")


def month_text(when=None):
    when = when or datetime.now(KST)
    return when.strftime("%Y-%m")


def next_month_text(month_value):
    when = parse_month(month_value)
    year = when.year + (1 if when.month == 12 else 0)
    month = 1 if when.month == 12 else when.month + 1
    return f"{year:04d}-{month:02d}"


def parse_month(value):
    if isinstance(value, datetime):
        return value
    text = str(value or "").strip()
    match = re.match(r"(\d{4})-(\d{2})", text)
    if match:
        return datetime(int(match.group(1)), int(match.group(2)), 1)
    return datetime.now(KST)


def as_number(value):
    if value is None or value == "":
        return 0
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return 0


def connect():
    creds = Credentials.from_service_account_file(JSON_FILE, scopes=SCOPES)
    sheets = gspread.authorize(creds)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    spreadsheet = sheets.open_by_key(SHEET_ID)
    return spreadsheet, drive


def service_email():
    try:
        with open(JSON_FILE, encoding="utf-8-sig") as f:
            return json.load(f).get("client_email", "")
    except Exception:
        return ""


def sheet_or_raise(spreadsheet, name):
    try:
        return spreadsheet.worksheet(name)
    except gspread.WorksheetNotFound as exc:
        raise RuntimeError(f"'{name}' 시트를 찾을 수 없습니다.") from exc


def list_folder_files(drive, folder_id):
    files = []
    token = None
    while True:
        response = drive.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name, mimeType)",
            pageSize=100,
            pageToken=token,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        files.extend(response.get("files", []))
        token = response.get("nextPageToken")
        if not token:
            return files


def download_file(drive, file_id):
    request = drive.files().get_media(fileId=file_id, supportsAllDrives=True)
    buffer = io.BytesIO()
    loader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = loader.next_chunk()
    return buffer.getvalue()


def move_file(drive, file_id, new_name):
    info = drive.files().get(fileId=file_id, fields="parents", supportsAllDrives=True).execute()
    parents = ",".join(info.get("parents", []))
    drive.files().update(
        fileId=file_id,
        body={"name": new_name},
        addParents=DONE_FOLDER_ID,
        removeParents=parents,
        supportsAllDrives=True,
        fields="id, name",
    ).execute()


def safe_filename(value, fallback):
    text = str(value or fallback)
    return re.sub(r'[\\/:*?"<>|]', "-", text).strip() or fallback


def parse_ai_json(raw_text):
    clean = raw_text.replace("```json", "").replace("```", "").strip()
    data = json.loads(clean)
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list):
                return value
        return [data]
    if not isinstance(data, list):
        raise ValueError("JSON 배열이 아닙니다.")
    return data


def ask_gemini(image_bytes, mime_type, db_text):
    import base64
    import urllib.error
    import urllib.request

    prompt = f"""
너는 식당 ERP 재고관리 AI야. 첨부된 거래명세서를 분석해서 JSON 배열로 반환해.
반드시 마크다운이나 추가 설명 없이 순수 JSON 형태만 출력해야 해.

[우리 식당 원재료 DB]
{db_text}

[분석 및 매핑 규칙]
1. 영수증에 적힌 모든 품목을 추출해.
2. 영수증 품목명과 가장 유사한 것을 [우리 식당 원재료 DB]에서 찾아 'mappedCode'와 'mappedName'에 넣어. 별칭이 같으면 그 코드를 쓰고, 확실치 않으면 null
3. 고기류처럼 명세서에 단위가 Box이고 실제 중량(kg)이 적혀있다면, 'finalQty'는 반드시 실제 중량(kg) 숫자로 산출해.
4. 일반 공산품은 영수증의 기본 수량을 'finalQty'로 해.
5. 단가(unitPrice)와 품목금액(totalPrice)은 부가세가 포함된 금액으로 넣어.
   - 품목 금액에 이미 부가세가 들어 있으면 적힌 금액을 그대로 써.
   - 공급가액과 세액이 따로 있고 품목 금액이 공급가액이면, 그 줄 공급가액에 세액 몫을 더한 값을 totalPrice로 넣어. unitPrice는 그 totalPrice를 수량으로 나눈 값.
   - supplyAmount는 명세서 공급가액 합계, 없으면 null.
   - taxAmount는 따로 적힌 세액. 품목 금액에 부가세가 이미 포함되어 있으면 null.
   - pricesIncludeTax는 품목 금액이 부가세 포함이면 true, 공급가액이면 false.
6. 이 영수증 한 장의 합계와 당월 누적 금액을 모든 품목에 같은 숫자로 넣어. 콤마는 빼. 같은 날 다른 영수증 금액은 더하지 마.
   - dailyAmount: 이번 납품의 품목 합계. 합계, 금일판매, 금일합계, 공급가액+세액. 세액이 따로 있으면 공급가액만 넣지 마.
   - monthTotal: 당월누적, 당월누계, 월누계, 이달합계. 공급대가총액이 이전 잔액과 이번 품목 합계를 더한 값이면 그 공급대가총액. 품목 아래의 이전 잔액, 전잔, 이월액은 넣지 마. 그 칸이 없고 미수잔액이 있으면 미수잔액. 미수잔액에 세액을 다시 더하지 마.
   - 공급대가총액이 이번 품목 합계와 같으면 monthTotal이 아니라 dailyAmount다.
   - paymentAmount: 금일수금, 입금, 결제액. 적혀 있으면 그 숫자. 당월누적에서 다시 빼지 마. 없으면 null.
   금액을 못 찾으면 null.
6-0. [(주)동의보감농수산 · 사업자 211-86-29450] 품목 totalPrice = 금액(또는 단가×수량) + 줄세액. taxAmount에 줄세액.
   미수금에 '숫자(전)'과 '숫자(현)'이 있으면 previousCredit=(전), monthTotal=(현). (전)을 monthTotal에 넣지 마.
7. businessNumber: 거래처(공급자, 명세서를 발행한 쪽)의 사업자등록번호. 하이픈을 유지한 문자열로 모든 품목에 같게 넣어.
   공급받는자 번호는 넣지 마. 없으면 null.

[출력 JSON 포맷 예시]
[
  {{
    "receiptDate": "2026-08-03",
    "vendor": "(주)회승",
    "originalName": "(돈)이베리코미니목살",
    "unit": "1 Box / 11.96kg",
    "originalQty": 1,
    "unitPrice": 233220,
    "totalPrice": 233220,
    "mappedCode": "M0015",
    "mappedName": "이베리코 목살",
    "finalQty": 11.96,
    "dailyAmount": 295350,
    "monthTotal": 3576528,
    "paymentAmount": null,
    "supplyAmount": null,
    "taxAmount": null,
    "pricesIncludeTax": true,
    "businessNumber": "475-81-00732"
  }}
]"""
    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": mime_type, "data": base64.b64encode(image_bytes).decode("ascii")}},
            ]
        }]
    }
    key = gemini_api_key()
    if not key:
        raise RuntimeError("GEMINI_API_KEY 환경변수 또는 config.json 의 gemini_api_key 가 필요합니다.")
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" + key
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"명세서 분석 API 오류 ({exc.code}): {detail}") from exc
    parsed = json.loads(body)
    return parsed["candidates"][0]["content"]["parts"][0]["text"]


def add_checkboxes(spreadsheet, worksheet, start_row, end_row):
    spreadsheet.batch_update({"requests": [{
        "repeatCell": {
            "range": {
                "sheetId": worksheet.id,
                "startRowIndex": start_row - 1,
                "endRowIndex": end_row,
                "startColumnIndex": RECEIPT_CHECK,
                "endColumnIndex": RECEIPT_CHECK + 1,
            },
            "cell": {
                "userEnteredValue": {"boolValue": False},
                "dataValidation": {
                    "condition": {"type": "BOOLEAN"},
                    "strict": True,
                    "showCustomUi": True,
                },
            },
            "fields": "userEnteredValue,dataValidation",
        }
    }]})


def blank(value):
    return "" if value is None else value


IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
    ".heif": "image/heif",
}

# 원재료입고. 거래처명 다음에 사업자번호, 영수증합계금액, 당월누적금액이 있다.
RECEIPT_DATE = 2
RECEIPT_VENDOR = 3
RECEIPT_BIZ = 4
RECEIPT_DAILY = 5
RECEIPT_MONTH_TOTAL = 6
RECEIPT_NAME = 7
RECEIPT_UNIT = 8
RECEIPT_QTY = 9
RECEIPT_PRICE = 10
RECEIPT_TOTAL = 11
RECEIPT_CODE = 12
RECEIPT_OFFICIAL = 13
RECEIPT_FINAL = 14
RECEIPT_CHECK = 15
RECEIPT_STATUS = 16
RECEIPT_POSTED = 17
RECEIPT_PAYMENT = 18


def col_letter(index):
    return chr(ord("A") + index)


def receipt_cell(row, index):
    if len(row) <= index or row[index] is None:
        return ""
    return row[index]


def local_receipt_dirs():
    candidates = [
        Path(r"G:\내 드라이브\001.중계_재고관리"),
        Path(r"G:\My Drive\001.중계_재고관리"),
    ]
    for base in candidates:
        upload = base / "입고대기"
        done = base / "처리완료"
        if upload.is_dir() and done.is_dir():
            return upload, done
    return None


def unique_destination(folder, name):
    dest = folder / name
    if not dest.exists():
        return dest
    stem, suffix = dest.stem, dest.suffix
    number = 2
    while True:
        candidate = folder / f"{stem}_{number}{suffix}"
        if not candidate.exists():
            return candidate
        number += 1


def archive_receipt(src, dest, data):
    # 구글 드라이브는 폴더 이동이 끝난 뒤에도 원본이 없다는 오류를 낸다.
    # 이미 읽어 둔 내용을 처리완료에 먼저 저장한 다음 입고대기 원본을 지운다.
    if not data:
        raise OSError(f"파일 내용이 비어 있습니다: {src.name}")
    dest.write_bytes(data)
    written = dest.stat().st_size if dest.is_file() else -1
    if written != len(data):
        raise OSError(f"처리완료에 저장하지 못했습니다: {dest.name}")
    try:
        src.unlink()
    except OSError:
        if src.exists():
            return False
    return True


def open_sheet():
    creds = Credentials.from_service_account_file(
        JSON_FILE,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return gspread.authorize(creds).open_by_key(SHEET_ID)


def normalize_receipt_date(value):
    text = re.sub(r"\s+", "", str(value or "").strip().replace(".", "-").replace("/", "-"))
    match = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", text)
    if match:
        return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
    digits = re.sub(r"\D", "", text)
    if len(digits) == 8:
        return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
    return text


def normalize_vendor(value):
    text = str(value or "")
    text = text.replace("㈜", "(주)").replace("㈔", "(사)").replace("㈲", "(유)")
    return re.sub(r"\s+", "", text).strip()


def delete_rows_numbered(worksheet, row_numbers):
    numbers = sorted(set(row_numbers))
    if not numbers:
        return
    ranges = []
    start = previous = numbers[0]
    for number in numbers[1:]:
        if number == previous + 1:
            previous = number
        else:
            ranges.append((start, previous))
            start = previous = number
    ranges.append((start, previous))
    for start, end in reversed(ranges):
        worksheet.delete_rows(start, end)


def receipt_identity(receipt_date, vendor, amount):
    amount_text = "0" if amount is None else str(amount)
    date_text = normalize_receipt_date(receipt_date) or "날짜미상"
    vendor_text = str(vendor or "").strip() or "거래처미상"
    return f"{date_text}_{vendor_text}_{amount_text}"


def amounts_match(left, right):
    if left is None or right is None:
        return False
    return abs(as_number(left) - as_number(right)) < 1


def delete_same_receipt(staging, receipt_date, vendor, amount):
    date_key = normalize_receipt_date(receipt_date)
    vendor_key = normalize_vendor(vendor)
    identity = receipt_identity(date_key, vendor, amount)
    if not date_key or not vendor_key:
        return 0
    matched = []
    for index, row in enumerate(staging.get_all_values()[1:], start=2):
        unique_id = str(row[1] if len(row) > 1 else "").strip()
        if unique_id == identity:
            matched.append(index)
            continue
        row_date = normalize_receipt_date(row[2] if len(row) > 2 else "")
        row_vendor = normalize_vendor(row[3] if len(row) > 3 else "")
        row_amount = money_or_none(row[RECEIPT_DAILY] if len(row) > RECEIPT_DAILY else "")
        if row_date == date_key and row_vendor == vendor_key and amounts_match(row_amount, amount):
            matched.append(index)
    delete_rows_numbered(staging, matched)
    return len(matched)


def tidy_number(value):
    value = round(float(value), 4)
    if abs(value - round(value)) < 1e-9:
        return int(round(value))
    return value


# 야채 M7001–M7007, 공산품 M7008– 은 한 번호대를 이어서 쓴다.
CATEGORY_PREFIX = {
    "고기": "M1",
    "주류": "M2",
    "하이볼": "M3",
    "식사": "M4",
    "사이드": "M5",
    "음료": "M6",
    "야채": "M7",
    "공산품": "M7",
    "기타": "M8",
}


def split_aliases(value):
    parts = []
    for chunk in re.split(r"[|\n]", str(value or "")):
        text = chunk.strip()
        if text and text not in parts:
            parts.append(text)
    return parts


def normalize_item_name(value):
    return re.sub(r"\s+", "", str(value or "")).strip().casefold()


def material_master(spreadsheet):
    sheet = sheet_or_raise(spreadsheet, "원재료관리")
    values = sheet.get_all_values()
    headers = values[0] if values else []
    status_col = -1
    timing_col = -1
    for i, h in enumerate(headers):
        hs = str(h).strip()
        if hs == "등록구분":
            status_col = i
        if hs == "구매시기":
            timing_col = i
    master = {}
    for index, row in enumerate(values[1:], start=2):
        if len(row) < 2:
            continue
        code = str(row[1]).strip()
        name = str(row[0]).strip()
        if not code:
            continue
        # 등록구분=대표만 키 (레거시 '등록'·빈값+코드 → 대표). 별칭은 아래에서 병합하지 않음(간단 동기화)
        status = ""
        if status_col >= 0 and len(row) > status_col:
            status = str(row[status_col]).strip()
        if status == "등록":
            status = "대표"
        if status in ("별칭", "미등록", "등록제외", "IGNORE", "영구제외"):
            continue
        if status and status != "대표":
            continue
        if not status:
            status = "대표"
        aliases = split_aliases(row[6] if len(row) > 6 else "")
        if code in master:
            continue  # 대표 중복 시 첫 행
        raw_conversion = str(row[3]).strip() if len(row) > 3 else ""
        conversion = as_number(raw_conversion) if raw_conversion else 1
        timing_raw = row[timing_col] if timing_col >= 0 and len(row) > timing_col else ""
        master[code] = {
            "name": name,
            "spec": str(row[2]).strip() if len(row) > 2 else "",
            "conversion": conversion if conversion else 1,
            "stock_unit": str(row[4]).strip() if len(row) > 4 else "",
            "category": str(row[5]).strip() if len(row) > 5 else "",
            "aliases": [alias for alias in aliases if alias != name],
            "purchase_timing": normalize_purchase_timing(timing_raw),
            "sheet_row": index,
        }
    return master


def alias_index(master):
    index = {}
    for code, info in master.items():
        for name in [info.get("name", ""), *info.get("aliases", [])]:
            key = normalize_item_name(name)
            if key and key not in index:
                index[key] = code
    return index


def apply_known_mapping(item, master):
    code = alias_index(master).get(normalize_item_name(item.get("originalName")))
    if not code:
        return
    item["mappedCode"] = code
    item["mappedName"] = master[code].get("name") or code


def mapping_db_text(master, recipe_rows):
    lines = []
    seen = set()
    for code, info in master.items():
        alias = ", ".join(info.get("aliases") or [])
        lines.append(f"- 코드: {code}, 공식품목명: {info.get('name') or code}, 별칭: {alias}")
        seen.add(code)
    for row in recipe_rows:
        if len(row) < 5:
            continue
        code = str(row[4]).strip()
        name = str(row[3]).strip()
        if code and name and code not in seen:
            seen.add(code)
            lines.append(f"- 코드: {code}, 공식품목명: {name}, 별칭: ")
    return "\n".join(lines)


def suggest_material_code(master, category):
    category = str(category or "").strip() or "기타"
    prefix = CATEGORY_PREFIX.get(category)
    if not prefix:
        for code, info in master.items():
            if info.get("category") == category and re.match(r"M\d", code):
                prefix = code[:2]
                break
    if not prefix:
        used_digits = {match.group(1) for code in master if (match := re.match(r"M(\d)", code))}
        prefix = "M7"
        for digit in "789":
            if digit not in used_digits:
                prefix = "M" + digit
                break
    used_numbers = []
    for code in master:
        match = re.match(rf"{re.escape(prefix)}(\d+)$", code)
        if match:
            used_numbers.append(int(match.group(1)))
    number = max(used_numbers, default=0) + 1
    while f"{prefix}{number:03d}" in master:
        number += 1
    return f"{prefix}{number:03d}"


def load_unregistered():
    spreadsheet = open_sheet()
    master = material_master(spreadsheet)
    staging = sheet_or_raise(spreadsheet, "원재료입고")
    groups = {}
    for index, row in enumerate(staging.get_all_values()[1:], start=2):
        if not row or not any(str(cell).strip() for cell in row):
            continue
        if str(receipt_cell(row, RECEIPT_CODE)).strip():
            continue
        name = str(receipt_cell(row, RECEIPT_NAME)).strip()
        if not name:
            continue
        key = normalize_item_name(name)
        group = groups.get(key)
        if group is None:
            group = {"key": key, "name": name, "units": [], "rows": []}
            groups[key] = group
        unit = str(receipt_cell(row, RECEIPT_UNIT)).strip()
        if unit and unit not in group["units"]:
            group["units"].append(unit)
        group["rows"].append(index)
    ordered = sorted(groups.values(), key=lambda item: (-len(item["rows"]), item["name"]))
    return ordered, master


def register_unregistered(mode, receipt_name, row_numbers, code, name, category, spec, conversion, stock_unit):
    spreadsheet = open_sheet()
    catalog = sheet_or_raise(spreadsheet, "원재료관리")
    staging = sheet_or_raise(spreadsheet, "원재료입고")
    ensure_title(catalog, 7, "영수증별칭")
    master = material_master(spreadsheet)
    code = str(code or "").strip()
    receipt_name = str(receipt_name or "").strip()
    if not code:
        return True, "원재료코드를 입력해 주세요."
    if not row_numbers:
        return True, "연결할 입고 행이 없습니다."

    if mode == "link":
        info = master.get(code)
        if info is None:
            return True, f"{code} 원재료가 없습니다."
        official = info["name"] or code
        aliases = list(info["aliases"])
        known = {normalize_item_name(official), *(normalize_item_name(alias) for alias in aliases)}
        if normalize_item_name(receipt_name) not in known:
            aliases.append(receipt_name)
            catalog.update_cell(info["sheet_row"], 7, " | ".join(aliases))
        category = info["category"]
        conversion = info["conversion"]
    else:
        if code in master:
            return True, f"{code} 는 이미 있습니다. 다른 코드를 확인해 주세요."
        official = str(name or "").strip()
        if not official:
            return True, "원재료명을 입력해 주세요."
        category = str(category or "").strip() or "기타"
        spec = str(spec or "").strip()
        stock_unit = str(stock_unit or "").strip() or "개"
        conversion = as_number(conversion) or 1
        catalog.append_row(
            [official, code, spec, conversion, stock_unit, category, receipt_name],
            value_input_option="USER_ENTERED",
        )
        master[code] = {"conversion": conversion, "category": category, "name": official, "aliases": [receipt_name]}

    values = staging.get_all_values()
    cells = []
    linked = 0
    for row_number in row_numbers:
        if row_number < 1 or row_number > len(values):
            continue
        row = values[row_number - 1]
        if str(receipt_cell(row, RECEIPT_CODE)).strip():
            continue
        unit = receipt_cell(row, RECEIPT_UNIT)
        qty = receipt_cell(row, RECEIPT_QTY)
        final_qty = reflected_quantity(master, code, unit, qty)
        if final_qty is None:
            final_qty = as_number(qty)
        cells.extend([
            (f"{col_letter(RECEIPT_CODE)}{row_number}", code),
            (f"{col_letter(RECEIPT_OFFICIAL)}{row_number}", official),
            (f"{col_letter(RECEIPT_FINAL)}{row_number}", final_qty),
        ])
        linked += 1
    if cells:
        batch_cells(staging, cells, raw=False)
    if mode == "link":
        text = f"{receipt_name} 을 {code} {official}에 연결했습니다.\n입고 {linked}건이 이 코드로 합쳐집니다."
    else:
        text = f"{code} {official} 을 원재료관리에 등록했습니다.\n입고 {linked}건에 이 코드를 넣었습니다."
    return False, text + "\n재고 수량은 실시간 재고 계산을 누를 때 합산됩니다."


def weight_from_spec(text):
    matches = re.findall(r"(\d+(?:\.\d+)?)\s*kg", str(text or ""), flags=re.IGNORECASE)
    if not matches:
        return None
    return float(matches[-1])


def reflected_quantity(master, code, unit, receipt_qty):
    info = master.get(str(code or "").strip())
    if not info:
        return None
    if info["category"] == "고기":
        weight = weight_from_spec(unit)
        return tidy_number(weight) if weight is not None else None
    return tidy_number(info["conversion"] * as_number(receipt_qty))


def plan_receipt_quantities(master, values, open_month):
    updates = []
    stats = {
        "changed": 0,
        "meat": 0,
        "converted": 0,
        "same": 0,
        "no_code": 0,
        "unknown_code": 0,
        "meat_no_weight": 0,
    }
    for index, row in enumerate(values[1:], start=2):
        if not row or not any(str(cell).strip() for cell in row):
            continue
        if receipt_month(row) != open_month:
            continue
        code = str(receipt_cell(row, RECEIPT_CODE)).strip()
        if not code:
            stats["no_code"] += 1
            continue
        if code not in master:
            stats["unknown_code"] += 1
            continue
        new_value = reflected_quantity(master, code, receipt_cell(row, RECEIPT_UNIT), receipt_cell(row, RECEIPT_QTY))
        if new_value is None:
            stats["meat_no_weight"] += 1
            continue
        current_text = str(receipt_cell(row, RECEIPT_FINAL)).strip()
        if current_text != "" and abs(as_number(current_text) - new_value) < 1e-6:
            stats["same"] += 1
            continue
        stats["changed"] += 1
        if master[code]["category"] == "고기":
            stats["meat"] += 1
        else:
            stats["converted"] += 1
        updates.append((index, new_value))
    return updates, stats


def update_receipt_quantities(log):
    log("원재료관리 환산값으로 최종반영수량을 맞추는 중...")
    spreadsheet = open_sheet()
    inventory = sheet_or_raise(spreadsheet, "원재료_실시간재고")
    staging = sheet_or_raise(spreadsheet, "원재료입고")
    master = material_master(spreadsheet)
    inv_values = inventory.get_all_values()
    open_month = latest_month(inv_values) if len(inv_values) > 1 else month_text()
    log(f"기준월 {open_month} 입고 행을 확인합니다.")
    updates, stats = plan_receipt_quantities(master, staging.get_all_values(), open_month)
    if updates:
        batch_cells(staging, [(f"{col_letter(RECEIPT_FINAL)}{row}", value) for row, value in updates], raw=False)
        log(f"최종반영수량 {len(updates)}줄을 고쳤습니다.")
    lines = ["완료되었습니다.", f"기준월 {open_month} 입고 {stats['changed']}줄의 최종반영수량을 고쳤습니다."]
    details = []
    if stats["meat"]:
        details.append(f"고기 {stats['meat']}줄은 단위/규격의 무게")
    if stats["converted"]:
        details.append(f"{stats['converted']}줄은 재고수환산 × 영수증 수량")
    if details:
        lines.append(", ".join(details) + "입니다.")
    skipped = stats["no_code"] + stats["unknown_code"]
    if skipped:
        lines.append(f"코드가 없는 {skipped}줄은 그대로 두었습니다.")
    if stats["meat_no_weight"]:
        lines.append(f"무게가 없는 고기 {stats['meat_no_weight']}줄은 그대로 두었습니다.")
    return False, "\n".join(lines)


VENDOR_SHEET = "거래처관리"
BALANCE_SHEET = "거래처매입누적"
BALANCE_HEADERS = [
    "거래처",
    "거래일자",
    "영수증합계금액",
    "수금",
    "당월누적금액",
    "검증누계금액",
    "검증",
    "영수증위치",
    "영수증UPTIME",
]


def money_or_none(value):
    text = str(value or "").strip().replace(",", "").replace("원", "")
    if not text:
        return None
    try:
        return tidy_number(float(text))
    except ValueError:
        return None


def normalize_biz(value):
    text = str(value or "").strip()
    if text.lower() in {"", "null", "none", "없음"}:
        return ""
    digits = re.sub(r"\D", "", text)
    if len(digits) == 10:
        return f"{digits[:3]}-{digits[3:5]}-{digits[5:]}"
    return text


def prices_exclude_tax(item):
    flag = item.get("pricesIncludeTax")
    if isinstance(flag, bool):
        return not flag
    text = str(flag or "").strip().lower()
    return text in {"false", "0", "no", "별도", "미포함"}


def is_donguibogam_items_(items):
    for item in items or []:
        biz = re.sub(r"\D", "", str(item.get("businessNumber") or item.get("biz") or ""))
        if biz == "2118629450":
            return True
        name = str(item.get("vendor") or "") + str(item.get("originalName") or "")
        if "동의보감" in name:
            return True
    return False


def apply_donguibogam_rules(items):
    """동의보감: 총매입=단가(금액)+세액, 당월누적=미수금(현)."""
    if not items or not is_donguibogam_items_(items):
        return False
    changed = False
    line_sum = 0.0
    for item in items:
        tax = money_or_none(item.get("taxAmount"))
        qty = as_number(item.get("originalQty") if item.get("originalQty") not in (None, "") else item.get("qty"))
        if not qty:
            qty = 1.0
        unit = money_or_none(item.get("unitPrice"))
        tot = money_or_none(item.get("totalPrice"))
        base = None
        if unit is not None:
            base = tidy_number(as_number(unit) * qty)
        if tot is not None:
            base = tot
        if base is None:
            continue
        if tax is not None and abs(as_number(tax)) > 0:
            unit_base = tidy_number(as_number(unit) * qty) if unit is not None else None
            already = (
                unit_base is not None
                and tot is not None
                and abs(as_number(tot) - tidy_number(as_number(unit_base) + as_number(tax))) <= 1
            )
            if not already:
                supply = unit_base if unit_base is not None else base
                if tot is not None and unit_base is not None and abs(as_number(tot) - as_number(unit_base)) > 1:
                    supply = tot
                inclusive = tidy_number(as_number(supply) + as_number(tax))
                item["totalPrice"] = inclusive
                item["unitPrice"] = tidy_number(as_number(inclusive) / qty)
                item["pricesIncludeTax"] = True
                changed = True
        line_sum += as_number(item.get("totalPrice"))
    line_sum = tidy_number(line_sum)
    first = items[0]
    prev = money_or_none(first.get("previousCredit"))
    if prev is None:
        prev = money_or_none(first.get("previousReceivable") or first.get("outstandingPrevious"))
    cur = money_or_none(first.get("currentReceivable") or first.get("outstandingCurrent"))
    month = money_or_none(first.get("monthTotal"))
    if cur is not None:
        for item in items:
            item["monthTotal"] = cur
            item["accumulatedAmount"] = cur
        changed = True
    elif prev is not None and line_sum > 0 and (month is None or abs(as_number(month) - as_number(prev)) < 1):
        expect = tidy_number(as_number(prev) + as_number(line_sum))
        for item in items:
            item["monthTotal"] = expect
            item["accumulatedAmount"] = expect
            if prev is not None:
                item["previousCredit"] = prev
        changed = True
    if line_sum > 0:
        for item in items:
            item["dailyAmount"] = line_sum
        changed = True
    return changed


def apply_vat_inclusive(items):
    # 동의보감은 줄세액 규칙 우선
    if apply_donguibogam_rules(items):
        return True
    # 공급가액과 세액이 분리된 명세서만 품목 금액을 부가세 포함으로 맞춘다.
    # 품목 금액이 이미 합계와 같으면 세액을 다시 더하지 않는다.
    tax = None
    supply = None
    for item in items:
        if tax is None:
            tax = money_or_none(item.get("taxAmount"))
        if supply is None:
            supply = money_or_none(item.get("supplyAmount"))
    if tax is None or tax <= 0:
        return False
    amounts = [as_number(item.get("totalPrice")) for item in items]
    line_sum = sum(amounts)
    if line_sum <= 0:
        return False
    if supply is not None:
        if abs(line_sum - (supply + tax)) <= 1:
            return False
        if abs(line_sum - supply) > 1:
            return False
    elif not any(prices_exclude_tax(item) for item in items):
        return False
    used = 0.0
    inclusive_amounts = []
    for index, amount in enumerate(amounts):
        if index == len(amounts) - 1:
            share = tax - used
        else:
            share = round(tax * amount / line_sum)
            used += share
        inclusive_amounts.append(tidy_number(amount + share))
    inclusive_sum = tidy_number(sum(as_number(value) for value in inclusive_amounts))
    for item, amount, inclusive in zip(items, amounts, inclusive_amounts):
        item["totalPrice"] = inclusive
        qty = as_number(item.get("originalQty"))
        if qty:
            item["unitPrice"] = tidy_number(as_number(inclusive) / qty)
        elif amount:
            unit = as_number(item.get("unitPrice"))
            item["unitPrice"] = tidy_number(unit * as_number(inclusive) / amount)
    for item in items:
        daily = money_or_none(item.get("dailyAmount"))
        ex_vat = supply if supply is not None else line_sum
        if daily is None or abs(daily - ex_vat) <= 1:
            item["dailyAmount"] = inclusive_sum
    return True


def receipt_amounts(items):
    vendor = ""
    receipt_date = ""
    daily = None
    month_total = None
    payment = None
    biz = ""
    line_sum = 0
    for item in items:
        if not vendor:
            vendor = str(item.get("vendor") or "").strip()
        if not receipt_date:
            receipt_date = normalize_receipt_date(item.get("receiptDate"))
        if daily is None:
            daily = money_or_none(item.get("dailyAmount"))
        if month_total is None:
            month_total = money_or_none(item.get("monthTotal"))
        if payment is None:
            found_payment = money_or_none(item.get("paymentAmount"))
            if found_payment is not None and as_number(found_payment) > 0:
                payment = found_payment
        if not biz:
            biz = normalize_biz(item.get("businessNumber"))
        line_sum += as_number(item.get("totalPrice"))
    if daily is None and line_sum:
        daily = tidy_number(line_sum)
    return vendor, receipt_date, daily, month_total, biz, payment


def load_vendor_master(spreadsheet):
    worksheet = sheet_or_raise(spreadsheet, VENDOR_SHEET)
    rows = []
    for index, row in enumerate(worksheet.get_all_values()[1:], start=2):
        name = str(row[0]).strip() if row else ""
        if not name:
            continue
        rows.append({
            "row": index,
            "vendor": name,
            "key": normalize_vendor(name),
            "biz": str(row[1]).strip() if len(row) > 1 else "",
            "check": str(row[2]).strip().upper() if len(row) > 2 else "",
        })
    return worksheet, rows


def sync_vendors(spreadsheet, pairs):
    worksheet, rows = load_vendor_master(spreadsheet)
    known = {row["key"]: row for row in rows}
    added = []
    queued = set()
    for vendor, biz in pairs:
        vendor = str(vendor or "").strip()
        biz = normalize_biz(biz)
        key = normalize_vendor(vendor)
        if not key:
            continue
        current = known.get(key)
        if current is None:
            if key in queued:
                if biz:
                    for index, (name, saved_biz) in enumerate(added):
                        if normalize_vendor(name) == key and not saved_biz:
                            added[index] = (name, biz)
                continue
            queued.add(key)
            added.append((vendor, biz))
            continue
        if biz and not current["biz"]:
            worksheet.update_cell(current["row"], 2, biz)
            current["biz"] = biz
    if added:
        worksheet.append_rows([[name, biz, ""] for name, biz in added], value_input_option="USER_ENTERED")
    return len(added)


def order_same_day(buckets):
    remaining = list(buckets)
    ordered = []
    while remaining:
        def precedes(earlier, later):
            if earlier["month"] is None or later["month"] is None or later["daily"] is None:
                return False
            implied_prev = as_number(later["month"]) - as_number(later["daily"])
            return abs(implied_prev - as_number(earlier["month"])) < 1

        starters = [
            item for item in remaining
            if not any(precedes(other, item) for other in remaining if other is not item)
        ]
        if starters:
            starters.sort(key=lambda item: (item["month"] is None, item["month"] or 0, item["daily"] or 0))
            pick = starters[0]
        else:
            pick = remaining[0]
        ordered.append(pick)
        remaining.remove(pick)
    return ordered


def build_balance_rows(receipt_rows, vendor_rows, saved_amounts=None):
    """검증대상 Y 거래처를 사업자번호(우선)·거래처명(보조)으로 원재료입고와 매칭."""
    allowed = {}
    allowed_by_biz = {}
    for row in vendor_rows:
        if str(row.get("check", "")).strip().upper() != "Y":
            continue
        allowed[row["key"]] = row["vendor"]
        biz_digits = re.sub(r"\D", "", str(row.get("biz") or ""))
        if len(biz_digits) == 10:
            allowed_by_biz[biz_digits] = row["vendor"]
    grouped = {}
    for row in receipt_rows:
        if not row or not any(str(cell).strip() for cell in row):
            continue
        if money_or_none(receipt_cell(row, RECEIPT_TOTAL)) is None:
            continue
        daily_known = money_or_none(receipt_cell(row, RECEIPT_DAILY)) is not None
        biz_digits = re.sub(r"\D", "", str(receipt_cell(row, RECEIPT_BIZ) or ""))
        status = str(receipt_cell(row, RECEIPT_STATUS) or "").strip()
        if not daily_known and len(biz_digits) != 10 and status not in {"검수대기", "반영완료"}:
            continue
        master_name = None
        if len(biz_digits) == 10 and biz_digits in allowed_by_biz:
            master_name = allowed_by_biz[biz_digits]
        else:
            name_key = normalize_vendor(receipt_cell(row, RECEIPT_VENDOR))
            if name_key in allowed:
                master_name = allowed[name_key]
        date = normalize_receipt_date(receipt_cell(row, RECEIPT_DATE))
        if not master_name or not date:
            continue
        key = normalize_vendor(master_name)
        daily = money_or_none(receipt_cell(row, RECEIPT_DAILY))
        group_key = (key, date, daily)
        bucket = grouped.get(group_key)
        if bucket is None:
            bucket = {"daily": daily, "month": None, "lines": 0.0}
            grouped[group_key] = bucket
        bucket["lines"] += as_number(receipt_cell(row, RECEIPT_TOTAL))
        month = money_or_none(receipt_cell(row, RECEIPT_MONTH_TOTAL))
        if month is not None:
            bucket["month"] = month
    saved_amounts = saved_amounts or {}
    by_vendor = {}
    for (key, date, _daily), bucket in grouped.items():
        by_vendor.setdefault(key, {}).setdefault(date, []).append(bucket)
    result = []
    for key in sorted(by_vendor, key=lambda item: allowed[item]):
        previous = 0
        previous_month = ""
        for date in sorted(by_vendor[key]):
            buckets = order_same_day(by_vendor[key][date])
            saved_list = saved_amounts.get((key, date), [])
            for bucket in buckets:
                if bucket["month"] is None:
                    matches = [item for item in saved_list if amounts_match(item["daily"], bucket["daily"])]
                    if len(matches) == 1:
                        bucket["month"] = matches[0]["month"]
                    elif bucket["daily"] is None and len(saved_list) == 1:
                        bucket["daily"] = saved_list[0]["daily"]
                        bucket["month"] = saved_list[0]["month"]
                amount = bucket["daily"] if bucket["daily"] is not None else tidy_number(bucket["lines"])
                opening = previous
                current_month = date[:7]
                if previous_month and current_month != previous_month and amounts_match(bucket["month"], amount):
                    opening = 0
                entered = saved_payment(saved_list, bucket["daily"])
                payment, check_total, status, carried = settle_receipt(
                    opening, amount, bucket["month"], entered,
                )
                previous = carried
                previous_month = current_month
                result.append({
                    "vendor": allowed[key],
                    "date": date,
                    "daily": bucket["daily"],
                    "payment": payment,
                    "month": bucket["month"],
                    "check_total": check_total,
                    "status": status,
                })
    return result


def saved_payment(saved_list, daily):
    matches = [
        item for item in saved_list
        if item.get("payment") not in (None, 0) and amounts_match(item.get("daily"), daily)
    ]
    if len(matches) == 1:
        return matches[0]["payment"]
    if daily is None and len(saved_list) == 1 and saved_list[0].get("payment") not in (None, 0):
        return saved_list[0]["payment"]
    return None


def settle_receipt(opening, amount, month_total, entered_payment=None):
    # 수금은 사람이 넣은 값만 뺀다. 빈 칸은 0원이다.
    # 확인요망이면 다음 영수증은 명세표의 플러스 잔액부터 비교한다.
    opening = as_number(opening)
    amount = as_number(amount)
    payment = 0 if entered_payment is None else as_number(entered_payment)
    if payment < 0:
        payment = 0
    shown = None if payment == 0 else tidy_number(payment)
    check_total = tidy_number(opening + amount - payment)
    if month_total is None:
        return shown, check_total, "확인요망", check_total
    month_total = as_number(month_total)
    if amounts_match(check_total, month_total):
        return shown, check_total, "OK", check_total
    if payment == 0 and amounts_match(month_total, opening) and amount > 0 and (opening > 0 or month_total > 0):
        after = tidy_number(opening + amount)
        return None, after, "OK", after
    # 당월누적이 마이너스인 선금 잔액은 다음 누계의 기준이 되지 않는다.
    # 검증누계는 다른 거래처와 같이 영수증 합계를 이어서 더한다.
    carried = check_total if month_total < 0 else month_total
    return shown, check_total, "확인요망", carried


def balance_worksheet(spreadsheet):
    try:
        return spreadsheet.worksheet(BALANCE_SHEET)
    except gspread.WorksheetNotFound:
        return spreadsheet.add_worksheet(title=BALANCE_SHEET, rows=500, cols=len(BALANCE_HEADERS))


def write_balance_headers(worksheet):
    current = [str(cell).strip() for cell in worksheet.row_values(1)[:len(BALANCE_HEADERS)]]
    if current != BALANCE_HEADERS:
        if current and current[0] and current[0] != "거래처":
            raise RuntimeError(f"'{BALANCE_SHEET}' 첫 행이 예상한 머리글이 아닙니다.")
        end = col_letter(len(BALANCE_HEADERS) - 1)
        worksheet.update([BALANCE_HEADERS], f"A1:{end}1", value_input_option="USER_ENTERED")


def header_index(headers, names, fallback):
    for name in names:
        if name in headers:
            return headers.index(name)
    return fallback


def saved_balance_amounts(worksheet):
    values = worksheet.get_all_values()
    headers = [str(cell).strip() for cell in values[0]] if values else []
    daily_index = header_index(headers, ("영수증합계금액", "당일금액"), 2)
    payment_index = header_index(headers, ("수금",), None)
    month_index = header_index(headers, ("당월누적금액",), 3)
    found = {}
    for row in values[1:]:
        if not row or not str(row[0]).strip():
            continue
        key = normalize_vendor(row[0])
        date = normalize_receipt_date(row[1] if len(row) > 1 else "")
        if not key or not date:
            continue
        payment = None
        if payment_index is not None and len(row) > payment_index:
            payment = money_or_none(row[payment_index])
        found.setdefault((key, date), []).append({
            "daily": money_or_none(row[daily_index] if len(row) > daily_index else ""),
            "payment": payment,
            "month": money_or_none(row[month_index] if len(row) > month_index else ""),
        })
    return found


def apply_entered_payments(saved, entries):
    saved = saved or {}
    for entry in entries or []:
        key = (normalize_vendor(entry.get("vendor")), normalize_receipt_date(entry.get("date")))
        if not key[0] or not key[1]:
            continue
        payment = money_or_none(entry.get("payment"))
        if payment is not None and as_number(payment) <= 0:
            payment = None
        daily = entry.get("daily")
        bucket = saved.setdefault(key, [])
        matches = [item for item in bucket if amounts_match(item.get("daily"), daily)]
        if not matches and daily is None and len(bucket) == 1:
            matches = bucket
        if matches:
            matches[0]["payment"] = payment
        elif payment is not None:
            bucket.append({"daily": daily, "payment": payment, "month": None})
    return saved


def rebuild_vendor_balances(log=None, payments=None):
    def say(text):
        if log:
            log(text)

    say("거래처관리와 원재료입고를 읽는 중...")
    spreadsheet = open_sheet()
    staging = sheet_or_raise(spreadsheet, "원재료입고")
    ensure_title(staging, RECEIPT_DAILY + 1, "영수증합계금액")
    ensure_title(staging, RECEIPT_PAYMENT + 1, "수금")
    receipt_rows = staging.get_all_values()[1:]
    pairs = []
    for row in receipt_rows:
        vendor = str(receipt_cell(row, RECEIPT_VENDOR)).strip()
        if vendor:
            pairs.append((vendor, receipt_cell(row, RECEIPT_BIZ)))
    added = sync_vendors(spreadsheet, pairs)
    if added:
        say(f"거래처관리에 새 거래처 {added}곳을 추가했습니다.")
    _worksheet, vendors = load_vendor_master(spreadsheet)
    balance = balance_worksheet(spreadsheet)
    saved = apply_entered_payments(saved_balance_amounts(balance), payments)
    built = build_balance_rows(receipt_rows, vendors, saved)
    existing = balance.get_all_values()
    write_balance_headers(balance)
    end = col_letter(len(BALANCE_HEADERS) - 1)
    if len(existing) > 1:
        balance.batch_clear([f"A2:{end}{len(existing)}"])
    if built:
        values = [[
            row["vendor"],
            row["date"],
            "" if row["daily"] is None else row["daily"],
            "" if not row["payment"] else row["payment"],
            "" if row["month"] is None else row["month"],
            row["check_total"],
            row["status"],
        ] for row in built]
        balance.update(values, f"A2:{end}{1 + len(values)}", value_input_option="USER_ENTERED")
    y_count = sum(1 for row in vendors if row["check"] == "Y")
    warnings = sum(1 for row in built if row["status"] != "OK")
    say(f"검증대상 {y_count}곳, {len(built)}줄을 기록했습니다.")
    message = (
        f"완료되었습니다.\n검증대상 {y_count}곳, {len(built)}줄을 '거래처매입누적'에 넣었습니다.\n"
        f"확인요망 {warnings}건입니다.\n수금은 직접 입력한 금액만 반영했습니다."
    )
    if added:
        message += f"\n새 거래처 {added}곳은 '거래처관리'에 빈 검증대상으로 추가했습니다."
    return False, message


def load_vendor_balances():
    worksheet = balance_worksheet(open_sheet())
    values = worksheet.get_all_values()
    headers = [str(cell).strip() for cell in values[0]] if values else []
    daily_index = header_index(headers, ("영수증합계금액", "당일금액"), 2)
    payment_index = header_index(headers, ("수금",), None)
    month_index = header_index(headers, ("당월누적금액",), 3)
    check_index = header_index(headers, ("검증누계금액",), 4)
    status_index = header_index(headers, ("검증",), 5)
    rows = []
    for index, row in enumerate(values[1:], start=2):
        if not row or not str(row[0]).strip():
            continue
        payment = None
        if payment_index is not None and len(row) > payment_index:
            payment = money_or_none(row[payment_index])
        rows.append({
            "row": index,
            "vendor": str(row[0]).strip(),
            "date": normalize_receipt_date(row[1] if len(row) > 1 else ""),
            "daily": money_or_none(row[daily_index] if len(row) > daily_index else ""),
            "payment": payment,
            "month": money_or_none(row[month_index] if len(row) > month_index else ""),
            "check_total": money_or_none(row[check_index] if len(row) > check_index else ""),
            "status": str(row[status_index]).strip() if len(row) > status_index else "",
        })
    rows.sort(key=lambda item: (item["vendor"], item["date"]))
    return rows


def shift_months(day, months):
    year = day.year
    month = day.month - months
    while month <= 0:
        month += 12
        year -= 1
    for length in (31, 30, 29, 28):
        try:
            return day.replace(year=year, month=month, day=min(day.day, length))
        except ValueError:
            continue
    return day.replace(year=year, month=month, day=1)


def load_unit_prices():
    spreadsheet = open_sheet()
    staging = sheet_or_raise(spreadsheet, "원재료입고")
    try:
        master = material_master(spreadsheet)
    except RuntimeError:
        master = {}
    aliases = alias_index(master)
    found = []
    for row in staging.get_all_values()[1:]:
        if not row or not any(str(cell).strip() for cell in row):
            continue
        price = money_or_none(receipt_cell(row, RECEIPT_PRICE))
        date = normalize_receipt_date(receipt_cell(row, RECEIPT_DATE))
        if price is None or as_number(price) <= 0 or not date:
            continue
        code = str(receipt_cell(row, RECEIPT_CODE)).strip()
        official = str(receipt_cell(row, RECEIPT_OFFICIAL)).strip()
        original = str(receipt_cell(row, RECEIPT_NAME)).strip()
        info = master.get(code) if code else None
        if info is None:
            matched = aliases.get(normalize_item_name(official or original))
            info = master.get(matched) if matched else None
        name = (info.get("name") if info else "") or official or original or code
        if not name:
            continue
        found.append({
            "key": code or name,
            "code": code,
            "name": name,
            "category": str(info.get("category") or "").strip() if info else "",
            "date": date,
            "vendor": str(receipt_cell(row, RECEIPT_VENDOR)).strip(),
            "unit": str(receipt_cell(row, RECEIPT_UNIT)).strip(),
            "qty": money_or_none(receipt_cell(row, RECEIPT_QTY)),
            "price": price,
        })
    return found


def material_price_summary(rows, start_date, end_date):
    grouped = {}
    for row in rows:
        if row["date"] < start_date or row["date"] > end_date:
            continue
        bucket = grouped.setdefault(row["key"], {
            "name": row["name"], "code": row["code"], "category": row.get("category", ""), "points": [],
        })
        if row["name"]:
            bucket["name"] = row["name"]
        if row["code"]:
            bucket["code"] = row["code"]
        if row.get("category"):
            bucket["category"] = row["category"]
        bucket["points"].append(row)
    result = []
    for key, bucket in grouped.items():
        points = sorted(bucket["points"], key=lambda item: (item["date"], item["vendor"], item["price"]))
        weight = 0.0
        weighted = 0.0
        for point in points:
            qty = point["qty"] if point["qty"] is not None and as_number(point["qty"]) > 0 else 1
            weighted += as_number(point["price"]) * as_number(qty)
            weight += as_number(qty)
        prices = [as_number(point["price"]) for point in points]
        units = {point["unit"] for point in points if point["unit"]}
        result.append({
            "key": key,
            "name": bucket["name"],
            "code": bucket["code"],
            "category": bucket.get("category", ""),
            "points": points,
            "average": tidy_number(weighted / weight) if weight else None,
            "count": len(points),
            "low": tidy_number(min(prices)),
            "high": tidy_number(max(prices)),
            "latest": tidy_number(prices[-1]),
            "mixed_units": len(units) > 1,
        })
    result.sort(key=lambda item: item["name"])
    return result


def process_receipts_ocr(log):
    log("입고대기 폴더를 확인하는 중...")
    dirs = local_receipt_dirs()
    if not dirs:
        return True, "입고대기 폴더를 찾지 못했습니다.\n구글 드라이브가 이 PC에 연결되어 있는지 확인해 주세요."
    upload_dir, done_dir = dirs
    files = [path for path in upload_dir.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_TYPES]
    if not files:
        return False, "처리할 명세서가 없습니다."
    spreadsheet = open_sheet()

    recipe = sheet_or_raise(spreadsheet, "레시피배합표")
    staging = sheet_or_raise(spreadsheet, "원재료입고")
    try:
        master = material_master(spreadsheet)
    except RuntimeError:
        master = {}
        log("원재료관리 시트가 없어 영수증 수량을 그대로 기록합니다.")
    ensure_title(staging, RECEIPT_DAILY + 1, "영수증합계금액")
    ensure_title(staging, RECEIPT_POSTED + 1, "반영월")
    ensure_title(staging, RECEIPT_PAYMENT + 1, "수금")
    db_text = mapping_db_text(master, recipe.get_all_values()[1:])

    saved = 0
    replaced = 0
    added_vendors = 0
    failed = []
    holding_dir = upload_dir.parent / "처리중"
    holding_dir.mkdir(exist_ok=True)
    for path in files:
        file_name = path.name
        holding = None
        log(f"분석 중: {file_name}")
        try:
            if not path.is_file():
                if (done_dir / file_name).is_file() or (holding_dir / file_name).is_file():
                    log(f"이미 처리완료로 옮겨져 건너뜁니다: {file_name}")
                    continue
                raise FileNotFoundError(2, "No such file or directory", str(path))
            image_bytes = path.read_bytes()
            holding = unique_destination(holding_dir, file_name)
            if not archive_receipt(path, holding, image_bytes):
                raise OSError(f"입고대기에서 빼지 못했습니다: {file_name}")
            raw = ask_gemini(image_bytes, IMAGE_TYPES[holding.suffix.lower()], db_text)
            items = parse_ai_json(raw)
            for item in items:
                apply_known_mapping(item, master)
            if apply_vat_inclusive(items):
                log("세액이 따로 있어 단가와 품목금액을 부가세 포함 금액으로 맞췄습니다.")
            timestamp = now_text()
            vendor_name, receipt_date, daily_amount, month_total, biz, payment = receipt_amounts(items)
            rows = []
            receipt_key = receipt_identity(receipt_date, vendor_name, daily_amount)
            for item in items:
                unique_id = receipt_key
                final_qty = reflected_quantity(
                    master,
                    item.get("mappedCode"),
                    item.get("unit"),
                    item.get("originalQty"),
                )
                if final_qty is None:
                    final_qty = blank(item.get("finalQty"))
                line_date = normalize_receipt_date(item.get("receiptDate")) or receipt_date
                rows.append([
                    timestamp,
                    unique_id,
                    line_date,
                    blank(item.get("vendor")),
                    biz,
                    "" if daily_amount is None else daily_amount,
                    "" if month_total is None else month_total,
                    blank(item.get("originalName")),
                    blank(item.get("unit")),
                    blank(item.get("originalQty")),
                    blank(item.get("unitPrice")),
                    blank(item.get("totalPrice")),
                    blank(item.get("mappedCode")),
                    blank(item.get("mappedName")),
                    final_qty,
                    False,
                    "검수대기",
                    "",
                    "",  # S열(구 중간결제/수금): 미사용. 중간결제는 거래처매입누적 사용자 입력만
                ])
            if not rows:
                raise RuntimeError("추출된 품목이 없습니다.")
            removed = 0
            if receipt_date and vendor_name:
                removed = delete_same_receipt(staging, receipt_date, vendor_name, daily_amount)
            if removed:
                replaced += removed
                log(f"같은 영수증 기존 자료 {removed}줄을 삭제했습니다.")
            before = len(staging.get_all_values())
            staging.append_rows(rows, value_input_option="USER_ENTERED")
            add_checkboxes(spreadsheet, staging, before + 1, before + len(rows))
            try:
                if sync_vendors(spreadsheet, [(vendor_name, biz)]):
                    added_vendors += 1
                    log(f"거래처관리에 추가: {vendor_name}")
            except Exception as exc:
                log(f"거래처관리 기록 실패: {exc}")

            first = items[0]
            ext = file_name[file_name.rfind("."):] if "." in file_name else ""
            amount_name = "0" if daily_amount is None else str(daily_amount)
            new_name = "_".join([
                safe_filename(first.get("receiptDate"), "날짜미상"),
                safe_filename(first.get("vendor"), "거래처미상"),
                safe_filename(amount_name, "0"),
            ]) + ext
            archived = archive_receipt(holding, unique_destination(done_dir, new_name), image_bytes)
            holding = None
            saved += len(rows)
            if archived:
                log(f"기록 완료: {new_name} ({len(rows)}개 품목)")
            else:
                log(f"기록 완료: {new_name} ({len(rows)}개 품목). 처리중 파일이 남아 있습니다.")
        except FileNotFoundError as exc:
            if (done_dir / file_name).is_file() or (holding_dir / file_name).is_file():
                log(f"이미 처리완료로 옮겨져 건너뜁니다: {file_name}")
            else:
                failed.append(f"{file_name}: {exc}")
                log(f"실패: {file_name} / {exc}")
        except Exception as exc:
            if holding is not None and holding.is_file():
                try:
                    archive_receipt(holding, unique_destination(upload_dir, file_name), holding.read_bytes())
                    log(f"분석 실패로 입고대기에 되돌렸습니다: {file_name}")
                except OSError:
                    log(f"실패 후 처리중에 남아 있습니다: {holding.name}")
            failed.append(f"{file_name}: {exc}")
            log(f"실패: {file_name} / {exc}")

    if saved and not failed:
        extra = f"\n같은 거래일자, 거래처의 기존 {replaced}줄은 지우고 다시 넣었습니다." if replaced else ""
        vendor_line = f"\n새 거래처 {added_vendors}곳을 '거래처관리'에 추가했습니다." if added_vendors else ""
        return False, f"완료되었습니다.\n명세서 품목 {saved}개를 '원재료입고'에 기록했습니다.{vendor_line}\n금액 검증은 '거래처 금액 검증'에서 계산합니다.{extra}"
    if saved and failed:
        return True, f"일부만 기록했습니다. 품목 {saved}개\n\n실패:\n" + "\n".join(failed)
    detail = "\n".join(failed) if failed else "명세서를 읽지 못했습니다."
    if len(detail) > 500:
        detail = detail[:500] + "..."
    return True, "영수증 OCR에 실패했습니다.\n" + detail


# 원재료_실시간재고 컬럼 (0-indexed)
# A기준월 B업데이트 C코드 D명 E이월 F입고 G사용 H조정입고 I조정로스
# J안전재고 K현재고 L부족수량 M재고단위 N직관 O입고규격 P구분
INV_OPENING, INV_INCOMING, INV_USED = 4, 5, 6
INV_ADJ_IN, INV_ADJ_LOSS, INV_SAFETY = 7, 8, 9
INV_STOCK, INV_SHORTAGE, INV_UNIT = 10, 11, 12
INV_DISPLAY, INV_SPEC, INV_CATEGORY = 13, 14, 15
INV_USED_TODAY = 16
INV_AVG_USED = 17


def normalize_purchase_timing(raw):
    t = str(raw or "").strip().lower().replace(" ", "")
    if t == "pos":
        return "pos"
    if t in ("평균주기", "구매주기", "평균", "주기"):
        return "평균주기"
    return ""


def add_days_iso(iso, days):
    try:
        base = datetime.strptime(str(iso)[:10], "%Y-%m-%d")
    except ValueError:
        return ""
    return (base + timedelta(days=days)).strftime("%Y-%m-%d")


def days_between_iso(a, b):
    try:
        da = datetime.strptime(str(a)[:10], "%Y-%m-%d")
        db = datetime.strptime(str(b)[:10], "%Y-%m-%d")
    except ValueError:
        return 0
    return max(1, (db - da).days)


def last_day_of_month_iso(ym):
    try:
        y, m = str(ym).split("-")[:2]
        y, m = int(y), int(m)
        if m == 12:
            nxt = datetime(y + 1, 1, 1)
        else:
            nxt = datetime(y, m + 1, 1)
        return (nxt - timedelta(days=1)).strftime("%Y-%m-%d")
    except Exception:
        return ""


def build_avg_cycle_stats(staging_rows, master, today_iso):
    """평균주기 코드 → {avg_daily, last_date, orders}."""
    cutoff = add_days_iso(today_iso, -365) or "2000-01-01"
    by_code = {}
    for row in staging_rows[1:]:
        if len(row) <= RECEIPT_STATUS or str(receipt_cell(row, RECEIPT_STATUS)).strip() != "반영완료":
            continue
        code = str(receipt_cell(row, RECEIPT_CODE)).strip()
        if not code:
            continue
        info = master.get(code) or {}
        if info.get("purchase_timing") != "평균주기":
            continue
        day = str(normalize_receipt_date(receipt_cell(row, RECEIPT_DATE)) or "")[:10]
        if len(day) < 10 or day < cutoff:
            continue
        qty = as_number(receipt_cell(row, RECEIPT_FINAL))
        if qty <= 0:
            continue
        by_code.setdefault(code, {})
        by_code[code][day] = by_code[code].get(day, 0) + qty
    out = {}
    for code, day_map in by_code.items():
        days = sorted(day_map.keys())
        if not days:
            continue
        qtys = [day_map[d] for d in days]
        avg_qty = sum(qtys) / len(qtys)
        avg_cycle = 0.0
        if len(days) >= 2:
            gaps = [days_between_iso(days[i - 1], days[i]) for i in range(1, len(days))]
            avg_cycle = sum(gaps) / len(gaps)
        avg_daily = round(avg_qty / avg_cycle, 6) if avg_cycle > 0 else 0.0
        out[code] = {"avg_daily": avg_daily, "last_date": days[-1], "orders": len(days)}
    return out


def cycle_usage_for_month(stat, open_month, today_text):
    avg_daily = float(stat.get("avg_daily") or 0)
    if avg_daily <= 0:
        return 0.0, 0.0
    month_start = f"{open_month}-01"
    month_end = today_text if text_month(today_text) == open_month else last_day_of_month_iso(open_month) or today_text
    last_date = str(stat.get("last_date") or "")[:10]
    start = month_start
    if last_date and last_date >= month_start:
        start = add_days_iso(last_date, 1)
    if not start or start > month_end:
        return 0.0, 0.0
    try:
        da = datetime.strptime(start, "%Y-%m-%d")
        db = datetime.strptime(month_end, "%Y-%m-%d")
        days = (db - da).days + 1
    except ValueError:
        days = 0
    if days < 0:
        days = 0
    used = round(avg_daily * days, 6)
    used_today = 0.0
    if text_month(today_text) == open_month and (not last_date or today_text > last_date):
        used_today = round(avg_daily, 6)
    return used, used_today


def calc_current_stock(opening, incoming, used, adj_in=0, adj_loss=0):
    """현재고 = 이월 + 입고 - 사용 + 조정입고 - 조정로스 (수식 없이 값)."""
    return tidy_number(
        as_number(opening) + as_number(incoming) - as_number(used)
        + as_number(adj_in) - as_number(adj_loss)
    )


def pack_size_from_spec(spec):
    text = str(spec or "")
    if "/" in text:
        after = "/".join(text.split("/")[1:])
        match = re.search(r"\d+(?:\.\d+)?", after)
        return float(match.group(0)) if match else 0.0
    match = re.search(r"\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else 0.0


def pack_prefix_from_spec(spec):
    text = str(spec or "")
    if "/" not in text:
        return ""
    return re.sub(r"\s+", " ", text.split("/", 1)[0]).strip()


def round_qty_1(value):
    """직관적수량용 소수 1자리 반올림 (3.87 → 3.9)"""
    return round(as_number(value) * 10) / 10


def calc_display_qty(stock, unit, spec):
    """직관적 수량 텍스트. 잔여 kg 등은 소수 1자리. 예: 13Box 3.9kg"""
    qty = as_number(stock)
    unit_text = str(unit or "").strip()
    size = pack_size_from_spec(spec)
    if not size or size <= 0:
        return f"{round_qty_1(qty)}{unit_text}"
    abs_qty = abs(qty)
    boxes = int(abs_qty // size)
    if boxes <= 0:
        return f"{round_qty_1(qty)}{unit_text}"
    remain = round_qty_1(abs_qty % size)
    prefix = pack_prefix_from_spec(spec)
    sign = "-" if qty < 0 else ""
    out = f"{sign}{boxes}{prefix}"
    if remain:
        out += f" {remain}{unit_text}"
    return out


def stock_formula(row):
    # 하위 호환: 더 이상 시트에 쓰지 않음. 값 계산은 calc_current_stock 사용.
    return calc_current_stock(0, 0, 0, 0, 0)


def display_formula(row):
    return ""


def text_month(value):
    text = str(value or "").strip()
    match = re.match(r"(\d{4})-(\d{2})", text)
    return f"{match.group(1)}-{match.group(2)}" if match else ""


def latest_month(values):
    months = [text_month(row[0]) for row in values[1:] if row and text_month(row[0] if row else "")]
    return max(months) if months else month_text()


def opening_from_stock(current_stock, adjustment, month_usage, month_receipts, size):
    size = size if size else 1
    opening = (current_stock - adjustment + month_usage) / size - month_receipts
    if abs(opening) < 1e-9:
        return 0
    return round(opening, 6)


def receipt_month(row):
    posted = text_month(receipt_cell(row, RECEIPT_POSTED))
    if posted:
        return posted
    return text_month(normalize_receipt_date(receipt_cell(row, RECEIPT_DATE)))


def checked_value(value):
    if value is True:
        return True
    return str(value).strip().upper() in {"TRUE", "1", "YES", "Y"}


def load_inspection():
    spreadsheet = open_sheet()
    inventory = sheet_or_raise(spreadsheet, "원재료_실시간재고")
    staging = sheet_or_raise(spreadsheet, "원재료입고")
    inv_values = inventory.get_all_values()
    open_month = latest_month(inv_values) if len(inv_values) > 1 else month_text()
    rows = []
    for index, row in enumerate(staging.get_all_values()[1:], start=2):
        if not row or not any(str(cell).strip() for cell in row):
            continue
        if receipt_month(row) != open_month:
            continue
        official = str(receipt_cell(row, RECEIPT_OFFICIAL)).strip()
        original = str(receipt_cell(row, RECEIPT_NAME)).strip()
        rows.append({
            "row": index,
            "date": normalize_receipt_date(receipt_cell(row, RECEIPT_DATE)),
            "vendor": str(receipt_cell(row, RECEIPT_VENDOR)).strip(),
            "name": official or original,
            "spec": str(receipt_cell(row, RECEIPT_UNIT)).strip(),
            "qty": str(receipt_cell(row, RECEIPT_QTY)).strip(),
            "code": str(receipt_cell(row, RECEIPT_CODE)).strip(),
            "final": str(receipt_cell(row, RECEIPT_FINAL)).strip(),
            "checked": checked_value(receipt_cell(row, RECEIPT_CHECK)),
        })
    rows.sort(key=lambda item: (item["date"], item["vendor"], item["row"]))
    return open_month, rows


def paint_inspection_rows(spreadsheet, worksheet, gray_rows, white_rows):
    gray = {"red": 224 / 255, "green": 224 / 255, "blue": 224 / 255}
    white = {"red": 1, "green": 1, "blue": 1}
    requests = []
    for row, color in [(row, gray) for row in gray_rows] + [(row, white) for row in white_rows]:
        requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": worksheet.id,
                    "startRowIndex": row - 1,
                    "endRowIndex": row,
                    "startColumnIndex": 0,
                    "endColumnIndex": RECEIPT_POSTED + 1,
                },
                "cell": {"userEnteredFormat": {"backgroundColor": color}},
                "fields": "userEnteredFormat.backgroundColor",
            }
        })
    for index in range(0, len(requests), 80):
        spreadsheet.batch_update({"requests": requests[index:index + 80]})


def save_inspection(open_month, changes):
    if not changes:
        return False, "바뀐 검수 항목이 없습니다."
    spreadsheet = open_sheet()
    staging = sheet_or_raise(spreadsheet, "원재료입고")
    cells = []
    gray_rows = []
    white_rows = []
    done = 0
    waiting = 0
    for item in changes:
        row = int(item["row"])
        checked = bool(item["checked"])
        cells.append((f"{col_letter(RECEIPT_CHECK)}{row}", checked))
        cells.append((f"{col_letter(RECEIPT_STATUS)}{row}", "반영완료" if checked else "검수대기"))
        cells.append((f"{col_letter(RECEIPT_POSTED)}{row}", open_month if checked else ""))
        if checked:
            gray_rows.append(row)
            done += 1
        else:
            white_rows.append(row)
            waiting += 1
    batch_cells(staging, cells, raw=True)
    paint_inspection_rows(spreadsheet, staging, gray_rows, white_rows)
    lines = [
        "완료되었습니다.",
        f"반영완료 {done}건, 검수대기로 되돌린 {waiting}건을 기록했습니다.",
        "재고 수량은 실시간 재고 계산을 누를 때 합산됩니다.",
    ]
    return False, "\n".join(lines)


def ensure_title(worksheet, column, title):
    current = worksheet.cell(1, column).value
    if str(current or "").strip() != title:
        worksheet.update_cell(1, column, title)


def batch_cells(worksheet, cells, raw):
    payload = [{"range": cell, "values": [[value]]} for cell, value in cells]
    for index in range(0, len(payload), 80):
        worksheet.batch_update(payload[index:index + 80], raw=raw)


def live_stock_level(opening, incoming, used, adjustment=0, adj_loss=None):
    # 현재고 = 이월 + 입고 - 사용 + 조정입고 - 조정로스
    if adj_loss is None:
        # 구 UI: adjustment 한 칸(마이너스=로스) → 조정입고 0, 조정로스 = -min(0, adj) 등으로 안 쓰고
        # 양수 조정을 입고, 음수를 로스로 해석하지 않고 net 을 조정입고에 넣던 호환 경로
        return calc_current_stock(opening, incoming, used, adjustment, 0)
    return calc_current_stock(opening, incoming, used, adjustment, adj_loss)


def below_safety(stock, safety):
    if safety is None or safety == "":
        return False
    return as_number(stock) <= as_number(safety)


def stock_shortage(stock, safety):
    if not below_safety(stock, safety):
        return None
    return tidy_number(as_number(safety) - as_number(stock))


def load_live_stock():
    spreadsheet = open_sheet()
    inventory = sheet_or_raise(spreadsheet, "원재료_실시간재고")
    values = inventory.get_all_values()
    month = latest_month(values) if len(values) > 1 else month_text()
    order = {name: index for index, name in enumerate(CATEGORY_PREFIX)}
    rows = []
    for index, row in enumerate(values[1:], start=2):
        if text_month(row[0] if row else "") != month:
            continue
        code = str(cell_or_blank(row, 2)).strip()
        name = str(cell_or_blank(row, 3)).strip()
        if not code and not name:
            continue
        opening = money_or_none(cell_or_blank(row, INV_OPENING))
        incoming = money_or_none(cell_or_blank(row, INV_INCOMING))
        used = money_or_none(cell_or_blank(row, INV_USED))
        adj_in = money_or_none(cell_or_blank(row, INV_ADJ_IN))
        if adj_in is None:
            adj_in = 0
        adj_loss = money_or_none(cell_or_blank(row, INV_ADJ_LOSS))
        if adj_loss is None:
            adj_loss = 0
        safety = money_or_none(cell_or_blank(row, INV_SAFETY))
        unit = str(cell_or_blank(row, INV_UNIT)).strip()
        spec = str(cell_or_blank(row, INV_SPEC)).strip()
        stock = money_or_none(cell_or_blank(row, INV_STOCK))
        if stock is None:
            stock = calc_current_stock(opening, incoming, used, adj_in, adj_loss)
        display = str(cell_or_blank(row, INV_DISPLAY)).strip()
        if not display:
            display = calc_display_qty(stock, unit, spec)
        rows.append({
            "row": index,
            "code": code,
            "name": name or code,
            "category": str(cell_or_blank(row, INV_CATEGORY)).strip(),
            "unit": unit,
            "opening": opening,
            "incoming": incoming,
            "used": used,
            "adjustmentIn": adj_in,
            "adjustment": adj_loss,
            "safety": safety,
            "stock": stock,
            "display": display,
        })
    rows.sort(key=lambda item: (
        0 if below_safety(item["stock"], item["safety"]) else 1,
        order.get(item["category"], 99),
        item["name"],
        item["code"],
    ))
    return month, rows


def save_live_stock_cell(row_number, kind, value):
    row_number = int(row_number)
    # adjustment = 조정로스(I), adjustmentIn = 조정입고(H), safety = 안전재고(J)
    column = {
        "adjustment": "I",
        "adjustmentLoss": "I",
        "adjustmentIn": "H",
        "safety": "J",
    }[kind]
    spreadsheet = open_sheet()
    inventory = sheet_or_raise(spreadsheet, "원재료_실시간재고")
    written = "" if value is None else value
    batch_cells(inventory, [(f"{column}{row_number}", written)], raw=False)
    values = inventory.get(f"E{row_number}:O{row_number}")
    flat = values[0] if values else []
    # E F G H I J K L M N O → 이월~입고규격 (J안전 K현재고 L부족 …)
    opening = money_or_none(flat[0] if len(flat) > 0 else "")
    incoming = money_or_none(flat[1] if len(flat) > 1 else "")
    used = money_or_none(flat[2] if len(flat) > 2 else "")
    adj_in = money_or_none(flat[3] if len(flat) > 3 else "") or 0
    adj_loss = money_or_none(flat[4] if len(flat) > 4 else "") or 0
    safety = flat[5] if len(flat) > 5 else ""
    unit = str(flat[8] if len(flat) > 8 else "").strip()
    spec = str(flat[10] if len(flat) > 10 else "").strip()
    stock = calc_current_stock(opening, incoming, used, adj_in, adj_loss)
    display = calc_display_qty(stock, unit, spec)
    shortage = stock_shortage(stock, safety)
    shortage_cell = "" if shortage is None else shortage
    batch_cells(inventory, [
        (f"K{row_number}", stock),
        (f"L{row_number}", shortage_cell),
        (f"N{row_number}", display),
    ], raw=False)
    return stock, display


def calculate_inventory(log):
    log("판매, 레시피, 입고 내역을 읽는 중...")
    spreadsheet, _drive = connect()
    sales = sheet_or_raise(spreadsheet, "pos판매내역")
    recipe = sheet_or_raise(spreadsheet, "레시피배합표")
    inventory = sheet_or_raise(spreadsheet, "원재료_실시간재고")
    try:
        staging = spreadsheet.worksheet("원재료입고")
    except gspread.WorksheetNotFound:
        staging = None

    values = inventory.get_all_values()
    if len(values) <= 1:
        return True, "원재료_실시간재고에 계산할 재료가 없습니다."
    open_month = latest_month(values)
    if staging is not None:
        ensure_title(staging, RECEIPT_POSTED + 1, "반영월")
    log(f"기준월 {open_month} 입고와 판매만 합산합니다.")
    master = material_master(spreadsheet)
    today_text = now_text()[:10]
    staging_rows = staging.get_all_values() if staging is not None else []
    cycle_stats = build_avg_cycle_stats(staging_rows, master, today_text)

    sales_qty = {}
    sales_qty_today = {}
    for row in sales.get_all_values()[1:]:
        if len(row) < 3:
            continue
        a0 = str(row[0]).strip()
        if (
            len(row) >= 4
            and len(a0) == 10
            and a0[4] == "-"
            and a0[7] == "-"
            and str(row[2]).strip()
            and str(row[3]).strip() != ""
        ):
            day = a0
            name = str(row[2]).strip()
            qty = as_number(row[3])
        else:
            day = a0
            name = str(row[1]).strip()
            qty = as_number(row[2])
        day10 = str(day).strip()[:10]
        if text_month(day10) != open_month:
            continue
        if not (name and qty > 0):
            continue
        sales_qty[name] = sales_qty.get(name, 0) + qty
        if day10 == today_text:
            sales_qty_today[name] = sales_qty_today.get(name, 0) + qty

    usage = {}
    usage_today = {}
    avg_used = {}
    names = {}
    for row in recipe.get_all_values()[1:]:
        if len(row) < 6:
            continue
        menu = str(row[2]).strip()
        ing_name = row[3]
        code = str(row[4]).strip()
        amount = as_number(row[5])
        if not code or code in ("undefined", "nan"):
            continue
        info = master.get(code) or {}
        if info.get("purchase_timing") != "pos":
            continue
        names[code] = ing_name
        usage[code] = usage.get(code, 0) + (sales_qty.get(menu, 0) * amount)
        usage_today[code] = usage_today.get(code, 0) + (sales_qty_today.get(menu, 0) * amount)

    received = {}
    receipt_names = {}
    for row in staging_rows[1:]:
        if len(row) <= RECEIPT_STATUS or str(receipt_cell(row, RECEIPT_STATUS)).strip() != "반영완료":
            continue
        if receipt_month(row) != open_month:
            continue
        code = str(receipt_cell(row, RECEIPT_CODE)).strip()
        if not code or code not in master:
            continue
        timing = master[code].get("purchase_timing")
        if timing not in ("pos", "평균주기"):
            continue
        received[code] = received.get(code, 0) + as_number(receipt_cell(row, RECEIPT_FINAL))
        official = str(receipt_cell(row, RECEIPT_OFFICIAL)).strip()
        if official:
            receipt_names[code] = official

    for code, stat in cycle_stats.items():
        if master.get(code, {}).get("purchase_timing") != "평균주기":
            continue
        used, used_today = cycle_usage_for_month(stat, open_month, today_text)
        usage[code] = used
        usage_today[code] = used_today
        avg_used[code] = stat.get("avg_daily") or 0
        names.setdefault(code, master[code].get("name") or code)

    row_of = {}
    for index, row in enumerate(values[1:], start=2):
        if text_month(row[0] if row else "") != open_month:
            continue
        if len(row) > 2 and str(row[2]).strip():
            row_of[str(row[2]).strip()] = index

    timestamp = now_text()
    updates = []
    new_rows = []
    migrated = 0
    tracked = set(names) | set(received) | set(cycle_stats)
    for code in list(row_of):
        timing = (master.get(code) or {}).get("purchase_timing")
        if timing in ("pos", "평균주기"):
            tracked.add(code)
    ensure_title(inventory, INV_USED_TODAY + 1, "당일사용량")
    ensure_title(inventory, INV_AVG_USED + 1, "평균사용량")
    pos_n = 0
    cycle_n = 0
    for code in tracked:
        info = master.get(code)
        if not info:
            continue
        timing = info.get("purchase_timing")
        if timing not in ("pos", "평균주기"):
            continue
        if timing == "평균주기":
            cycle_n += 1
        else:
            pos_n += 1
        name = names.get(code) or receipt_names.get(code) or info.get("name") or code
        used = usage.get(code, 0)
        used_today = usage_today.get(code, 0)
        avg_val = avg_used.get(code, "") if timing == "평균주기" else ""
        month_received = received.get(code, 0)
        if code in row_of:
            row = row_of[code]
            current = values[row - 1]
            opening_cell = cell_or_blank(current, INV_OPENING)
            adj_in = as_number(cell_or_blank(current, INV_ADJ_IN)) if str(cell_or_blank(current, INV_ADJ_IN)).strip() != "" else 0
            adj_loss = as_number(cell_or_blank(current, INV_ADJ_LOSS)) if str(cell_or_blank(current, INV_ADJ_LOSS)).strip() != "" else 0
            unit = str(cell_or_blank(current, INV_UNIT)).strip() or info.get("stock_unit") or ""
            spec = str(cell_or_blank(current, INV_SPEC)).strip() or info.get("spec") or ""
            safety = cell_or_blank(current, INV_SAFETY)
            category = cell_or_blank(current, INV_CATEGORY) or info.get("category") or ""
            if str(opening_cell).strip() == "":
                stock_now = as_number(cell_or_blank(current, INV_STOCK))
                opening = stock_now - month_received + used - adj_in + adj_loss
                if abs(opening) < 1e-9:
                    opening = 0
                opening = round(opening, 6)
                migrated += 1
            else:
                opening = as_number(opening_cell)
            stock = calc_current_stock(opening, month_received, used, adj_in, adj_loss)
            display = calc_display_qty(stock, unit, spec)
            shortage = stock_shortage(stock, safety)
            shortage_cell = "" if shortage is None else shortage
            updates.extend([
                (f"B{row}", timestamp),
                (f"D{row}", name),
                (f"E{row}", opening),
                (f"F{row}", month_received),
                (f"G{row}", used),
                (f"H{row}", adj_in),
                (f"I{row}", adj_loss),
                (f"J{row}", safety),
                (f"K{row}", stock),
                (f"L{row}", shortage_cell),
                (f"M{row}", unit),
                (f"N{row}", display),
                (f"O{row}", spec),
                (f"P{row}", category),
                (f"Q{row}", used_today),
                (f"R{row}", avg_val),
            ])
        else:
            stock = calc_current_stock(0, month_received, used, 0, 0)
            display = calc_display_qty(stock, "", "")
            new_rows.append([
                open_month, timestamp, code, name, 0, month_received, used, 0, 0,
                "", stock, "", "", display, "", "", used_today, avg_val,
            ])

    if updates:
        log(f"기준월 {open_month} 재료 {len(tracked)}개 갱신 (pos {pos_n} · 평균주기 {cycle_n})")
        inventory.format(f"A2:A{max(row_of.values()) if row_of else 2}", {"numberFormat": {"type": "TEXT"}})
        batch_cells(inventory, updates, raw=False)

    if new_rows:
        inventory.format(
            f"A{len(inventory.get_all_values()) + 1}:A{len(inventory.get_all_values()) + len(new_rows)}",
            {"numberFormat": {"type": "TEXT"}},
        )
        inventory.append_rows(new_rows, value_input_option="USER_ENTERED")
        log(f"새 원재료 {len(new_rows)}개를 추가했습니다.")

    if migrated:
        kept = f"비어 있던 이월재고 {migrated}개는 현재 재고가 유지되도록 채웠습니다."
    else:
        kept = "이월재고·조정입고·조정로스는 그대로 두었습니다."
    return False, (
        f"완료되었습니다.\n기준월 {open_month} · pos {pos_n} · 평균주기 {cycle_n}건 반영.\n{kept}"
    )


def cell_or_blank(row, index):
    if len(row) <= index or row[index] is None:
        return ""
    return row[index]


def monthly_close(log):
    log("이번 달 마지막 재고를 다음 달 기초재고로 넘기는 중...")
    spreadsheet, _drive = connect()
    inventory = sheet_or_raise(spreadsheet, "원재료_실시간재고")
    values = inventory.get_all_values()
    if len(values) <= 1:
        return True, "원재료_실시간재고에 마감할 데이터가 없습니다."

    current = latest_month(values)
    following = next_month_text(current)
    current_rows = {}
    next_rows = {}
    for index, row in enumerate(values[1:], start=2):
        code = str(row[2]).strip() if len(row) > 2 else ""
        if not code:
            continue
        month = text_month(row[0] if row else "")
        if month == current:
            current_rows[code] = row
        elif month == following:
            next_rows[code] = index
    if not current_rows:
        return True, f"{current} 기준월 재고가 없습니다."

    timestamp = now_text()
    updates = []
    prepared = []
    for code, row in current_rows.items():
        unit = str(cell_or_blank(row, INV_UNIT)).strip()
        spec = str(cell_or_blank(row, INV_SPEC)).strip()
        stock_cell = cell_or_blank(row, INV_STOCK)
        if str(stock_cell).strip() == "":
            stock = calc_current_stock(
                cell_or_blank(row, INV_OPENING),
                cell_or_blank(row, INV_INCOMING),
                cell_or_blank(row, INV_USED),
                cell_or_blank(row, INV_ADJ_IN),
                cell_or_blank(row, INV_ADJ_LOSS),
            )
        else:
            stock = as_number(stock_cell)
        opening = 0 if abs(stock) < 1e-9 else round(stock, 6)
        next_stock = calc_current_stock(opening, 0, 0, 0, 0)
        next_display = calc_display_qty(next_stock, unit, spec)
        if code in next_rows:
            row_number = next_rows[code]
            existing = values[row_number - 1]
            keep_unit = str(cell_or_blank(existing, INV_UNIT)).strip() or unit
            keep_spec = str(cell_or_blank(existing, INV_SPEC)).strip() or spec
            keep_cat = cell_or_blank(existing, INV_CATEGORY) or cell_or_blank(row, INV_CATEGORY)
            keep_safety = cell_or_blank(existing, INV_SAFETY)
            if str(keep_safety).strip() == "" and str(cell_or_blank(row, INV_SAFETY)).strip() != "":
                keep_safety = cell_or_blank(row, INV_SAFETY)
            next_display = calc_display_qty(next_stock, keep_unit, keep_spec)
            keep_shortage = stock_shortage(next_stock, keep_safety)
            keep_shortage_cell = "" if keep_shortage is None else keep_shortage
            updates.extend([
                (f"B{row_number}", timestamp),
                (f"D{row_number}", cell_or_blank(row, 3)),
                (f"E{row_number}", opening),
                (f"F{row_number}", 0),
                (f"G{row_number}", 0),
                (f"H{row_number}", 0),
                (f"I{row_number}", 0),
                (f"J{row_number}", keep_safety),
                (f"K{row_number}", next_stock),
                (f"L{row_number}", keep_shortage_cell),
                (f"M{row_number}", keep_unit),
                (f"N{row_number}", next_display),
                (f"O{row_number}", keep_spec),
                (f"P{row_number}", keep_cat),
                (f"Q{row_number}", 0),
                (f"R{row_number}", ""),
            ])
            continue
        next_safety = cell_or_blank(row, INV_SAFETY)
        next_shortage = stock_shortage(next_stock, next_safety)
        next_shortage_cell = "" if next_shortage is None else next_shortage
        prepared.append([
            following, timestamp, code, cell_or_blank(row, 3), opening, 0, 0, 0, 0,
            next_safety, next_stock, next_shortage_cell, unit, next_display, spec,
            cell_or_blank(row, INV_CATEGORY), 0, "",
        ])

    if updates:
        batch_cells(inventory, updates, raw=False)
    if prepared:
        start = len(inventory.get_all_values()) + 1
        inventory.format(
            f"A{start}:A{start + len(prepared) - 1}",
            {"numberFormat": {"type": "TEXT"}},
        )
        inventory.append_rows(prepared, value_input_option="USER_ENTERED")

    return False, (
        f"완료되었습니다.\n{current} 행은 그대로 두었습니다.\n"
        f"남은 재고를 {following} 이월재고로 같은 시트에 {len(current_rows)}개 만들었습니다.\n"
        f"다음 달 입고, 사용량, 조정입고·로스는 0입니다."
    )
