import { google } from "googleapis";

const STOCK_SHEET = "원재료_실시간재고";
const RECEIPT_SHEET = "원재료입고";

function a1(sheet: string, range: string) {
  // 한글 시트명은 작은따옴표로 감싼다
  return `'${sheet.replace(/'/g, "''")}'!${range}`;
}

export function credentials() {
  let raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다.");
  }
  // Vercel에 따옴표로 감싸 넣은 경우
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    raw = raw.slice(1, -1);
  }

  let text = raw;
  if (!raw.startsWith("{")) {
    text = Buffer.from(raw, "base64").toString("utf8").trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON 형식이 잘못되었습니다. JSON 전체 또는 Base64 한 줄을 넣어 주세요.",
    );
  }

  if (typeof parsed.private_key === "string") {
    // 환경변수에서 \\n 으로 들어온 키를 실제 줄바꿈으로
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("서비스계정 JSON에 client_email / private_key 가 없습니다.");
  }
  return parsed;
}

export function sheetId() {
  let id = (process.env.SHEET_ID || "").trim();
  if (!id) throw new Error("SHEET_ID 환경변수가 없습니다.");
  if (
    (id.startsWith("'") && id.endsWith("'")) ||
    (id.startsWith('"') && id.endsWith('"'))
  ) {
    id = id.slice(1, -1).trim();
  }
  // URL 전체를 넣은 경우 ID만 추출
  const fromUrl = id.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl) return fromUrl[1];
  return id;
}

export function publicSheetsError(err: unknown) {
  const anyErr = err as {
    message?: string;
    code?: number | string;
    errors?: { message?: string }[];
    response?: { status?: number; data?: { error?: { message?: string } } };
  };
  const status = Number(anyErr?.code || anyErr?.response?.status || 0);
  const detail =
    anyErr?.errors?.[0]?.message ||
    anyErr?.response?.data?.error?.message ||
    anyErr?.message ||
    "";

  if (status === 404 || /Requested entity was not found/i.test(detail)) {
    let used = "";
    try {
      used = sheetId();
    } catch {
      used = "(없음)";
    }
    return (
      `구글 시트를 찾지 못했습니다. 지금 쓰는 SHEET_ID=${used}. ` +
      "Vercel 값에 공백/따옴표가 없는지, 시트 공유에 " +
      "pos-bot@okpos-inventory.iam.gserviceaccount.com 편집자가 있는지 확인하세요."
    );
  }
  if (status === 403 || /permission|forbidden|The caller does not have permission/i.test(detail)) {
    return (
      "구글 시트 권한이 없습니다. 시트를 열고 공유에 " +
      "pos-bot@okpos-inventory.iam.gserviceaccount.com 을 편집자로 추가하세요."
    );
  }
  if (/JSON|GOOGLE_SERVICE_ACCOUNT|SHEET_ID|client_email|private_key/i.test(detail)) {
    return detail;
  }
  if (detail && detail.length < 280) return detail;
  return "시트를 열지 못했습니다. Vercel 환경변수와 시트 공유를 확인해 주세요.";
}

export async function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: credentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function cell(row: string[], index: number) {
  return String(row[index] ?? "").trim();
}

function asNumber(value: string) {
  if (!value) return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function monthOf(value: string) {
  const m = String(value || "").match(/(\d{4}-\d{2})/);
  return m ? m[1] : "";
}

function latestMonth(rows: string[][]) {
  let best = "";
  for (const row of rows.slice(1)) {
    const m = monthOf(row[0] || "");
    if (m > best) best = m;
  }
  return best;
}

export async function loadLiveStock() {
  const sheets = await sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: a1(STOCK_SHEET, "A:N"),
  });
  const values = res.data.values || [];
  const month = values.length > 1 ? latestMonth(values) : new Date().toISOString().slice(0, 7);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    if (monthOf(row[0] || "") !== month) continue;
    const code = cell(row, 2);
    const name = cell(row, 3);
    if (!code && !name) continue;
    rows.push({
      row: i + 1,
      code,
      name: name || code,
      category: cell(row, 13),
      unit: cell(row, 12),
      opening: asNumber(cell(row, 4)),
      incoming: asNumber(cell(row, 5)),
      used: asNumber(cell(row, 6)),
      adjustment: asNumber(cell(row, 7)) ?? 0,
      stock: asNumber(cell(row, 8)),
      safety: asNumber(cell(row, 9)),
      display: cell(row, 10),
    });
  }
  rows.sort((a, b) => {
    const aLow = a.safety != null && a.stock != null && a.stock <= a.safety ? 0 : 1;
    const bLow = b.safety != null && b.stock != null && b.stock <= b.safety ? 0 : 1;
    return aLow - bLow || a.category.localeCompare(b.category, "ko") || a.name.localeCompare(b.name, "ko");
  });
  return { month, rows };
}

export async function saveLiveStockCell(
  rowNumber: number,
  kind: "safety" | "adjustment",
  value: string,
) {
  const column = kind === "safety" ? "J" : "H";
  const sheets = await sheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId(),
    range: a1(STOCK_SHEET, `${column}${rowNumber}`),
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
  const shown = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: a1(STOCK_SHEET, `I${rowNumber}:K${rowNumber}`),
  });
  const flat = shown.data.values?.[0] || [];
  return {
    stock: asNumber(String(flat[0] || "")),
    display: String(flat[2] || "").trim(),
    safety: kind === "safety" ? asNumber(value) : undefined,
    adjustment: kind === "adjustment" ? asNumber(value) : undefined,
  };
}

export async function loadInspection() {
  const sheets = await sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: a1(RECEIPT_SHEET, "A:N"),
  });
  const values = res.data.values || [];
  const month = new Date().toISOString().slice(0, 7);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const date = cell(row, 2);
    if (monthOf(date) && monthOf(date) !== month && !date.startsWith(month)) {
      const stamp = cell(row, 0);
      if (!stamp.startsWith(month) && !date.startsWith(month)) continue;
    }
    rows.push({
      row: i + 1,
      date,
      vendor: cell(row, 3),
      name: cell(row, 10) || cell(row, 4),
      spec: cell(row, 5),
      qty: cell(row, 6),
      code: cell(row, 9),
      final: cell(row, 11),
      checked: ["TRUE", "true", "1", "✓", "Y", "y"].includes(cell(row, 12)),
    });
  }
  return { month, rows };
}

export async function saveInspection(changes: { row: number; checked: boolean }[]) {
  if (!changes.length) return "변경 없음";
  const sheets = await sheetsClient();
  const data = changes.map((c) => ({
    range: a1(RECEIPT_SHEET, `M${c.row}`),
    values: [[c.checked]],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });
  return `검수 ${changes.length}건을 시트에 반영했습니다.`;
}
