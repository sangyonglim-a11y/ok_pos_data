/**
 * SPA fetch 용 JSON API.
 * 배포: 웹 앱 > 실행 계정: 나 / 액세스: 모든 사용자
 * 프론트 API_URL 에 배포 URL 을 넣으세요.
 *
 * POST body(JSON, Content-Type: text/plain 권장):
 *   { "action": "inspectionList"|"setInspection"|"setInspectionBulk", "pin": "...", ... }
 *
 * ★ 코드 수정 후 반드시:
 *   배포 → 배포 관리 → 연필(수정) → 버전=새 버전 → 배포
 *   (저장만 하면 Index 화면은 바뀌어도 /exec 서버 코드는 안 바뀝니다)
 */

var API_VERSION = "2026-11-09-j94";

/**
 * Index.html → google.script.run.apiFromClient(...)
 * 배포 URL 이 달라도, 지금 열린 웹앱과 같은 서버 코드를 씁니다.
 */
function apiFromClient(body) {
  try {
    return withVersion_(handleApi_(body || {}));
  } catch (err) {
    return withVersion_({ error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    return json_(withVersion_(handleApi_(body)));
  } catch (err) {
    return json_(withVersion_({ error: String(err && err.message ? err.message : err) }));
  }
}

function doGet(e) {
  // ?api=1&action=inspectionList&pin=... 도 허용
  var p = (e && e.parameter) || {};
  if (String(p.api || "") === "1") {
    try {
      return json_(withVersion_(handleApi_(p)));
    } catch (err) {
      return json_(withVersion_({ error: String(err && err.message ? err.message : err) }));
    }
  }
  // Index.html + Styles.html + AppJs.html (include)
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("중계고기파티 재고")
    .addMetaTag("viewport", "width=device-width, initial-scale=1, viewport-fit=cover")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function withVersion_(obj) {
  if (!obj || typeof obj !== "object") obj = {};
  try {
    if (typeof APP_VERSION !== "undefined" && APP_VERSION) obj.version = String(APP_VERSION);
    else obj.version = API_VERSION;
  } catch (e) {
    obj.version = API_VERSION;
  }
  return obj;
}

function handleApi_(body) {
  var action = String(body.action || "");
  var pin = body.pin;

  // 배포 확인용 (비밀번호 없이 version 확인)
  if (action === "ping" || action === "version") {
    var ver = API_VERSION;
    try {
      if (typeof APP_VERSION !== "undefined" && APP_VERSION) ver = String(APP_VERSION);
    } catch (e) {}
    return { ok: true, version: ver };
  }

  assertPin_(pin);

  if (action === "inspectionList" || action === "login") {
    var list = inspectionList(pin, body.month);
    try {
      list.warnCount = balanceList(pin, body.month || list.month).warnCount || 0;
    } catch (e) {
      list.warnCount = 0;
    }
    return list;
  }
  if (action === "setInspection") {
    return setInspectionOne_(pin, body.row, body.checked, body.month);
  }
  if (action === "setInspectionBulk") {
    var rows = body.rows || [];
    var changes = [];
    for (var i = 0; i < rows.length; i++) {
      changes.push({ row: rows[i], checked: true });
    }
    var message = saveInspection(pin, changes, body.month);
    return { ok: true, count: changes.length, message: message };
  }
  if (action === "applyInspection") {
    var changes2 = body.changes || [];
    var msg = saveInspection(pin, changes2, body.month);
    return { ok: true, count: changes2.length, message: msg };
  }
  if (action === "saveInspectionFields") {
    return saveInspectionFields(pin, body.row, {
      name: body.name,
      spec: body.spec,
      qty: body.qty,
      final: body.final,
      unitPrice: body.unitPrice,
      lineAmount: body.lineAmount
    });
  }
  if (action === "saveInspectionBatch") {
    return saveInspectionBatch(pin, {
      dailyAmount: body.dailyAmount,
      monthAmount: body.monthAmount,
      tradeDate: body.tradeDate,
      vendor: body.vendor,
      prevTradeDate: body.prevTradeDate,
      prevVendor: body.prevVendor,
      rows: body.rows || []
    });
  }
  if (action === "deleteInspectionItems") {
    return deleteInspectionItems(pin, body.rows || body.rowNumbers || []);
  }
  if (action === "stockList") {
    return stockList(pin, body.month, body.day);
  }
  if (action === "saveStock") {
    return saveStock(pin, body.row, body.code, body.kind, body.value);
  }
  if (action === "priceList") {
    return priceList(pin, body.months, body.month);
  }
  // 거래처 금액 검증: 거래처매입누적만 조회 (이미지URL·갱신시각 반정규화, Drive/입고 조인 없음)
  if (action === "balanceList") {
    return balanceList(pin, body.month);
  }
  if (action === "saveBalancePayment") {
    return saveBalancePayment(pin, body.row, body.payment);
  }
  if (action === "jobUpdateReceiptQuantities") {
    return jobUpdateReceiptQuantities(pin, body.month);
  }
  if (action === "jobCalculateInventory") {
    return jobCalculateInventory(pin, body.month);
  }
  if (action === "jobSaveOrderList") {
    return jobSaveOrderList(pin, body.orderItems || body.items || []);
  }
  if (action === "savePendingOrderPatches") {
    return savePendingOrderPatches(pin, body.patches || body.changes || []);
  }
  if (action === "jobMonthlyClose") {
    return jobMonthlyClose(pin);
  }
  if (action === "jobRebuildVendorBalances") {
    return jobRebuildVendorBalances(pin);
  }
  if (action === "jobUnregisteredList") {
    return jobUnregisteredList(pin);
  }
  if (action === "jobRegisterUnregistered") {
    return jobRegisterUnregistered(pin, body);
  }
  if (action === "jobRegisterUnregisteredBatch") {
    return jobRegisterUnregisteredBatch(pin, body);
  }
  if (action === "jobIgnoreUnregistered") {
    return jobIgnoreUnregistered(pin, body);
  }
  if (action === "processReceiptsWithGemini") {
    return processReceiptsWithGemini(body.images || body.base64Images || []);
  }
  if (action === "processOneReceiptWithGemini") {
    return processOneReceiptWithGemini(body.image || body);
  }
  if (action === "jobClearRawMaterialReceipts") {
    return jobClearRawMaterialReceipts(pin);
  }
  if (action === "jobListInboxReceipts") {
    return jobListInboxReceipts(pin);
  }
  if (action === "processOneDriveReceiptWithGemini") {
    return processOneDriveReceiptWithGemini(body.fileId || body.id);
  }
  if (action === "jobBatchOcrFromInbox") {
    return jobBatchOcrFromInbox(pin, body);
  }
  if (action === "getPosSalesData" || action === "posSalesList") {
    return getPosSalesData(pin, body.startDate || body.start, body.endDate || body.end, body.keyword || body.query || "");
  }
  if (
    action === "jobGetPosDashboardData" ||
    action === "getPosDashboardData" ||
    action === "posDashboard"
  ) {
    return jobGetPosDashboardData(pin, body);
  }
  throw new Error("지원하지 않는 action 입니다: " + action);
}

function setInspectionOne_(pin, rowNumber, checked, month) {
  var message = saveInspection(pin, [{ row: rowNumber, checked: !!checked }], month);
  return { ok: true, row: Math.floor(Number(rowNumber)), checked: !!checked, message: message };
}

function vendorWarnCount_() {
  try {
    var list = balanceList(APP_PIN);
    return list.warnCount || 0;
  } catch (e) {
    return 0;
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 일회성 마이그레이션: 공산품 중 M7xxxx → M8xxx
 * Apps Script 편집기에서 migrateManufacturedGoodsToM8() 를 직접 실행하세요.
 * 1) 원재료관리: 구분=공산품 & 코드 M7* → M8001~
 * 2) 원재료입고(M), 원재료_실시간재고(C), 레시피배합표(E) 코드 일괄 치환
 */
function migrateManufacturedGoodsToM8() {
  var catalog = sheet_("원재료관리");
  var values = catalog.getDataRange().getValues();
  var existing = {};
  var maxM8 = 0;
  for (var i = 1; i < values.length; i++) {
    var code = text_(values[i][1]);
    if (!code) continue;
    existing[code] = true;
    if (code.indexOf("M8") === 0) {
      var n8 = parseInt(String(code).slice(2), 10);
      if (!isNaN(n8) && n8 > maxM8) maxM8 = n8;
    }
  }

  var mapping = {}; // oldCode -> newCode
  var seq = maxM8;
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var oldCode = text_(row[1]);
    var category = text_(row[5]);
    if (category !== "공산품") continue;
    if (!oldCode || oldCode.indexOf("M7") !== 0) continue;
    if (mapping[oldCode]) continue;
    seq++;
    var newCode = formatMaterialCode_("M8", seq);
    while (existing[newCode]) {
      seq++;
      newCode = formatMaterialCode_("M8", seq);
    }
    mapping[oldCode] = newCode;
    existing[newCode] = true;
    catalog.getRange(r + 1, 2).setValue(newCode);
  }

  var keys = Object.keys(mapping);
  if (!keys.length) {
    return { ok: true, message: "변경할 공산품 M7 코드가 없습니다.", mapping: {}, counts: {} };
  }

  var counts = {
    catalog: keys.length,
    receipt: replaceCodesInSheetColumn_("원재료입고", 13, mapping), // M열
    inventory: replaceCodesInSheetColumn_("원재료_실시간재고", 3, mapping), // C열
    recipe: replaceCodesInSheetColumn_("레시피배합표", 5, mapping) // E열
  };
  SpreadsheetApp.flush();
  return {
    ok: true,
    message: "공산품 M7→M8 마이그레이션 완료. 원재료관리 " + counts.catalog +
      "건, 입고 " + counts.receipt + "건, 재고 " + counts.inventory +
      "건, 레시피 " + counts.recipe + "건 갱신.",
    mapping: mapping,
    counts: counts,
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : API_VERSION
  };
}

/** sheet 의 1-based column 에서 mapping(old→new) 일괄 치환 */
function replaceCodesInSheetColumn_(sheetName, column1Based, mapping) {
  var sh;
  try {
    sh = sheet_(sheetName);
  } catch (e) {
    return 0;
  }
  var range = sh.getDataRange();
  var values = range.getValues();
  var changed = 0;
  var col = column1Based - 1;
  for (var i = 1; i < values.length; i++) {
    var cur = text_(values[i][col]);
    if (!cur || !mapping[cur]) continue;
    values[i][col] = mapping[cur];
    changed++;
  }
  if (changed) range.setValues(values);
  return changed;
}

/**
 * [1회성] 원재료입고 → 원재료관리 영수증위치·영수증UPTIME 복사.
 * Apps Script 편집기에서 runOneTimeMigration 실행 1회 → 확인 후 이 함수 삭제.
 *
 * 매칭: 원재료관리 품목명(A)·별칭(G) ↔ 원재료입고 영수증품목명(H)·공식명(N)
 * 이미 값이 있는 칸은 덮어쓰지 않음. 매칭 실패 행은 비워 둠.
 */
function runOneTimeMigration() {
  var staging = sheet_("원재료입고").getDataRange().getValues();
  if (!staging.length) {
    Logger.log("원재료입고가 비어 있습니다.");
    return { ok: false, message: "원재료입고 비어 있음", filledUrl: 0, filledUptime: 0, matched: 0 };
  }
  var stHeaders = staging[0].map(function(h) { return String(h || "").trim(); });
  var stUrlCol = stHeaders.indexOf("영수증위치");
  if (stUrlCol < 0) stUrlCol = 19; // 구버전 T열
  var stUpCol = stHeaders.indexOf("영수증UPTIME");
  // 이름키 → { url, uptime } (URL 있는 행만, 뒤에 나온 행이 최신으로 덮음)
  var byName = {};
  var putMeta_ = function(rawName, url, uptime) {
    var key = typeof normalizeUnregNameKey_ === "function"
      ? normalizeUnregNameKey_(rawName)
      : String(rawName || "").replace(/\s+/g, "").toLowerCase();
    if (!key || !url) return;
    byName[key] = { url: url, uptime: uptime || "" };
  };
  for (var s = 1; s < staging.length; s++) {
    var srow = staging[s];
    if (!srow || !String(srow.join("")).trim()) continue;
    var url = stUrlCol >= 0 && srow.length > stUrlCol ? String(srow[stUrlCol] || "").trim() : "";
    if (!url && srow.length > 19) url = String(srow[19] || "").trim();
    if (!url) continue;
    var uptime = "";
    if (stUpCol >= 0 && srow.length > stUpCol) uptime = String(srow[stUpCol] || "").trim();
    if (!uptime && typeof receiptImageStamp_ === "function") {
      uptime = receiptImageStamp_(srow, null);
    }
    if (!uptime && typeof receiptUptimeNow_ === "function") uptime = receiptUptimeNow_();
    putMeta_(srow[7], url, uptime);  // H 영수증 품목명
    putMeta_(srow[13], url, uptime); // N 공식명
  }

  var sheet = sheet_("원재료관리");
  var values = sheet.getDataRange().getValues();
  if (!values.length) {
    return { ok: false, message: "원재료관리 비어 있음", filledUrl: 0, filledUptime: 0, matched: 0 };
  }
  var headers = values[0].map(function(h) { return String(h || "").trim(); });
  var urlCol = headers.indexOf("영수증위치");
  var upCol = headers.indexOf("영수증UPTIME");
  if (urlCol < 0) {
    urlCol = headers.length;
    headers.push("영수증위치");
    for (var a = 1; a < values.length; a++) values[a].push("");
  }
  if (upCol < 0) {
    upCol = headers.length;
    headers.push("영수증UPTIME");
    for (var b = 1; b < values.length; b++) values[b].push("");
  }
  values[0] = headers;

  var filledUrl = 0;
  var filledUptime = 0;
  var matched = 0;
  var unmatched = 0;
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    while (row.length <= Math.max(urlCol, upCol)) row.push("");
    var cname = String(row[0] || "").trim();
    if (!cname) continue;

    var needUrl = !String(row[urlCol] || "").trim();
    var needUp = !String(row[upCol] || "").trim();
    if (!needUrl && !needUp) continue;

    var hit = null;
    var tryKeys = [cname];
    String(row[6] || "").split("|").forEach(function(alias) {
      var a = String(alias || "").trim();
      if (a) tryKeys.push(a);
    });
    for (var k = 0; k < tryKeys.length; k++) {
      var key = typeof normalizeUnregNameKey_ === "function"
        ? normalizeUnregNameKey_(tryKeys[k])
        : String(tryKeys[k] || "").replace(/\s+/g, "").toLowerCase();
      if (key && byName[key]) {
        hit = byName[key];
        break;
      }
    }
    if (!hit) {
      unmatched++;
      continue;
    }
    matched++;
    if (needUrl && hit.url) {
      row[urlCol] = hit.url;
      filledUrl++;
    }
    if (needUp) {
      row[upCol] = hit.uptime || (typeof receiptUptimeNow_ === "function" ? receiptUptimeNow_() : "");
      filledUptime++;
    }
    values[i] = row;
  }

  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  SpreadsheetApp.flush();

  var msg = "입고→관리 복사 완료. 매칭 " + matched + "종 · URL " + filledUrl + " · UPTIME " + filledUptime
    + " · 미매칭(빈칸유지) " + unmatched;
  Logger.log(msg);
  return {
    ok: true,
    message: msg,
    matched: matched,
    unmatched: unmatched,
    filledUrl: filledUrl,
    filledUptime: filledUptime,
    stagingKeys: Object.keys(byName).length
  };
}

