// 핸드폰 웹앱. 구글 시트에 직접 붙어서, 노트북이 꺼져 있어도 열립니다.
// 배포: 확장 프로그램 > Apps Script 에 이 파일과 Index.html 을 넣고
// 배포 > 웹 앱 > 실행: 나, 액세스: 모든 사용자.
// 비밀번호는 아래 APP_PIN 입니다. 배포 전에 바꿔도 됩니다.
var APP_PIN = "9338892";
var SPREADSHEET_ID = "1JY9OGCLp0KlnilDdW3Oyl4vcSogRCMTmQyFsQeA2Gqg";
var CATEGORIES = ["고기", "주류", "하이볼", "식사", "사이드", "음료", "야채", "공산품", "기타"];

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("중계고기파티 재고")
    .addMetaTag("viewport", "width=device-width, initial-scale=1, viewport-fit=cover")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function stockList(pin) {
  assertPin_(pin);
  var sheet = sheet_("원재료_실시간재고");
  var values = sheet.getDataRange().getValues();
  var month = latestMonth_(values);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (textMonth_(row[0]) !== month) continue;
    var code = text_(row[2]);
    var name = text_(row[3]);
    if (!code && !name) continue;
    var safetyText = text_(row[9]);
    rows.push({
      row: i + 1,
      code: code,
      name: name || code,
      category: text_(row[13]),
      unit: text_(row[12]),
      display: text_(row[10]),
      opening: num_(row[4]),
      incoming: num_(row[5]),
      used: num_(row[6]),
      adjustment: num_(row[7]),
      stock: num_(row[8]),
      safety: safetyText === "" ? null : num_(row[9])
    });
  }
  rows.sort(function(a, b) {
    var lowA = below_(a) ? 0 : 1;
    var lowB = below_(b) ? 0 : 1;
    if (lowA !== lowB) return lowA - lowB;
    var orderA = categoryOrder_(a.category);
    var orderB = categoryOrder_(b.category);
    if (orderA !== orderB) return orderA - orderB;
    return String(a.name).localeCompare(String(b.name), "ko");
  });
  return { month: month, rows: rows };
}

function saveStock(pin, rowNumber, code, kind, raw) {
  assertPin_(pin);
  var sheet = sheet_("원재료_실시간재고");
  var row = Math.floor(Number(rowNumber));
  if (!(row >= 2)) throw new Error("행을 찾지 못했습니다.");
  var found = text_(sheet.getRange(row, 3).getValue());
  if (found !== text_(code)) throw new Error("품목이 바뀌었습니다. 다시 불러와 주세요.");
  var column = kind === "safety" ? 10 : kind === "adjustment" ? 8 : 0;
  if (!column) throw new Error("고칠 수 없는 칸입니다.");
  var text = text_(raw).replace(/,/g, "");
  var value = "";
  if (text !== "") {
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error("숫자만 넣을 수 있습니다.");
    value = tidy_(Number(text));
  }
  if (kind === "safety" && value !== "" && value < 0) throw new Error("안전재고는 0 이상으로 입력하세요.");
  if (kind === "adjustment" && value === "") value = 0;
  sheet.getRange(row, column).setValue(value);
  SpreadsheetApp.flush();
  var shown = sheet.getRange(row, 8, 1, 4).getValues()[0];
  var safetyText = text_(shown[2]);
  return {
    adjustment: num_(shown[0]),
    stock: num_(shown[1]),
    safety: safetyText === "" ? null : num_(shown[2]),
    display: text_(shown[3])
  };
}

function inspectionList(pin) {
  assertPin_(pin);
  var inventory = sheet_("원재료_실시간재고").getDataRange().getValues();
  var month = latestMonth_(inventory);
  var values = sheet_("원재료입고").getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row || !row.join("").trim()) continue;
    if (receiptMonth_(row) !== month) continue;
    var official = text_(row[13]);
    var original = text_(row[7]);
    rows.push({
      row: i + 1,
      date: text_(row[2]),
      vendor: text_(row[3]),
      name: official || original,
      spec: text_(row[8]),
      qty: text_(row[9]),
      code: text_(row[12]),
      final: text_(row[14]),
      checked: checked_(row[15]),
      biz: text_(row[4]),
      amount: text_(row[10]),
      imageUrl: ""
    });
  }
  rows.sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.vendor !== b.vendor) return a.vendor < b.vendor ? -1 : 1;
    return a.row - b.row;
  });
  return { month: month, rows: rows };
}

function saveInspection(pin, changes) {
  assertPin_(pin);
  var inventory = sheet_("원재료_실시간재고").getDataRange().getValues();
  var month = latestMonth_(inventory);
  var sheet = sheet_("원재료입고");
  var values = sheet.getDataRange().getValues();
  var list = changes || [];
  var done = 0;
  var waiting = 0;
  var gray = [];
  var white = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var row = Math.floor(Number(item.row));
    if (!(row >= 2) || row > values.length) continue;
    var current = values[row - 1];
    if (receiptMonth_(current) !== month) continue;
    var want = !!item.checked;
    if (want === checked_(current[15])) continue;
    sheet.getRange(row, 16).setValue(want);
    sheet.getRange(row, 17).setValue(want ? "반영완료" : "검수대기");
    sheet.getRange(row, 18).setValue(want ? month : "");
    if (want) {
      gray.push(row);
      done++;
    } else {
      white.push(row);
      waiting++;
    }
  }
  paint_(sheet, gray, "#e0e0e0");
  paint_(sheet, white, "#ffffff");
  if (!done && !waiting) return "바뀐 검수 항목이 없습니다.";
  return "반영완료 " + done + "건, 검수대기로 되돌린 " + waiting + "건을 기록했습니다. 재고 수량은 노트북에서 실시간 재고 계산을 누를 때 합산됩니다.";
}

function assertPin_(pin) {
  if (String(pin || "") !== APP_PIN) throw new Error("비밀번호가 다릅니다.");
}

function sheet_(name) {
  var found = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  if (!found) throw new Error(name + " 시트를 찾지 못했습니다.");
  return found;
}

function latestMonth_(values) {
  var month = "";
  for (var i = 1; i < values.length; i++) {
    var text = textMonth_(values[i][0]);
    if (text && text > month) month = text;
  }
  if (month) return month;
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM");
}

function textMonth_(value) {
  var match = String(value || "").trim().match(/(\d{4})-(\d{2})/);
  return match ? match[1] + "-" + match[2] : "";
}

function receiptMonth_(row) {
  var posted = textMonth_(row[17]);
  if (posted) return posted;
  return textMonth_(row[2]);
}

function checked_(value) {
  if (value === true) return true;
  var text = String(value || "").trim().toUpperCase();
  return text === "TRUE" || text === "1" || text === "YES" || text === "Y";
}

function text_(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function num_(value) {
  if (typeof value === "number") return tidy_(value);
  var text = text_(value).replace(/,/g, "").replace(/원/g, "");
  if (!text) return 0;
  var number = Number(text);
  return isNaN(number) ? 0 : tidy_(number);
}

function tidy_(value) {
  var number = Math.round(Number(value) * 10000) / 10000;
  if (Math.abs(number - Math.round(number)) < 1e-9) return Math.round(number);
  return number;
}

function below_(item) {
  return item.safety !== null && item.safety !== "" && Number(item.stock) <= Number(item.safety);
}

function categoryOrder_(name) {
  var index = CATEGORIES.indexOf(name);
  return index < 0 ? 99 : index;
}

function paint_(sheet, rows, color) {
  for (var i = 0; i < rows.length; i++) {
    sheet.getRange(rows[i], 1, 1, 18).setBackground(color);
  }
}
