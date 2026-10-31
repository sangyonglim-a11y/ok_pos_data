import { google } from "googleapis";

const STOCK_SHEET = "원재료_실시간재고";
const RECEIPT_SHEET = "원재료입고";

function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다.");
  }
  const text = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(text);
}

export function sheetId() {
  const id = process.env.SHEET_ID || "";
  if (!id) throw new Error("SHEET_ID 환경변수가 없습니다.");
  return id;
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
    range: `${STOCK_SHEET}!A:N`,
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
    range: `${STOCK_SHEET}!${column}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
  const shown = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `${STOCK_SHEET}!I${rowNumber}:K${rowNumber}`,
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
    range: `${RECEIPT_SHEET}!A:N`,
  });
  const values = res.data.values || [];
  const month = new Date().toISOString().slice(0, 7);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const date = cell(row, 2);
    if (monthOf(date) && monthOf(date) !== month && !date.startsWith(month)) {
      // 거래일자가 이번 달이 아니면 스킵. 시스템시각(A) 보조
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
    range: `${RECEIPT_SHEET}!M${c.row}`,
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
