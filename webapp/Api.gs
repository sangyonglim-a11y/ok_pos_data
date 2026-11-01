/**
 * SPA fetch 용 JSON API.
 * 배포: 웹 앱 > 실행 계정: 나 / 액세스: 모든 사용자
 * 프론트 API_URL 에 배포 URL 을 넣으세요.
 *
 * POST body(JSON, Content-Type: text/plain 권장):
 *   { "action": "inspectionList"|"setInspection"|"setInspectionBulk", "pin": "...", ... }
 */

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    return json_(handleApi_(body));
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  // ?api=1&action=inspectionList&pin=... 도 허용
  var p = (e && e.parameter) || {};
  if (String(p.api || "") === "1") {
    try {
      return json_(handleApi_(p));
    } catch (err) {
      return json_({ error: String(err && err.message ? err.message : err) });
    }
  }
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("중계고기파티 재고")
    .addMetaTag("viewport", "width=device-width, initial-scale=1, viewport-fit=cover")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleApi_(body) {
  var action = String(body.action || "");
  var pin = body.pin;
  assertPin_(pin);

  if (action === "inspectionList" || action === "login") {
    var list = inspectionList(pin);
    list.warnCount = vendorWarnCount_();
    return list;
  }
  if (action === "setInspection") {
    return setInspectionOne_(pin, body.row, body.checked);
  }
  if (action === "setInspectionBulk") {
    var rows = body.rows || [];
    var changes = [];
    for (var i = 0; i < rows.length; i++) {
      changes.push({ row: rows[i], checked: true });
    }
    var message = saveInspection(pin, changes);
    return { ok: true, count: changes.length, message: message };
  }
  if (action === "applyInspection") {
    var list = body.changes || [];
    var msg = saveInspection(pin, list);
    return { ok: true, count: list.length, message: msg };
  }
  if (action === "stockList") {
    return stockList(pin);
  }
  throw new Error("지원하지 않는 action 입니다: " + action);
}

function setInspectionOne_(pin, rowNumber, checked) {
  var message = saveInspection(pin, [{ row: rowNumber, checked: !!checked }]);
  return { ok: true, row: Math.floor(Number(rowNumber)), checked: !!checked, message: message };
}

function vendorWarnCount_() {
  try {
    var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("거래처매입누적");
    if (!sheet) return 0;
    var values = sheet.getDataRange().getValues();
    var count = 0;
    for (var i = 1; i < values.length; i++) {
      var status = String(values[i][values[i].length - 1] || values[i][7] || "");
      if (status && status !== "OK" && status.indexOf("확인") >= 0) count++;
      else if (status && status !== "OK" && status !== "") count++;
    }
    return count;
  } catch (e) {
    return 0;
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
