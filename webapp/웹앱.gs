// 핸드폰 웹앱. 구글 시트에 직접 붙어서, 노트북이 꺼져 있어도 열립니다.
// 배포: Index.html / Styles.html / AppJs.html + 이 파일들
// 배포 > 웹 앱 > 실행: 나, 액세스: 모든 사용자.
// 비밀번호는 아래 APP_PIN 입니다. 배포 전에 바꿔도 됩니다.
var APP_PIN = "9338892";
var SPREADSHEET_ID = "1JY9OGCLp0KlnilDdW3Oyl4vcSogRCMTmQyFsQeA2Gqg";
var APP_VERSION = "2026-11-14-j138"; // 화면 오른쪽 위에 표시. 고칠 때마다 바꾸세요.
var PROP_BALANCE_REBUILD_AT_ = "balanceRebuildAt";

function setBalanceRebuildAtNow_() {
  var t = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm");
  try {
    PropertiesService.getScriptProperties().setProperty(PROP_BALANCE_REBUILD_AT_, t);
  } catch (eSet) {}
  return t;
}

function getBalanceRebuildAt_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(PROP_BALANCE_REBUILD_AT_) || "";
  } catch (eGet) {
    return "";
  }
}
var CATEGORIES = ["고기", "주류", "하이볼", "식사", "사이드", "음료", "야채", "공산품", "기타"];
/** 구분 → 원재료코드 프리픽스 (5자리: M1xxx … M9xxx) */
var CATEGORY_CODE_PREFIX_ = {
  "고기": "M1",
  "주류": "M2",
  "하이볼": "M3",
  "식사": "M4",
  "사이드": "M5",
  "음료": "M6",
  "야채": "M7",
  "공산품": "M8",
  "기타": "M9"
};

/**
 * 원재료_실시간재고 컬럼 (1-indexed / 0-indexed)
 * A기준월 B업데이트 C코드 D명 E이월 F입고 G사용 H조정입고 I조정로스
 * J안전재고 K현재고 L부족수량 M재고단위 N직관 O입고규격 P구분 Q당일사용량 R평균사용량
 */
var INV_COL = {
  MONTH: 1, UPDATED: 2, CODE: 3, NAME: 4,
  OPENING: 5, INCOMING: 6, USED: 7, ADJ_IN: 8, ADJ_LOSS: 9,
  SAFETY: 10, STOCK: 11, SHORTAGE: 12, UNIT: 13, DISPLAY: 14, SPEC: 15, CATEGORY: 16,
  USED_TODAY: 17, AVG_USED: 18
};
var INV_IDX = {
  MONTH: 0, UPDATED: 1, CODE: 2, NAME: 3,
  OPENING: 4, INCOMING: 5, USED: 6, ADJ_IN: 7, ADJ_LOSS: 8,
  SAFETY: 9, STOCK: 10, SHORTAGE: 11, UNIT: 12, DISPLAY: 13, SPEC: 14, CATEGORY: 15,
  USED_TODAY: 16, AVG_USED: 17
};

/** 부족수량 셀 값: 현재고 <= 안전재고 일 때 (안전−현재고), 아니면 빈칸 */
function calcShortageValue_(stock, safety) {
  if (safety === null || safety === undefined || text_(safety) === "") return "";
  var safe = num_(safety);
  var cur = num_(stock);
  if (!(cur <= safe)) return "";
  return tidy_(safe - cur);
}

// doGet / doPost 는 Api.gs 에만 둡니다. (같은 이름 함수가 두 개면 배포가 깨집니다)
// doGet 은 createTemplateFromFile('Index') 로 Styles/AppJs 를 include 합니다.

/** Index.html 의 <?!= include('파일명'); ?> 에서 사용 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** 부족수량·재고수환산 → 추천발주(Box). 부족≤0 이면 "" */
function calcRecommendOrderBox_(shortage, conversion) {
  var short = Number(shortage);
  if (!(short > 0)) return "";
  var conv = Number(conversion);
  if (!(conv > 0)) conv = 1;
  return Math.ceil(short / conv);
}

/** yyyy-MM-dd 가 month(yyyy-MM) 안이면 그대로, 아니면 그달 말일(또는 1일)로 맞춤 */
function clampDayToMonth_(dayIso, monthYm) {
  var ym = String(monthYm || "").slice(0, 7);
  var day = String(dayIso || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}$/.test(ym)) return day.length === 10 ? day : "";
  var last = lastDayOfMonthIso_(ym) || (ym + "-28");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || textMonth_(day) !== ym) return last;
  if (day > last) return last;
  if (day < ym + "-01") return ym + "-01";
  return day;
}

/**
 * 선택일 기준 재료별 사용량.
 * - pos: 해당일 POS 판매 × 레시피
 * - 평균주기: 해당일 > 마지막입고일이면 일평균사용량, 아니면 0
 */
function usageByDayMap_(master, dayIso) {
  var out = {};
  var day = String(dayIso || "").slice(0, 10);
  if (day.length < 10) return out;

  var salesQty = {};
  try {
    var salesRange = sheet_("pos판매내역").getDataRange();
    var sales = salesRange.getValues();
    var salesDisp = salesRange.getDisplayValues();
    var salesMap = posHeaderMap_(sales[0]);
    var useSalesMap = salesMap.name >= 0 && salesMap.qty >= 0;
    for (var s = 1; s < sales.length; s++) {
      var pos = parsePosSalesRow_(sales[s], salesDisp[s], useSalesMap ? salesMap : null);
      if (!pos) continue;
      var saleDay = String(pos.date || "").trim().slice(0, 10);
      if (saleDay !== day) continue;
      var menu = pos.name;
      var qty = num_(pos.qty);
      if (!(menu && qty > 0)) continue;
      salesQty[menu] = (salesQty[menu] || 0) + qty;
    }
  } catch (eSales) {}

  try {
    var recipe = sheet_("레시피배합표").getDataRange().getValues();
    for (var r = 1; r < recipe.length; r++) {
      if (recipe[r].length < 6) continue;
      var menuName = text_(recipe[r][2]);
      var code = text_(recipe[r][4]);
      var amount = num_(recipe[r][5]);
      if (!code || code === "undefined" || code === "nan") continue;
      var canon = canonicalMaterialCode_(code) || code;
      if (!master[canon] || master[canon].purchaseTiming !== "pos") continue;
      var sold = salesQty[menuName] || 0;
      if (!(sold > 0) || !(amount > 0)) continue;
      out[canon] = (out[canon] || 0) + sold * amount;
    }
  } catch (eRecipe) {}

  try {
    var cycleStats = buildAvgCycleStats_(master, day);
    Object.keys(cycleStats).forEach(function(code) {
      if (!master[code] || master[code].purchaseTiming !== "평균주기") return;
      var stat = cycleStats[code];
      var avgDaily = stat && stat.avgDaily > 0 ? Number(stat.avgDaily) : 0;
      if (!(avgDaily > 0)) {
        out[code] = 0;
        return;
      }
      var lastDate = String(stat.lastDate || "").slice(0, 10);
      out[code] = (!lastDate || day > lastDate) ? tidy_(avgDaily) : 0;
    });
  } catch (eCycle) {}

  Object.keys(out).forEach(function(k) {
    out[k] = tidy_(out[k]);
  });
  return out;
}

/**
 * 재고·발주 목록 — 원재료_실시간재고 + 원재료관리(거래처1·거래처2·재고수환산).
 * day(yyyy-MM-dd) 가 있으면 당일사용량은 그 날짜 기준으로 즉시 산출(시트 Q열 덮어쓰지 않음).
 * 추천발주(Box)=ceil(부족/환산).
 */
function stockList(pin, month, day) {
  assertPin_(pin);
  var sheet = sheet_("원재료_실시간재고");
  var values = sheet.getDataRange().getValues();
  var resolved = resolveMonth_(month, values);
  var month = resolved.month;
  var master = {};
  try {
    master = materialMaster_() || {};
  } catch (eMaster) {
    master = {};
  }
  var dayIso = clampDayToMonth_(day, month);
  if (!dayIso) {
    var todayText = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
    dayIso = clampDayToMonth_(todayText, month);
  }
  var usageDay = {};
  try {
    usageDay = usageByDayMap_(master, dayIso) || {};
  } catch (eUse) {
    usageDay = {};
  }
  var deliveryMap = vendorDeliveryMap_();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (textMonth_(row[INV_IDX.MONTH]) !== month) continue;
    var code = text_(row[INV_IDX.CODE]);
    var name = text_(row[INV_IDX.NAME]);
    if (!code && !name) continue;
    var safetyText = text_(row[INV_IDX.SAFETY]);
    var safetyVal = safetyText === "" ? null : num_(row[INV_IDX.SAFETY]);
    var stockText = text_(row[INV_IDX.STOCK]);
    var stock = stockText === "" ? null : num_(row[INV_IDX.STOCK]);
    var shortageText = text_(row[INV_IDX.SHORTAGE]);
    var shortage = null;
    if (shortageText !== "") {
      var sh = num_(row[INV_IDX.SHORTAGE]);
      if (!isNaN(sh) && sh > 0) shortage = sh;
    }
    var canon = code ? canonicalMaterialCode_(code) : "";
    var info = (canon && master[canon]) || (code && master[code]) || null;
    var conversion = info && info.conversion > 0 ? Number(info.conversion) : 1;
    var vendor1 = info ? text_(info.vendor1 || info.primaryVendor) : "";
    var vendor2 = info ? text_(info.vendor2) : "";
    var primaryVendor = vendor1;
    var defaultDelivery = deliveryMethodForVendor_(primaryVendor, deliveryMap);
    var usedTodayVal = 0;
    if (canon && usageDay[canon] != null) usedTodayVal = usageDay[canon];
    else if (code && usageDay[code] != null) usedTodayVal = usageDay[code];
    rows.push({
      row: i + 1,
      code: code,
      name: name || code,
      category: text_(row[INV_IDX.CATEGORY]),
      unit: text_(row[INV_IDX.UNIT]),
      spec: text_(row[INV_IDX.SPEC]),
      display: text_(row[INV_IDX.DISPLAY]),
      opening: num_(row[INV_IDX.OPENING]),
      incoming: num_(row[INV_IDX.INCOMING]),
      used: num_(row[INV_IDX.USED]),
      usedToday: usedTodayVal,
      avgUsed: row.length > INV_IDX.AVG_USED && text_(row[INV_IDX.AVG_USED]) !== "" ? num_(row[INV_IDX.AVG_USED]) : null,
      adjustmentIn: text_(row[INV_IDX.ADJ_IN]) === "" ? 0 : num_(row[INV_IDX.ADJ_IN]),
      adjustment: text_(row[INV_IDX.ADJ_LOSS]) === "" ? 0 : num_(row[INV_IDX.ADJ_LOSS]),
      stock: stock === null ? 0 : stock,
      safety: safetyVal,
      shortage: shortage,
      conversion: conversion,
      primaryVendor: primaryVendor,
      vendor1: vendor1,
      vendor2: vendor2,
      defaultDeliveryMethod: defaultDelivery,
      recommendOrderBox: calcRecommendOrderBox_(shortage, conversion)
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
  var lowCount = 0;
  for (var j = 0; j < rows.length; j++) if (below_(rows[j])) lowCount++;
  return Object.assign(monthMetaFromResolved_(resolved), {
    rows: rows,
    lowCount: lowCount,
    day: dayIso,
    version: APP_VERSION
  });
}

function saveStock(pin, rowNumber, code, kind, raw) {
  assertPin_(pin);
  var sheet = sheet_("원재료_실시간재고");
  var row = Math.floor(Number(rowNumber));
  if (!(row >= 2)) throw new Error("행을 찾지 못했습니다.");
  var found = text_(sheet.getRange(row, INV_COL.CODE).getValue());
  if (found !== text_(code)) throw new Error("품목이 바뀌었습니다. 다시 불러와 주세요.");
  var column = 0;
  if (kind === "safety") column = INV_COL.SAFETY;
  else if (kind === "adjustment" || kind === "adjustmentLoss") column = INV_COL.ADJ_LOSS;
  else if (kind === "adjustmentIn") column = INV_COL.ADJ_IN;
  if (!column) throw new Error("고칠 수 없는 칸입니다.");
  var text = text_(raw).replace(/,/g, "");
  var value = "";
  if (text !== "") {
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error("숫자만 넣을 수 있습니다.");
    value = tidy_(Number(text));
  }
  if (kind === "safety" && value !== "" && value < 0) throw new Error("안전재고는 0 이상으로 입력하세요.");
  if ((kind === "adjustment" || kind === "adjustmentLoss" || kind === "adjustmentIn") && value === "") value = 0;
  sheet.getRange(row, column).setValue(value);
  var computed = refreshInventoryRowValues_(sheet, row);
  // 안전재고·현재고 변경 시 L열 부족수량도 맞춤 (0 이하면 빈칸)
  var shortageOut = calcShortageValue_(computed.stock, computed.safety);
  sheet.getRange(row, INV_COL.SHORTAGE).setValue(shortageOut);
  SpreadsheetApp.flush();
  return {
    ok: true,
    adjustmentIn: computed.adjustmentIn,
    adjustment: computed.adjustment,
    stock: computed.stock,
    safety: computed.safety,
    display: computed.display,
    shortage: shortageOut === "" ? null : shortageOut,
    version: APP_VERSION,
    message: kind === "safety" ? "안전재고를 저장했습니다." : "조정을 저장했습니다."
  };
}

/** 영수증 이미지 URL / UPTIME 헤더 후보 (통일명 우선, 구명칭 호환) */
var RECEIPT_URL_HEADER_NAMES_ = ["영수증위치", "명세서이미지URL", "이미지URL"];
var RECEIPT_UPTIME_HEADER_NAMES_ = ["영수증UPTIME", "이미지갱신시각", "업데이트시각", "이미지버전"];

function receiptUptimeNow_() {
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyyMMdd_HHmmss");
}

/**
 * 시트 헤더에서 영수증위치·영수증UPTIME 열(0-based)을 찾거나 생성.
 * 구명칭이 있으면 통일명으로 헤더만 교체한다. Drive API 호출 없음.
 */
function ensureReceiptMetaCols_(sheet, preferUrlCol, preferUptimeCol) {
  if (!sheet) return { urlCol: preferUrlCol || 19, uptimeCol: preferUptimeCol || 22 };
  var lastCol = Math.max(sheet.getLastColumn(), preferUrlCol != null ? preferUrlCol + 1 : 20, 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return text_(h); });
  var urlCol = balanceHeaderIndex_(headers, RECEIPT_URL_HEADER_NAMES_, preferUrlCol != null ? preferUrlCol : -1);
  var uptimeCol = balanceHeaderIndex_(headers, RECEIPT_UPTIME_HEADER_NAMES_, preferUptimeCol != null ? preferUptimeCol : -1);
  var dirty = false;
  if (urlCol < 0) {
    urlCol = preferUrlCol != null ? preferUrlCol : Math.max(sheet.getLastColumn(), headers.length);
    sheet.getRange(1, urlCol + 1).setValue("영수증위치");
    dirty = true;
  } else if (headers[urlCol] !== "영수증위치") {
    sheet.getRange(1, urlCol + 1).setValue("영수증위치");
    dirty = true;
  }
  if (uptimeCol < 0) {
    uptimeCol = preferUptimeCol != null
      ? preferUptimeCol
      : Math.max(sheet.getLastColumn(), headers.length, urlCol + 1);
    if (uptimeCol === urlCol) uptimeCol = urlCol + 1;
    sheet.getRange(1, uptimeCol + 1).setValue("영수증UPTIME");
    dirty = true;
  } else if (headers[uptimeCol] !== "영수증UPTIME") {
    sheet.getRange(1, uptimeCol + 1).setValue("영수증UPTIME");
    dirty = true;
  }
  if (dirty) SpreadsheetApp.flush();
  return { urlCol: urlCol, uptimeCol: uptimeCol };
}

/** 헤더 배열 기준 영수증 메타 추출 (Drive API 없음) */
function receiptMetaFromRow_(row, headers, disp) {
  var hdrs = headers || [];
  var urlCol = balanceHeaderIndex_(hdrs, RECEIPT_URL_HEADER_NAMES_, 19);
  var upCol = balanceHeaderIndex_(hdrs, RECEIPT_UPTIME_HEADER_NAMES_, -1);
  var imageUrl = urlCol >= 0 && row && row.length > urlCol ? text_(row[urlCol]) : text_(row && row[19]);
  var imageVer = "";
  if (upCol >= 0 && row && row.length > upCol) imageVer = text_(row[upCol]);
  if (!imageVer && imageUrl) imageVer = receiptImageStamp_(row, disp);
  return { imageUrl: imageUrl || "", imageVer: imageVer || (imageUrl ? "0" : "") };
}

function inspectionList(pin, month) {
  assertPin_(pin);
  var inventory = sheet_("원재료_실시간재고").getDataRange().getValues();
  var resolved = resolveMonth_(month, inventory);
  var month = resolved.month;
  // getDisplayValues: 날짜를 화면에 보이는 "2026-10-24" 로 읽어 검수대기 누락 방지
  var receipt = sheet_("원재료입고");
  var range = receipt.getDataRange();
  var values = range.getValues();
  var displays = range.getDisplayValues();
  var headers = values.length ? values[0].map(function(h) { return text_(h); }) : [];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var disp = displays[i] || [];
    if (!row || !String(row.join("")).trim()) continue;
    if (!belongsToOpenMonth_(row, disp, month)) continue;
    var official = text_(row[13]);
    var original = text_(row[7]);
    // N열이 IGNORE/영구제외 마커면 품목명에 쓰지 않고 H(영수증 품목명) 사용
    var ignoreOfficial = official === "IGNORE" || official === "영구제외";
    var displayName = (!official || ignoreOfficial) ? original : official;
    var meta = receiptMetaFromRow_(row, headers, disp);
    rows.push({
      row: i + 1,
      date: dateText_(disp[2], row[2]),
      vendor: text_(row[3]),
      name: displayName,
      receiptName: original,
      spec: text_(row[8]),
      qty: text_(row[9]),
      code: text_(row[12]),
      final: text_(row[14]),
      checked: checked_(row[15]),
      biz: text_(row[4]),
      // B열 명세서 고유ID · F 전체합계 · G 당월누적 · K 단가 · L 품목합계
      uniqueId: text_(row[1]),
      dailyAmount: text_(row[5]),
      monthAmount: text_(row[6]),
      unitPrice: text_(row[10]),
      lineAmount: text_(row[11]),
      amount: text_(row[11]),
      // 영수증위치 / 영수증UPTIME (시트 반정규화, Drive 없음)
      imageUrl: meta.imageUrl,
      imageVer: meta.imageVer,
      receiptUrl: meta.imageUrl,
      receiptUptime: meta.imageVer
    });
  }
  rows.sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.vendor !== b.vendor) return a.vendor < b.vendor ? -1 : 1;
    var ua = String(a.uniqueId || "");
    var ub = String(b.uniqueId || "");
    if (ua && ub && ua !== ub) return ua < ub ? -1 : 1;
    return a.row - b.row;
  });
  var pendingOrders = [];
  try {
    pendingOrders = listPendingOrders_();
  } catch (ePend) {
    pendingOrders = [];
  }
  var adjustedOrders = [];
  try {
    adjustedOrders = listAdjustedOrders_();
  } catch (eAdj) {
    adjustedOrders = [];
  }
  var vendorOptions = [];
  try {
    vendorOptions = listCatalogVendorNames_();
  } catch (eVend) {
    vendorOptions = [];
  }
  return Object.assign(monthMetaFromResolved_(resolved), {
    rows: rows,
    pendingOrders: pendingOrders,
    adjustedOrders: adjustedOrders,
    vendorOptions: vendorOptions,
    version: APP_VERSION
  });
}

/** 거래처관리 A열 이름 목록 (검수 헤더 콤보용) */
function listCatalogVendorNames_() {
  var out = [];
  var seen = {};
  try {
    var values = sheet_("거래처관리").getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      var name = text_(values[i][0]);
      if (!name || seen[name]) continue;
      seen[name] = true;
      out.push(name);
    }
  } catch (e) {}
  out.sort(function(a, b) {
    return String(a).localeCompare(String(b), "ko");
  });
  return out;
}

/**
 * 거래처·일자 변경 시 거래처매입누적의 결제/조정 키(거래처|날짜) 이전
 * @returns {number} 갱신 행 수
 */
function migrateBalanceVendorDate_(oldVendor, oldDate, newVendor, newDate) {
  var ov = text_(oldVendor);
  var od = text_(oldDate);
  var nv = text_(newVendor);
  var nd = text_(newDate);
  if (!ov || !od || !nv || !nd) return 0;
  if (ov === nv && od === nd) return 0;
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("거래처매입누적");
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var values = sheet.getDataRange().getValues();
  var displays = sheet.getDataRange().getDisplayValues();
  var oldKey = normalizeVendor_(ov);
  var updated = 0;
  for (var i = 1; i < values.length; i++) {
    var vkey = normalizeVendor_(values[i][0]);
    var d = dateText_(displays[i][1], values[i][1]);
    if (vkey !== oldKey) continue;
    if (d !== od && text_(values[i][1]) !== od) continue;
    sheet.getRange(i + 1, 1).setValue(nv);
    sheet.getRange(i + 1, 2).setValue(nd);
    updated++;
  }
  return updated;
}

function saveInspection(pin, changes, month) {
  assertPin_(pin);
  var inventory = sheet_("원재료_실시간재고").getDataRange().getValues();
  var resolved = resolveMonth_(month, inventory);
  var month = resolved.month;
  var sheet = sheet_("원재료입고");
  var values = sheet.getDataRange().getValues();
  var list = changes || [];
  var done = 0;
  var waiting = 0;
  var gray = [];
  var white = [];
  var completedCodes = [];
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
    // R열(18): 검수 완료 시각. 해제 시 비움. (yyyy-MM 추출은 textMonth_ 가 그대로 처리)
    sheet.getRange(row, 18).setValue(
      want ? Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss") : ""
    );
    touchChangedAt_(sheet, row);
    if (want) {
      gray.push(row);
      done++;
      var codeDone = canonicalMaterialCode_(text_(current[12]));
      if (codeDone) completedCodes.push(codeDone);
    } else {
      white.push(row);
      waiting++;
    }
  }
  paint_(sheet, gray, "#e0e0e0");
  paint_(sheet, white, "#ffffff");
  var orderDone = 0;
  if (completedCodes.length) {
    try {
      orderDone = completePendingOrdersByCodes_(completedCodes);
    } catch (eOrd) {
      orderDone = 0;
    }
  }
  if (!done && !waiting) return "바뀐 검수 항목이 없습니다.";
  var msg = "반영완료 " + done + "건, 검수대기로 되돌린 " + waiting + "건을 기록했습니다. 재고 수량은 노트북에서 실시간 재고 계산을 누를 때 합산됩니다.";
  if (orderDone > 0) msg += " 발주내역 " + orderDone + "건을 입고완료로 바꿨습니다.";
  return msg;
}

/**
 * 검수 중 한 행 필드 쓰기 (품명H·공식명N·규격I·수량J·단가K·매입L·반영O)
 */
function writeInspectionRowFields_(sheet, row, fields, updated) {
  updated = updated || {};
  if (fields.receiptName !== undefined && fields.receiptName !== null) {
    var receiptName = text_(fields.receiptName);
    sheet.getRange(row, 8).setValue(receiptName); // H 영수증 품목명
    updated.receiptName = receiptName;
  }
  if (fields.name !== undefined && fields.name !== null) {
    var name = text_(fields.name);
    var official = text_(sheet.getRange(row, 14).getDisplayValue());
    var ignoreOfficial = official === "IGNORE" || official === "영구제외";
    if (ignoreOfficial) {
      // 제외 마커(N)는 유지. 품목명 수정은 H만
      if (fields.receiptName === undefined || fields.receiptName === null) {
        sheet.getRange(row, 8).setValue(name);
        updated.receiptName = name;
      }
    } else if (official) {
      sheet.getRange(row, 14).setValue(name); // N 공식명
      if (fields.receiptName === undefined || fields.receiptName === null) {
        sheet.getRange(row, 8).setValue(name); // 기존 동작: H도 동기
        updated.receiptName = name;
      }
    } else {
      sheet.getRange(row, 8).setValue(name); // 공식명 없으면 H
      updated.receiptName = name;
    }
    updated.name = name;
  }
  if (fields.spec !== undefined && fields.spec !== null) {
    var spec = text_(fields.spec);
    sheet.getRange(row, 9).setValue(spec);
    updated.spec = spec;
  }
  if (fields.qty !== undefined && fields.qty !== null) {
    var qtyRaw = fields.qty;
    var qtyNum = moneyOrNull_(qtyRaw);
    sheet.getRange(row, 10).setValue(qtyNum === null ? text_(qtyRaw) : qtyNum);
    updated.qty = qtyNum === null ? text_(qtyRaw) : String(qtyNum);
  }
  if (fields.unitPrice !== undefined && fields.unitPrice !== null) {
    var upRaw = fields.unitPrice;
    var upNum = moneyOrNull_(upRaw);
    sheet.getRange(row, 11).setValue(upNum === null ? text_(upRaw) : upNum);
    updated.unitPrice = upNum === null ? text_(upRaw) : String(upNum);
  }
  if (fields.lineAmount !== undefined && fields.lineAmount !== null) {
    var laRaw = fields.lineAmount;
    var laNum = moneyOrNull_(laRaw);
    sheet.getRange(row, 12).setValue(laNum === null ? text_(laRaw) : laNum);
    updated.lineAmount = laNum === null ? text_(laRaw) : String(laNum);
    updated.amount = updated.lineAmount;
  }
  if (fields.final !== undefined && fields.final !== null) {
    var finalRaw = fields.final;
    var finalNum = moneyOrNull_(finalRaw);
    sheet.getRange(row, 15).setValue(finalNum === null ? text_(finalRaw) : finalNum);
    updated.final = finalNum === null ? text_(finalRaw) : String(finalNum);
  }
  if (Object.keys(updated).length) touchChangedAt_(sheet, row);
  return updated;
}

/**
 * 검수 중 규격·수량·단가·매입금액 단건 수정
 * body: { row, spec?, qty?, final?, unitPrice?, lineAmount? }
 */
function saveInspectionFields(pin, rowNumber, fields) {
  assertPin_(pin);
  fields = fields || {};
  var sheet = sheet_("원재료입고");
  var row = Math.floor(Number(rowNumber));
  if (!(row >= 2) || row > sheet.getLastRow()) {
    throw new Error("행을 찾지 못했습니다.");
  }
  var updated = writeInspectionRowFields_(sheet, row, fields, {});
  SpreadsheetApp.flush();
  return {
    ok: true,
    row: row,
    fields: updated,
    message: "규격/수량/금액을 저장했습니다.",
    version: APP_VERSION
  };
}

/**
 * 검수 목록에서 선택 행 삭제 (아래에서 위로 deleteRow)
 * body: { rows: [rowNumber, ...] }
 */
function deleteInspectionItems(pin, rowNumbers) {
  assertPin_(pin);
  var sheet = sheet_("원재료입고");
  var last = sheet.getLastRow();
  var seen = {};
  var list = [];
  var raw = rowNumbers || [];
  for (var i = 0; i < raw.length; i++) {
    var row = Math.floor(Number(raw[i]));
    if (!(row >= 2) || row > last) continue;
    if (seen[row]) continue;
    seen[row] = true;
    list.push(row);
  }
  if (!list.length) throw new Error("삭제할 행이 없습니다.");
  list.sort(function(a, b) {
    return b - a;
  });
  for (var d = 0; d < list.length; d++) {
    sheet.deleteRow(list[d]);
  }
  SpreadsheetApp.flush();
  return {
    ok: true,
    count: list.length,
    deleted: list,
    message: list.length + "줄을 삭제했습니다.",
    version: APP_VERSION
  };
}

/**
 * 전표 단위 일괄 저장
 * body: {
 *   rows, dailyAmount?, monthAmount?,
 *   tradeDate?, vendor?, prevTradeDate?, prevVendor?
 * }
 * F합계·G당월누적·C거래일·D거래처는 전표 전 행에 동일 적용. 고유ID(B)는 유지.
 */
function saveInspectionBatch(pin, payload) {
  assertPin_(pin);
  payload = payload || {};
  var sheet = sheet_("원재료입고");
  var last = sheet.getLastRow();
  var list = payload.rows || [];
  if (!list.length) throw new Error("저장할 행이 없습니다.");
  var dailyProvided = payload.dailyAmount !== undefined && payload.dailyAmount !== null;
  var dailyNum = dailyProvided ? moneyOrNull_(payload.dailyAmount) : null;
  var dailyVal = dailyProvided
    ? (dailyNum === null ? text_(payload.dailyAmount) : dailyNum)
    : null;
  var monthProvided = payload.monthAmount !== undefined && payload.monthAmount !== null;
  var monthNum = monthProvided ? moneyOrNull_(payload.monthAmount) : null;
  var monthVal = monthProvided
    ? (monthNum === null ? text_(payload.monthAmount) : monthNum)
    : null;
  var dateProvided = payload.tradeDate !== undefined && payload.tradeDate !== null && text_(payload.tradeDate) !== "";
  var tradeDate = dateProvided ? textMonthDay_(payload.tradeDate) : "";
  if (dateProvided && !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error("거래일 형식이 올바르지 않습니다: " + payload.tradeDate);
  }
  var vendorProvided = payload.vendor !== undefined && payload.vendor !== null && text_(payload.vendor) !== "";
  var vendorName = vendorProvided ? text_(payload.vendor) : "";
  var results = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    var row = Math.floor(Number(item.row));
    if (!(row >= 2) || row > last) {
      throw new Error("행을 찾지 못했습니다: " + item.row);
    }
    var updated = writeInspectionRowFields_(sheet, row, item, {});
    if (dailyProvided) {
      sheet.getRange(row, 6).setValue(dailyVal);
      updated.dailyAmount = dailyNum === null ? text_(payload.dailyAmount) : String(dailyNum);
    }
    if (monthProvided) {
      if (text_(payload.monthAmount) === "") {
        sheet.getRange(row, 7).setValue("");
        updated.monthAmount = "";
      } else {
        sheet.getRange(row, 7).setValue(monthVal);
        updated.monthAmount = monthNum === null ? text_(payload.monthAmount) : String(monthNum);
      }
    }
    if (dateProvided) {
      sheet.getRange(row, 3).setValue(tradeDate); // C 거래일
      updated.date = tradeDate;
    }
    if (vendorProvided) {
      sheet.getRange(row, 4).setValue(vendorName); // D 거래처
      updated.vendor = vendorName;
    }
    results.push({ row: row, fields: updated });
  }
  var migrated = 0;
  if (dateProvided || vendorProvided) {
    var prevDate = text_(payload.prevTradeDate);
    var prevVendor = text_(payload.prevVendor);
    var nextDate = dateProvided ? tradeDate : prevDate;
    var nextVendor = vendorProvided ? vendorName : prevVendor;
    try {
      migrated = migrateBalanceVendorDate_(prevVendor, prevDate, nextVendor, nextDate);
    } catch (eMig) {
      migrated = 0;
    }
  }
  SpreadsheetApp.flush();
  var msg = "전표 " + results.length + "줄을 저장했습니다.";
  if (dateProvided || vendorProvided) {
    msg += "\n거래일·거래처를 바꿨으면 「거래처 금액 검증 → 검증 계산」을 다시 실행하세요.";
    if (migrated > 0) msg += "\n매입누적 결제키 " + migrated + "건을 이전했습니다.";
  }
  return {
    ok: true,
    count: results.length,
    rows: results,
    dailyAmount: dailyProvided
      ? (dailyNum === null ? text_(payload.dailyAmount) : String(dailyNum))
      : null,
    monthAmount: monthProvided
      ? (text_(payload.monthAmount) === ""
          ? ""
          : (monthNum === null ? text_(payload.monthAmount) : String(monthNum)))
      : null,
    tradeDate: dateProvided ? tradeDate : null,
    vendor: vendorProvided ? vendorName : null,
    balanceMigrated: migrated,
    message: msg,
    version: APP_VERSION
  };
}

/** yyyy-MM-dd 로 정규화 (이미 날짜면 그대로) */
function textMonthDay_(value) {
  var t = text_(value);
  var m = t.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
  }
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, "Asia/Seoul", "yyyy-MM-dd");
  }
  return t;
}

function assertPin_(pin) {
  if (String(pin || "") !== APP_PIN) throw new Error("비밀번호가 다릅니다.");
}

function sheet_(name) {
  var found = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  if (!found) throw new Error(name + " 시트를 찾지 못했습니다.");
  return found;
}

var ORDER_HISTORY_HEADERS_ = [
  "발주일자",
  "원재료코드",
  "품목명",
  "거래처",
  "발주수량(Box)",
  "상태",
  "입고예정일",
  "배송방법",
  "메모"
];

/** 발주 상태 허용값 (지연은 화면 표시만 — 시트에 쓰지 않음) */
var ORDER_STATUS_WAITING_ = "대기";
var ORDER_STATUS_DONE_ = "입고완료";
var ORDER_STATUS_ADJUSTED_ = "조정완료";

/** 배송방법 정규화. 허용: 마트구매|거래처배송|택배 */
function normalizeDeliveryMethod_(raw) {
  var t = text_(raw);
  if (t === "마트구매" || t === "거래처배송" || t === "택배") return t;
  if (/마트/.test(t)) return "마트구매";
  if (/택배|퀵|우편/.test(t)) return "택배";
  if (/배송|거래처/.test(t)) return "거래처배송";
  return "";
}

/** 달력일 +N → yyyy-MM-dd (Asia/Seoul) */
function addCalendarDaysText_(yyyyMmDd, days) {
  var base = text_(yyyyMmDd);
  var m = base.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  var d;
  if (m) {
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    d = new Date();
  }
  d.setDate(d.getDate() + (Number(days) || 0));
  return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd");
}

/** 배송방법 → 기본 입고예정일 (달력일 +1 / 택배 +2) */
function defaultExpectedDate_(orderDate, deliveryMethod) {
  var method = normalizeDeliveryMethod_(deliveryMethod) || "거래처배송";
  var add = method === "택배" ? 2 : 1;
  return addCalendarDaysText_(orderDate, add);
}

/** 거래처관리: 거래처명 → 배송방법 */
function vendorDeliveryMap_() {
  var map = {};
  try {
    var sheet = sheet_("거래처관리");
    var values = sheet.getDataRange().getValues();
    if (!values.length) return map;
    var headers = values[0];
    var nameCol = 0;
    var methodCol = -1;
    for (var h = 0; h < headers.length; h++) {
      var ht = text_(headers[h]);
      if (ht === "거래처" || ht === "거래처명" || ht === "업체명") nameCol = h;
      if (ht === "배송방법") methodCol = h;
    }
    if (methodCol < 0) return map;
    for (var i = 1; i < values.length; i++) {
      var name = text_(values[i][nameCol]);
      if (!name) continue;
      var method = normalizeDeliveryMethod_(values[i][methodCol]);
      if (!method) continue;
      map[normalizeVendor_(name)] = method;
      map[name] = method;
    }
  } catch (eMap) {}
  return map;
}

function deliveryMethodForVendor_(vendorName, deliveryMap) {
  var name = text_(vendorName);
  if (!name) return "거래처배송";
  var map = deliveryMap || {};
  var hit =
    map[normalizeVendor_(name)] ||
    map[name] ||
    "";
  return normalizeDeliveryMethod_(hit) || "거래처배송";
}

/** 발주내역 시트 확보. 헤더 마이그레이션(주거래처→거래처, 예정일·배송 추가) */
function ensureOrderHistorySheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName("발주내역");
  if (!sheet) {
    sheet = ss.insertSheet("발주내역");
    sheet.appendRow(ORDER_HISTORY_HEADERS_);
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (sheet.getLastRow() < 1) {
    sheet.appendRow(ORDER_HISTORY_HEADERS_);
    sheet.setFrozenRows(1);
    return sheet;
  }
  ensureOrderHistoryHeaders_(sheet);
  return sheet;
}

function orderHistoryHeaderPresent_(have, want) {
  if (have[want]) return true;
  // 시트에 "발주수량"만 있어도 "발주수량(Box)" 요구를 충족
  if (want === "발주수량(Box)" && (have["발주수량"] || have["발주수량(Box)"])) return true;
  if (want === "거래처" && (have["거래처"] || have["주거래처"])) return true;
  if (want === "입고예정일" && (have["입고예정일"] || have["예정일"])) return true;
  if (want === "메모" && have["메모"]) return true;
  return false;
}

function ensureOrderHistoryHeaders_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var changed = false;
  for (var i = 0; i < headers.length; i++) {
    if (text_(headers[i]) === "주거래처") {
      sheet.getRange(1, i + 1).setValue("거래처");
      headers[i] = "거래처";
      changed = true;
    }
  }
  var have = {};
  for (var j = 0; j < headers.length; j++) {
    var ht = text_(headers[j]);
    if (ht) have[ht] = true;
  }
  var toAdd = [];
  for (var k = 0; k < ORDER_HISTORY_HEADERS_.length; k++) {
    var want = ORDER_HISTORY_HEADERS_[k];
    if (!orderHistoryHeaderPresent_(have, want)) toAdd.push(want);
  }
  if (toAdd.length) {
    var startCol = headers.length + 1;
    // Sheet.getRange(row, column, numRows, numColumns) — 4번째는 열 개수
    sheet.getRange(1, startCol, 1, toAdd.length).setValues([toAdd]);
    changed = true;
  }
  if (changed) sheet.setFrozenRows(1);
  return changed;
}

/**
 * 발주 확정 → 발주내역 탭에 대기 행 추가
 * orderItems: [{ code, name, vendor|primaryVendor, qtyBox|qty, deliveryMethod, expectedDate }, ...]
 */
function jobSaveOrderList(pin, orderItems) {
  assertPin_(pin);
  var list = orderItems || [];
  if (!list.length) throw new Error("저장할 발주 품목이 없습니다.");
  var sheet = ensureOrderHistorySheet_();
  var lastCol = Math.max(sheet.getLastColumn(), ORDER_HISTORY_HEADERS_.length);
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var col = orderHistoryColMap_(headerRow.map(function(h) { return text_(h); }));
  var maxIdx = Math.max(
    col.date,
    col.code,
    col.name,
    col.vendor,
    col.qty,
    col.status,
    col.expected >= 0 ? col.expected : 0,
    col.delivery >= 0 ? col.delivery : 0
  );
  var width = Math.max(headerRow.length, maxIdx + 1);
  var today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  var deliveryMap = vendorDeliveryMap_();
  var rows = [];
  for (var i = 0; i < list.length; i++) {
    var it = list[i] || {};
    var qtyRaw = it.qtyBox != null ? it.qtyBox : it.qty;
    var qty = Number(qtyRaw);
    if (!(qty > 0)) continue;
    var vendor = text_(it.vendor || it.primaryVendor) || "거래처 미지정";
    var method =
      normalizeDeliveryMethod_(it.deliveryMethod) ||
      deliveryMethodForVendor_(vendor, deliveryMap);
    var expected = text_(it.expectedDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expected)) {
      expected = defaultExpectedDate_(today, method);
    }
    var row = [];
    for (var c = 0; c < width; c++) row.push("");
    row[col.date] = today;
    row[col.code] = text_(it.code);
    row[col.name] = text_(it.name);
    row[col.vendor] = vendor;
    row[col.qty] = Math.round(qty);
    row[col.status] = "대기";
    if (col.expected >= 0) row[col.expected] = expected;
    if (col.delivery >= 0) row[col.delivery] = method;
    rows.push(row);
  }
  if (!rows.length) throw new Error("유효한 발주 수량이 없습니다.");
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, width).setValues(rows);
  SpreadsheetApp.flush();
  return {
    ok: true,
    count: rows.length,
    message: "발주 내역이 성공적으로 저장되었습니다. (" + rows.length + "건 · 발주내역 " + startRow + "행~)",
    version: APP_VERSION
  };
}

/** 발주내역 헤더 → 열 인덱스(0-based) */
function orderHistoryColMap_(headers) {
  var map = {
    date: 0,
    code: 1,
    name: 2,
    vendor: 3,
    qty: 4,
    status: 5,
    expected: 6,
    delivery: 7,
    memo: 8
  };
  if (!headers || !headers.length) return map;
  map.expected = -1;
  map.delivery = -1;
  map.memo = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = text_(headers[i]);
    if (h === "발주일자" || h === "날짜") map.date = i;
    else if (h === "원재료코드" || h === "코드") map.code = i;
    else if (h === "품목명") map.name = i;
    else if (h === "거래처" || h === "주거래처") map.vendor = i;
    else if (h === "발주수량(Box)" || h === "발주수량") map.qty = i;
    else if (h === "상태") map.status = i;
    else if (h === "입고예정일" || h === "예정일") map.expected = i;
    else if (h === "배송방법") map.delivery = i;
    else if (h === "메모" || h === "비고") map.memo = i;
  }
  return map;
}

function normalizeOrderStatus_(raw) {
  var t = text_(raw);
  if (t === ORDER_STATUS_WAITING_ || t === ORDER_STATUS_DONE_ || t === ORDER_STATUS_ADJUSTED_) return t;
  if (t === "지연") return ORDER_STATUS_WAITING_; // 화면용 → 시트는 대기
  return "";
}

/** 상태=대기 인 발주내역 목록 (시트 없으면 []) */
function listPendingOrders_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName("발주내역");
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var displays = sheet.getDataRange().getDisplayValues();
  var headers = values[0].map(function(h) { return text_(h); });
  var col = orderHistoryColMap_(headers);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var disp = displays[i] || [];
    if (!row || !String(row.join("")).trim()) continue;
    var status = normalizeOrderStatus_(row[col.status]) || text_(row[col.status]);
    if (status !== ORDER_STATUS_WAITING_) continue;
    var code = text_(row[col.code]);
    var qty = num_(row[col.qty]);
    if (!(qty > 0) && text_(row[col.qty]) !== "") {
      qty = Number(text_(row[col.qty]).replace(/,/g, ""));
    }
    var expected = "";
    if (col.expected >= 0) {
      expected = dateText_(disp[col.expected], row[col.expected]) || text_(row[col.expected]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expected)) expected = textMonthDay_(row[col.expected]) || text_(disp[col.expected]);
    }
    var orderDate = dateText_(disp[col.date], row[col.date]) || text_(row[col.date]);
    out.push({
      sheetRow: i + 1,
      orderDate: orderDate,
      code: code,
      name: text_(row[col.name]),
      vendor: text_(row[col.vendor]),
      qtyBox: qty > 0 ? qty : 0,
      status: status,
      expectedDate: expected,
      deliveryMethod: col.delivery >= 0 ? text_(row[col.delivery]) : "",
      memo: col.memo >= 0 ? text_(row[col.memo]) : ""
    });
  }
  return out;
}

/**
 * 발주내역 대기 행 상태·메모 저장
 * patches: [{ sheetRow, status?, memo? }, ...]
 * status: 대기 | 조정완료 (입고완료는 검수 적용 전용)
 */
function savePendingOrderPatches(pin, patches) {
  assertPin_(pin);
  var list = patches || [];
  if (!list.length) throw new Error("저장할 발주 변경이 없습니다.");
  var sheet = ensureOrderHistorySheet_();
  var lastCol = Math.max(sheet.getLastColumn(), ORDER_HISTORY_HEADERS_.length);
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var col = orderHistoryColMap_(headerRow.map(function(h) { return text_(h); }));
  if (col.memo < 0) {
    sheet.getRange(1, lastCol + 1).setValue("메모");
    col.memo = lastCol;
    lastCol = lastCol + 1;
  }
  var values = sheet.getDataRange().getValues();
  var saved = 0;
  for (var i = 0; i < list.length; i++) {
    var p = list[i] || {};
    var rowNum = Math.floor(Number(p.sheetRow));
    if (!(rowNum >= 2) || rowNum > values.length) continue;
    var curStatus = normalizeOrderStatus_(values[rowNum - 1][col.status]) || text_(values[rowNum - 1][col.status]);
    if (curStatus !== ORDER_STATUS_WAITING_ && curStatus !== ORDER_STATUS_ADJUSTED_) {
      throw new Error(rowNum + "행은 대기/조정완료만 수정할 수 있습니다 (현재: " + curStatus + ")");
    }
    var nextStatus = p.status !== undefined && p.status !== null && text_(p.status) !== ""
      ? normalizeOrderStatus_(p.status)
      : curStatus;
    if (!nextStatus || (nextStatus !== ORDER_STATUS_WAITING_ && nextStatus !== ORDER_STATUS_ADJUSTED_)) {
      throw new Error("상태는 대기 또는 조정완료만 선택할 수 있습니다.");
    }
    var nextMemo = p.memo !== undefined && p.memo !== null ? text_(p.memo) : text_(values[rowNum - 1][col.memo]);
    if (nextStatus === ORDER_STATUS_ADJUSTED_ && !nextMemo) {
      throw new Error(rowNum + "행 조정완료는 메모가 필요합니다.");
    }
    sheet.getRange(rowNum, col.status + 1).setValue(nextStatus);
    if (col.memo >= 0) sheet.getRange(rowNum, col.memo + 1).setValue(nextMemo);
    saved++;
  }
  if (!saved) throw new Error("바뀐 발주 행이 없습니다.");
  SpreadsheetApp.flush();
  return {
    ok: true,
    count: saved,
    pendingOrders: listPendingOrders_(),
    adjustedOrders: listAdjustedOrders_(),
    message: "발주 " + saved + "건을 저장했습니다.",
    version: APP_VERSION
  };
}

/** 상태=조정완료 인 발주내역 (검수 뱃지·적용 가드용) */
function listAdjustedOrders_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName("발주내역");
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return text_(h); });
  var col = orderHistoryColMap_(headers);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row || !String(row.join("")).trim()) continue;
    var status = normalizeOrderStatus_(row[col.status]) || text_(row[col.status]);
    if (status !== ORDER_STATUS_ADJUSTED_) continue;
    var code = text_(row[col.code]);
    var qty = num_(row[col.qty]);
    out.push({
      sheetRow: i + 1,
      orderDate: text_(row[col.date]),
      code: code,
      name: text_(row[col.name]),
      vendor: text_(row[col.vendor]),
      qtyBox: qty > 0 ? qty : 0,
      status: status,
      memo: col.memo >= 0 ? text_(row[col.memo]) : ""
    });
  }
  return out;
}

/**
 * 검수 반영 완료된 원재료코드 → 발주내역 대기 행을 입고완료로 변경
 * @returns {number} 갱신 건수
 */
function completePendingOrdersByCodes_(codes) {
  var want = {};
  var list = codes || [];
  for (var i = 0; i < list.length; i++) {
    var c = canonicalMaterialCode_(text_(list[i]));
    if (c) want[c] = true;
  }
  if (!Object.keys(want).length) return 0;
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName("발주내역");
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return text_(h); });
  var col = orderHistoryColMap_(headers);
  var updated = 0;
  for (var r = 1; r < values.length; r++) {
    var status = text_(values[r][col.status]);
    if (status !== "대기") continue;
    var code = canonicalMaterialCode_(text_(values[r][col.code]));
    if (!code || !want[code]) continue;
    sheet.getRange(r + 1, col.status + 1).setValue("입고완료");
    updated++;
  }
  if (updated) SpreadsheetApp.flush();
  return updated;
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

/** 원재료_실시간재고 A열 기준월 목록 (오름차순). 데이터 없으면 [] */
function listInventoryMonths_(values) {
  var seen = {};
  var list = [];
  for (var i = 1; i < (values || []).length; i++) {
    var text = textMonth_(values[i][INV_IDX.MONTH]);
    if (!text || seen[text]) continue;
    seen[text] = true;
    list.push(text);
  }
  list.sort();
  return list;
}

/** 원재료입고 거래일 기준 월 목록 */
function listReceiptMonths_() {
  var seen = {};
  var list = [];
  try {
    var sheet = sheet_("원재료입고");
    var range = sheet.getDataRange();
    var values = range.getValues();
    var displays = range.getDisplayValues();
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var disp = displays[i] || [];
      if (!row || !String(row.join("")).trim()) continue;
      var m = receiptMonth_(row) || textMonth_(dateText_(disp[2], row[2]));
      if (!m || seen[m]) continue;
      seen[m] = true;
      list.push(m);
    }
  } catch (eRec) {}
  list.sort();
  return list;
}

/**
 * 선택 가능 월 = 재고월 ∪ 입고거래월 ∪ 오늘(달력월)
 * 월마감 전에도 다음달 입고검수가 가능하도록 확장
 */
function listSelectableMonths_(invValues) {
  var seen = {};
  var list = [];
  function add_(m) {
    if (!m || seen[m]) return;
    seen[m] = true;
    list.push(m);
  }
  var inv = listInventoryMonths_(invValues);
  for (var i = 0; i < inv.length; i++) add_(inv[i]);
  var rec = listReceiptMonths_();
  for (var j = 0; j < rec.length; j++) add_(rec[j]);
  add_(Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM"));
  list.sort();
  return list;
}

function monthInList_(months, month) {
  for (var i = 0; i < (months || []).length; i++) {
    if (months[i] === month) return true;
  }
  return false;
}

/** 매월 5일~ : 재고 열린달 < 달력월 이면 전월 마감 독촉 (차단 아님) */
function closeNagFromLatest_(latestMonth) {
  var day = Number(Utilities.formatDate(new Date(), "Asia/Seoul", "d"));
  var calMonth = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM");
  var latest = textMonth_(latestMonth) || text_(latestMonth);
  var nag = day >= 5 && latest && latest < calMonth;
  var msg = "";
  if (nag) {
    msg =
      Utilities.formatDate(new Date(), "Asia/Seoul", "M/d") +
      "인데 재고 열린달이 " +
      latest +
      "입니다. 전월 월마감을 진행해 주세요.";
  }
  return { closeNag: !!nag, closeNagMessage: msg, calendarMonth: calMonth };
}

function monthMetaFromResolved_(resolved) {
  var nag = closeNagFromLatest_(resolved.latestMonth);
  return {
    month: resolved.month,
    latestMonth: resolved.latestMonth,
    months: resolved.months,
    inventoryMonths: resolved.inventoryMonths || [],
    hasInventoryMonth: !!resolved.hasInventoryMonth,
    isLatest: !!resolved.isLatest,
    closeNag: nag.closeNag,
    closeNagMessage: nag.closeNagMessage,
    calendarMonth: nag.calendarMonth
  };
}

/**
 * 요청 기준월 해석.
 * - 목록: 재고∪입고∪오늘
 * - 빈값: 오늘(달력)이 목록에 있으면 오늘, 아니면 재고 최신월
 * - latestMonth / isLatest: 재고 시트의 열린(최신) 달 기준
 */
function resolveMonth_(requested, values) {
  var inventoryMonths = listInventoryMonths_(values);
  var months = listSelectableMonths_(values);
  var latest = latestMonth_(values);
  var today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM");
  var raw = text_(requested);
  var month;
  if (!raw) {
    month = monthInList_(months, today) ? today : latest;
  } else {
    month = textMonth_(raw) || raw;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new Error("기준월 형식이 올바르지 않습니다: " + raw);
    }
    if (!monthInList_(months, month)) {
      throw new Error("기준월을 찾을 수 없습니다: " + month);
    }
  }
  var hasInventory = monthInList_(inventoryMonths, month);
  return {
    month: month,
    latestMonth: latest,
    months: months,
    inventoryMonths: inventoryMonths,
    hasInventoryMonth: hasInventory,
    isLatest: month === latest
  };
}

/** yyyy-MM → { start: yyyy-MM-01, end: yyyy-MM-말일 } */
function monthDayBounds_(month) {
  var m = textMonth_(month) || text_(month);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error("기준월 형식이 올바르지 않습니다: " + month);
  var parts = m.split("-");
  var y = Number(parts[0]);
  var mo = Number(parts[1]);
  var last = new Date(y, mo, 0);
  return {
    start: m + "-01",
    end: Utilities.formatDate(last, "Asia/Seoul", "yyyy-MM-dd")
  };
}

function isDate_(value) {
  if (value === null || value === undefined) return false;
  if (Object.prototype.toString.call(value) === "[object Date]") return !isNaN(value.getTime());
  // Apps Script 시트 Date 변형 대비
  return typeof value === "object" && typeof value.getFullYear === "function" && typeof value.getMonth === "function";
}

function asDate_(value) {
  if (isDate_(value)) {
    try {
      var t = typeof value.getTime === "function" ? value.getTime() : NaN;
      if (isNaN(t)) return null;
      return new Date(t);
    } catch (e0) {
      return null;
    }
  }
  // ISO 문자열(yyyy-MM-dd 또는 뒤에 공백/T 시각만). 
  // 명세서 고유ID(2026-11-11_거래처_…)는 날짜로 취급하면 안 됨 → 전표 그룹이 하루로 합쳐짐
  var text = String(value == null ? "" : value).trim();
  var iso = text.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:$|[\sT].*)/);
  if (iso) {
    var y = Number(iso[1]);
    var m = Number(iso[2]);
    var d = Number(iso[3]);
    if (y > 0 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d);
    }
  }
  return null;
}

function textMonth_(value) {
  var d = asDate_(value);
  if (d) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM");
  var text = String(value || "").trim();
  var iso = text.replace(/\./g, "-").replace(/\//g, "-").match(/(\d{4})\s*-\s*(\d{1,2})/);
  if (iso) {
    var mm = String(iso[2]);
    if (mm.length === 1) mm = "0" + mm;
    return iso[1] + "-" + mm;
  }
  // "Sat Oct 24 2026 00:00:00 GMT+0900" 형태
  var eng = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})\b/i);
  if (eng) {
    var map = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    var m = map[String(eng[1]).toLowerCase()];
    if (m) return eng[3] + "-" + m;
  }
  return "";
}

function dateText_(display, raw) {
  var shown = String(display || "").trim();
  var iso = shown.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (iso) {
    var mm = iso[2].length === 1 ? "0" + iso[2] : iso[2];
    var dd = iso[3].length === 1 ? "0" + iso[3] : iso[3];
    return iso[1] + "-" + mm + "-" + dd;
  }
  var d = asDate_(raw);
  if (d) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd");
  var monthDay = textMonth_(raw) || textMonth_(shown);
  if (monthDay && iso) return monthDay + "-" + (iso[3].length === 1 ? "0" + iso[3] : iso[3]);
  return shown || text_(raw);
}

// 반영월이 이번 달이거나, 거래일(표시값/원본)이 이번 달이면 포함 — 검수대기 포함
function belongsToOpenMonth_(row, disp, month) {
  var posted = textMonth_(disp && disp[17] !== undefined ? disp[17] : row[17]) || textMonth_(row[17]);
  if (posted === month) return true;
  var byDisplay = textMonth_(disp && disp[2] !== undefined ? disp[2] : "");
  if (byDisplay === month) return true;
  if (textMonth_(row[2]) === month) return true;
  if (textMonth_(dateText_(disp && disp[2], row[2])) === month) return true;
  return false;
}

function receiptMonth_(row) {
  // 검수일시(R)보다 거래일(C)을 우선 — R에 yyyy-MM-dd HH:mm:ss 를 넣어도 열린 달 판별이 깨지지 않음
  var byTrade = textMonth_(row[2]) || textMonth_(text_(row[2]));
  if (byTrade) return byTrade;
  return textMonth_(row[17]);
}

function checked_(value) {
  if (value === true) return true;
  var text = String(value || "").trim().toUpperCase();
  return text === "TRUE" || text === "1" || text === "YES" || text === "Y";
}

function text_(value) {
  if (value === null || value === undefined) return "";
  var d = asDate_(value);
  if (d) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd");
  return String(value).trim();
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

function moneyOrNull_(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return isNaN(value) ? null : tidy_(value);
  var text = String(value).replace(/,/g, "").replace(/원/g, "").replace(/\s+/g, "").trim();
  if (!text) return null;
  // 손글씨 관행: "14—" "32-" "69～" = 천 단위 줄임(×1000). 예: 상추 14— → 14000
  var shorthand = text.match(/^(-?\d{1,3}(?:\.\d+)?)[—–\-ㅡ~∼―_]+$/);
  if (shorthand) {
    var base = Number(shorthand[1]);
    if (!isNaN(base)) return tidy_(base * 1000);
  }
  var number = Number(text);
  return isNaN(number) ? null : tidy_(number);
}

function balanceHeaderIndex_(headers, names, fallback) {
  for (var i = 0; i < names.length; i++) {
    var want = text_(names[i]);
    for (var h = 0; h < headers.length; h++) {
      if (text_(headers[h]) === want) return h;
    }
  }
  return fallback;
}

/**
 * 거래처 금액 검증 목록 — 거래처매입누적만 단일 조회 (입고 조인·Drive API 없음)
 * 이미지URL/갱신시각은 시트에 반정규화되어 있음
 */
function balanceList(pin, month) {
  assertPin_(pin);
  var invValues = [];
  try {
    invValues = sheet_("원재료_실시간재고").getDataRange().getValues();
  } catch (eInv) {
    invValues = [];
  }
  var resolved = resolveMonth_(month, invValues);
  var openMonth = resolved.month;
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("거래처매입누적");
  if (!sheet) {
    return Object.assign(monthMetaFromResolved_(resolved), {
      rows: [],
      warnCount: 0,
      balanceRebuildAt: getBalanceRebuildAt_(),
      version: APP_VERSION
    });
  }
  var range = sheet.getDataRange();
  var values = range.getValues();
  var displays = range.getDisplayValues();
  if (!values.length) {
    return Object.assign(monthMetaFromResolved_(resolved), {
      rows: [],
      warnCount: 0,
      balanceRebuildAt: getBalanceRebuildAt_(),
      version: APP_VERSION
    });
  }
  var headers = [];
  for (var h = 0; h < values[0].length; h++) headers.push(text_(values[0][h]));
  var dailyIndex = balanceHeaderIndex_(headers, ["영수증합계금액", "당일금액", "명세서금액"], 2);
  var recoveryIndex = balanceHeaderIndex_(headers, ["회수합계", "회수금", "보증금"], 3);
  var paymentIndex = balanceHeaderIndex_(headers, ["중간결제", "결제/조정", "입금", "수금"], 4);
  var monthIndex = balanceHeaderIndex_(headers, ["당월누적금액", "명세서누적금액"], 5);
  var checkIndex = balanceHeaderIndex_(headers, ["검증누계금액", "당월누적계산"], 6);
  var statusIndex = balanceHeaderIndex_(headers, ["검증"], 7);
  var imageUrlIndex = balanceHeaderIndex_(headers, RECEIPT_URL_HEADER_NAMES_, 8);
  var imageVerIndex = balanceHeaderIndex_(headers, RECEIPT_UPTIME_HEADER_NAMES_, 9);
  // 구형 시트(회수합계 열 없음): 중간결제가 3열
  if (recoveryIndex < 0 || text_(headers[recoveryIndex]) === "중간결제" || text_(headers[recoveryIndex]) === "수금") {
    recoveryIndex = -1;
    paymentIndex = balanceHeaderIndex_(headers, ["중간결제", "결제/조정", "입금", "수금"], 3);
    monthIndex = balanceHeaderIndex_(headers, ["당월누적금액", "명세서누적금액"], 4);
    checkIndex = balanceHeaderIndex_(headers, ["검증누계금액", "당월누적계산"], 5);
    statusIndex = balanceHeaderIndex_(headers, ["검증"], 6);
    imageUrlIndex = balanceHeaderIndex_(headers, RECEIPT_URL_HEADER_NAMES_, 7);
    imageVerIndex = balanceHeaderIndex_(headers, RECEIPT_UPTIME_HEADER_NAMES_, 8);
  }
  var rows = [];
  var warnCount = 0;
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var disp = displays[i] || [];
    if (!row || !text_(row[0])) continue;
    var dateStr = dateText_(disp[1], row[1]);
    var rowMonth = textMonth_(dateStr) || textMonth_(row[1]) || textMonth_(disp[1]);
    if (rowMonth !== openMonth) continue;
    var status = text_(row[statusIndex]);
    if (status !== "OK") warnCount++;
    var imageUrl = imageUrlIndex >= 0 && row.length > imageUrlIndex ? text_(row[imageUrlIndex]) : "";
    var imageVer = imageVerIndex >= 0 && row.length > imageVerIndex ? text_(row[imageVerIndex]) : "";
    rows.push({
      row: i + 1,
      vendor: text_(row[0]),
      date: dateStr,
      daily: moneyOrNull_(row[dailyIndex]),
      recovery: recoveryIndex >= 0 ? moneyOrNull_(row[recoveryIndex]) : null,
      payment: moneyOrNull_(row[paymentIndex]),
      month: moneyOrNull_(row[monthIndex]),
      checkTotal: moneyOrNull_(row[checkIndex]),
      status: status,
      imageUrl: imageUrl,
      imageVer: imageVer || "0",
      receiptUrl: imageUrl,
      receiptUptime: imageVer || "0"
    });
  }
  rows.sort(function(a, b) {
    if (a.vendor !== b.vendor) return a.vendor < b.vendor ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.row - b.row;
  });
  return Object.assign(monthMetaFromResolved_(resolved), {
    rows: rows,
    warnCount: warnCount,
    balanceRebuildAt: getBalanceRebuildAt_(),
    version: APP_VERSION
  });
}

/** 원재료 단가 추이 (원재료입고 기준, 가중평균)
 *  months >= 1: 선택월 말일 기준 최근 N개월 비교
 *  months 미지정/0: 선택월 1일~말일
 */
function priceList(pin, months, monthOpt) {
  assertPin_(pin);
  var span = Math.floor(Number(months) || 0);
  if (span > 24) span = 24;
  var invForMonth = [];
  try {
    invForMonth = sheet_("원재료_실시간재고").getDataRange().getValues();
  } catch (eM) {
    invForMonth = [];
  }
  var resolved = resolveMonth_(monthOpt, invForMonth);
  var bounds = monthDayBounds_(resolved.month);
  var endText = bounds.end;
  var startText = bounds.start;
  if (span >= 1) {
    var endDate = new Date(bounds.end.replace(/-/g, "/") + " 00:00:00");
    var startDate = new Date(endDate.getTime());
    startDate.setMonth(startDate.getMonth() - span);
    startText = Utilities.formatDate(startDate, "Asia/Seoul", "yyyy-MM-dd");
  }

  var master = {};
  try {
    master = materialMaster_();
  } catch (e0) {
    master = {};
  }

  var catByCode = {};
  try {
    var inv = sheet_("원재료_실시간재고").getDataRange().getValues();
    for (var c = 1; c < inv.length; c++) {
      var invCode = text_(inv[c][2]);
      if (invCode) catByCode[invCode] = text_(inv[c][13]);
    }
  } catch (e) {}

  var receipt = sheet_("원재료입고");
  var range = receipt.getDataRange();
  var values = range.getValues();
  var displays = range.getDisplayValues();
  var grouped = {};

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var disp = displays[i] || [];
    if (!row || !String(row.join("")).trim()) continue;
    var date = dateText_(disp[2], row[2]);
    if (!date || date < startText || date > endText) continue;
    var code = canonicalMaterialCode_(text_(row[12]));
    var name = text_(row[13]) || text_(row[7]) || code;
    if (!name) continue;
    var info = code && master[code] ? master[code] : null;
    var conversion = info && info.conversion > 0 ? Number(info.conversion) : 1;
    var stockUnit = info ? text_(info.stockUnit) : "";
    if (!stockUnit && info && info.category) stockUnit = "";
    var qty = moneyOrNull_(row[9]);
    var lineAmount = moneyOrNull_(row[11]);
    var purchaseUnit = moneyOrNull_(row[10]);
    var q = qty !== null && qty > 0 ? qty : 1;
    var stockQty = q * conversion;
    // 환산 단가 = 매입금액 / (영수증수량 × 재고수환산)
    var basePrice = null;
    if (lineAmount !== null && lineAmount > 0 && stockQty > 0) {
      basePrice = tidy_(lineAmount / stockQty);
    } else if (purchaseUnit !== null && purchaseUnit > 0 && conversion > 0) {
      basePrice = tidy_(purchaseUnit / conversion);
    }
    if (basePrice === null || !(basePrice > 0)) continue;

    var key = code || name;
    if (!grouped[key]) {
      grouped[key] = {
        key: key,
        code: code,
        name: name,
        category: (info && info.category) || catByCode[code] || "",
        stockUnit: stockUnit,
        points: [],
        weight: 0,
        weighted: 0
      };
    }
    var g = grouped[key];
    g.name = name;
    if (code) g.code = code;
    if (info && info.category) g.category = info.category;
    else if (catByCode[code]) g.category = catByCode[code];
    if (stockUnit) g.stockUnit = stockUnit;
    g.points.push({
      date: date,
      vendor: text_(row[3]),
      unit: text_(row[8]),
      qty: qty,
      conversion: conversion,
      stockUnit: stockUnit || g.stockUnit || "",
      lineAmount: lineAmount,
      purchasePrice: purchaseUnit,
      price: basePrice
    });
    g.weighted += basePrice * stockQty;
    g.weight += stockQty;
  }

  var rows = [];
  for (var k in grouped) {
    if (!Object.prototype.hasOwnProperty.call(grouped, k)) continue;
    var item = grouped[k];
    item.points.sort(function(a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.price - b.price;
    });
    var prices = [];
    var units = {};
    for (var p = 0; p < item.points.length; p++) {
      prices.push(item.points[p].price);
      if (item.points[p].unit) units[item.points[p].unit] = true;
    }
    rows.push({
      key: item.key,
      name: item.name,
      code: item.code,
      category: item.category,
      stockUnit: item.stockUnit || "",
      count: item.points.length,
      average: item.weight ? tidy_(item.weighted / item.weight) : null,
      low: tidy_(Math.min.apply(null, prices)),
      high: tidy_(Math.max.apply(null, prices)),
      latest: prices[prices.length - 1],
      mixedUnits: Object.keys(units).length > 1,
      points: item.points
    });
  }
  rows.sort(function(a, b) {
    return String(a.name).localeCompare(String(b.name), "ko");
  });
  return Object.assign(monthMetaFromResolved_(resolved), {
    monthsSpan: span,
    monthsList: resolved.months,
    start: startText,
    end: endText,
    rows: rows,
    version: APP_VERSION
  });
}

/** 중간결제(입금) 칸 저장 — 선입금 등 우리가 업체에 넣은 금액 */
function saveBalancePayment(pin, rowNumber, payment) {
  assertPin_(pin);
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("거래처매입누적");
  if (!sheet) throw new Error("거래처매입누적 시트를 찾지 못했습니다.");
  var row = Math.floor(Number(rowNumber));
  if (!(row >= 2) || row > sheet.getLastRow()) throw new Error("행을 찾지 못했습니다.");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(text_);
  var paymentCol = balanceHeaderIndex_(headers, ["중간결제", "결제/조정", "입금", "수금"], -1);
  if (paymentCol < 0) paymentCol = 5; // 회수합계 열 포함 기본 E열(1-based)
  else paymentCol = paymentCol + 1;
  var value = moneyOrNull_(payment);
  sheet.getRange(row, paymentCol).setValue(value === null ? "" : value);
  SpreadsheetApp.flush();
  return { ok: true, row: row, payment: value, message: "결제/조정을 저장했습니다.", version: APP_VERSION };
}

// ===== Jobs (작업센터) — Jobs.gs 와 동일, 파일 누락 방지용 합본 =====
/**
 * PC 패널 작업 중 시트만으로 가능한 것 (환산/재고계산/검증계산/월마감/미등록).
 * POS 수집은 매장 PC 프로그램에서 실행합니다. 영수증 OCR 은 웹(Ocr.gs)에서 처리합니다.
 */

var BALANCE_HEADERS_ = [
  "거래처",
  "거래일자",
  "영수증합계금액",
  "회수합계",
  "중간결제",
  "당월누적금액",
  "검증누계금액",
  "검증",
  "영수증위치",
  "영수증UPTIME"
];

/** 시트에 저장된 등록일시만으로 이미지 버전 토큰 생성 (Drive API 호출 없음) */
function receiptImageStamp_(row, disp) {
  var stamp = text_(disp && disp[0] != null ? disp[0] : "");
  if (!stamp) stamp = text_(row && row[0]);
  var digits = String(stamp).replace(/\D/g, "");
  if (digits.length >= 8) return digits.slice(0, 14);
  return receiptUptimeNow_();
}

/**
 * OCR 직후: 거래처매입누적에 같은 거래처·일자(+합계) 행이 있으면
 * 영수증위치·영수증UPTIME만 반정규화 갱신 (없으면 스킵 — 검증 계산이 전체 생성)
 */
function upsertBalanceReceiptImage_(vendor, date, daily, imageUrl, imageVer) {
  var url = text_(imageUrl);
  if (!url) return 0;
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("거래처매입누적");
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var cols = ensureReceiptMetaCols_(sheet, 7, 8);
  var values = sheet.getDataRange().getValues();
  var headers = [];
  for (var h = 0; h < values[0].length; h++) headers.push(text_(values[0][h]));
  var urlCol = cols.urlCol;
  var verCol = cols.uptimeCol;
  var dailyIndex = balanceHeaderIndex_(headers, ["영수증합계금액", "당일금액"], 2);
  var vkey = normalizeVendor_(vendor);
  var dateKey = text_(date);
  var dailyNum = moneyOrNull_(daily);
  var ver = text_(imageVer) || receiptUptimeNow_();
  var updated = 0;
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (normalizeVendor_(row[0]) !== vkey) continue;
    if (text_(row[1]) !== dateKey) continue;
    if (dailyNum !== null) {
      var rowDaily = moneyOrNull_(row[dailyIndex]);
      if (rowDaily !== null && Math.abs(rowDaily - dailyNum) >= 1) continue;
    }
    sheet.getRange(i + 1, urlCol + 1).setValue(url);
    sheet.getRange(i + 1, verCol + 1).setValue(ver);
    updated++;
  }
  if (updated) SpreadsheetApp.flush();
  return updated;
}

/**
 * 명세서 고유ID → 전표 단위 키 (거래처명까지, 품목순번·금액 제외).
 * 예: 2026-10-19-0076_…_(주)희승_0_1713325 → …_(주)희승
 */
function slipBaseId_(uniqueId, vendor) {
  var uid = text_(uniqueId);
  if (!uid) return "";
  var v = text_(vendor);
  if (v) {
    var idx = uid.indexOf(v);
    if (idx >= 0) return uid.substring(0, idx + v.length);
  }
  var m = String(uid).match(/^(.*)_\d+_\d+(?:\.\d+)?$/);
  return m && m[1] ? m[1] : uid;
}

function nowText_() {
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
}

function nextMonthText_(month) {
  var m = String(month || "").match(/(\d{4})-(\d{2})/);
  if (!m) {
    return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM");
  }
  var y = Number(m[1]);
  var mo = Number(m[2]) + 1;
  if (mo > 12) {
    mo = 1;
    y++;
  }
  return y + "-" + (mo < 10 ? "0" : "") + mo;
}

function normalizeVendor_(value) {
  var text = String(value || "")
    .replace(/㈜/g, "(주)")
    .replace(/㈔/g, "(사)")
    .replace(/㈲/g, "(유)");
  return text.replace(/\s+/g, "").trim();
}

/** 사업자번호 숫자만 (10자리면 매칭키로 사용) */
function digitsBiz_(value) {
  return String(value || "").replace(/\D/g, "");
}

function amountsMatch_(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return Math.abs(Number(left) - Number(right)) < 0.5;
}

/** 현재고 = 이월(E) + 입고(F) - 사용(G) + 조정입고(H) - 조정로스(I) */
function calcCurrentStock_(opening, incoming, used, adjIn, adjLoss) {
  return tidy_(num_(opening) + num_(incoming) - num_(used) + num_(adjIn) - num_(adjLoss));
}

/** 입고단위/규격에서 박스당 수량 추출 (예: "Box / 24Kg" → 24) */
function packSizeFromSpec_(spec) {
  var text = String(spec || "");
  if (text.indexOf("/") >= 0) {
    var after = text.split("/").slice(1).join("/");
    var m = after.match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  var m2 = text.match(/\d+(\.\d+)?/);
  return m2 ? Number(m2[0]) : 0;
}

/** '/' 앞 라벨 (예: "Box / 24Kg" → "Box") */
function packPrefixFromSpec_(spec) {
  var text = String(spec || "");
  if (text.indexOf("/") < 0) return "";
  return text.split("/")[0].replace(/\s+/g, " ").trim();
}

/** 직관적수량용 소수 1자리 반올림 (3.87 → 3.9) */
function roundQty1_(n) {
  return Math.round(num_(n) * 10) / 10;
}

/**
 * 직관적 수량(텍스트). 수식 없이 JS에서 조립. 잔여 kg 등은 소수 1자리.
 * size≤0 → "322kg" / size>0 → "13Box 3.9kg"
 */
function calcDisplayQty_(stock, unit, spec) {
  var qty = num_(stock);
  var unitText = text_(unit);
  var size = packSizeFromSpec_(spec);
  if (!(size > 0)) {
    return String(roundQty1_(qty)) + unitText;
  }
  var absQty = Math.abs(qty);
  var boxes = Math.floor(absQty / size);
  if (boxes <= 0) {
    return String(roundQty1_(qty)) + unitText;
  }
  var remain = roundQty1_(absQty % size);
  var prefix = packPrefixFromSpec_(spec) || "";
  var sign = qty < 0 ? "-" : "";
  var out = sign + boxes + prefix;
  if (remain !== 0) out += " " + remain + unitText;
  return out;
}

/** 한 행의 K(현재고)·N(직관)·L(부족수량)을 값으로 다시 씀 */
function refreshInventoryRowValues_(sheet, rowNumber) {
  var row = sheet.getRange(rowNumber, 1, 1, INV_COL.CATEGORY).getValues()[0];
  var adjIn = num_(row[INV_IDX.ADJ_IN]);
  var adjLoss = num_(row[INV_IDX.ADJ_LOSS]);
  var stock = calcCurrentStock_(
    row[INV_IDX.OPENING], row[INV_IDX.INCOMING], row[INV_IDX.USED], adjIn, adjLoss
  );
  var display = calcDisplayQty_(stock, row[INV_IDX.UNIT], row[INV_IDX.SPEC]);
  var safetyText = text_(row[INV_IDX.SAFETY]);
  var safety = safetyText === "" ? null : num_(row[INV_IDX.SAFETY]);
  var shortage = calcShortageValue_(stock, safety);
  sheet.getRange(rowNumber, INV_COL.STOCK).setValue(stock);
  sheet.getRange(rowNumber, INV_COL.DISPLAY).setValue(display);
  sheet.getRange(rowNumber, INV_COL.SHORTAGE).setValue(shortage);
  return {
    adjustmentIn: adjIn,
    adjustment: adjLoss,
    stock: stock,
    safety: safety,
    display: display,
    shortage: shortage === "" ? null : shortage
  };
}

/** L열(부족수량)만 갱신 (안전재고 J 또는 현재고 K를 직접 고친 경우) */
function refreshShortageOnly_(sheet, rowNumber) {
  var stock = num_(sheet.getRange(rowNumber, INV_COL.STOCK).getValue());
  var safetyCell = sheet.getRange(rowNumber, INV_COL.SAFETY).getValue();
  var shortage = calcShortageValue_(stock, safetyCell);
  sheet.getRange(rowNumber, INV_COL.SHORTAGE).setValue(shortage);
  return shortage;
}

/**
 * 시트 편집 시 즉시 재계산 (컨테이너 바인딩 스크립트에서만 동작)
 * - E~I·M(단위)·O(규격) 변경 → K(현재고)·N(직관)·L(부족)
 * - J(안전)·K(현재고) 변경 → L(부족)만 (현재고 <= 안전재고 → 부족=안전−현재고)
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== "원재료_실시간재고") return;
    var row = e.range.getRow();
    var col = e.range.getColumn();
    var lastCol = e.range.getLastColumn();
    if (row < 2) return;

    var watchRecalc = {};
    watchRecalc[INV_COL.OPENING] = 1;
    watchRecalc[INV_COL.INCOMING] = 1;
    watchRecalc[INV_COL.USED] = 1;
    watchRecalc[INV_COL.ADJ_IN] = 1;
    watchRecalc[INV_COL.ADJ_LOSS] = 1;
    watchRecalc[INV_COL.UNIT] = 1;
    watchRecalc[INV_COL.SPEC] = 1;

    var watchShortage = {};
    watchShortage[INV_COL.SAFETY] = 1;
    watchShortage[INV_COL.STOCK] = 1;

    var needRecalc = false;
    var needShortage = false;
    for (var c = col; c <= lastCol; c++) {
      if (watchRecalc[c]) needRecalc = true;
      if (watchShortage[c]) needShortage = true;
    }
    if (!needRecalc && !needShortage) return;

    var lastRow = e.range.getLastRow();
    for (var r = row; r <= lastRow; r++) {
      if (needRecalc) refreshInventoryRowValues_(sheet, r);
      else refreshShortageOnly_(sheet, r);
    }
  } catch (err) {}
}

/** 영수증별칭(G) 토큰 — pipe 및 "영수증명 ➔ 대표명" 좌측 추출 */
function aliasTokensFromCell_(raw, officialName) {
  var out = [];
  var official = text_(officialName);
  String(raw || "").split("|").forEach(function(part) {
    var p = text_(part);
    if (!p) return;
    if (/➔|=>|→/.test(p)) {
      var left = text_(p.split(/➔|=>|→/)[0]);
      if (left && left !== official && out.indexOf(left) < 0) out.push(left);
    } else if (p !== official && out.indexOf(p) < 0) {
      out.push(p);
    }
  });
  return out;
}

function pushAliasUnique_(list, value, officialName) {
  var v = text_(value);
  var official = text_(officialName);
  if (!v || v === official) return;
  if (list.indexOf(v) < 0) list.push(v);
}

/** FK 열 헤더 후보: 정본=부모대표코드, 레거시=대표코드·연결대표코드 */
function parentRepCodeHeaderNames_() {
  return ["부모대표코드", "대표코드", "연결대표코드"];
}

function isParentRepCodeHeader_(name) {
  var h = text_(name);
  var names = parentRepCodeHeaderNames_();
  for (var i = 0; i < names.length; i++) {
    if (h === names[i]) return true;
  }
  return false;
}

/**
 * 원재료관리 FK 열(0-based).
 * 우선 부모대표코드. 레거시 대표코드/연결대표코드가 있으면 헤더를 부모대표코드로 통일.
 * 없으면 맨 오른쪽에 부모대표코드 추가.
 */
function ensureRepresentativeCodeCol_() {
  var sheet = sheet_("원재료관리");
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var found = -1;
  var legacy = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = text_(headers[i]);
    if (h === "부모대표코드") found = i;
    if (h === "대표코드" || h === "연결대표코드") {
      if (legacy < 0) legacy = i;
    }
  }
  if (found >= 0) return found;
  if (legacy >= 0) {
    sheet.getRange(1, legacy + 1).setValue("부모대표코드");
    SpreadsheetApp.flush();
    return legacy;
  }
  var col = lastCol + 1;
  sheet.getRange(1, col).setValue("부모대표코드");
  SpreadsheetApp.flush();
  return col - 1;
}

/**
 * 별칭 행의 FK(부모대표코드).
 * 레거시 호환: FK 비고 + B열에 코드가 있으면 B를 FK로 간주.
 */
function aliasForeignKey_(repCodeCell, ownCodeCell) {
  var fk = text_(repCodeCell);
  if (fk) return fk;
  return text_(ownCodeCell);
}

/**
 * 코드 → 대표 마스터 (재고환산·OCR 매핑 공용).
 * - 키: 등록구분=대표 인 행의 원재료코드(B)만
 * - 별칭: 대표코드(FK) === 마스터코드 인 행의 품목명·G열 토큰 병합
 */
function materialMaster_() {
  var sheet = sheet_("원재료관리");
  var values = sheet.getDataRange().getValues();
  var statusCol = -1;
  var repCodeCol = -1;
  if (values.length) {
    var headers = values[0];
    for (var h = 0; h < headers.length; h++) {
      var hh = text_(headers[h]);
      if (hh === "등록구분") statusCol = h;
      if (isParentRepCodeHeader_(hh)) {
        if (hh === "부모대표코드" || repCodeCol < 0) repCodeCol = h;
      }
    }
  }
  if (repCodeCol < 0) {
    try { repCodeCol = ensureRepresentativeCodeCol_(); } catch (e0) { repCodeCol = -1; }
    values = sheet.getDataRange().getValues();
    if (values.length) {
      headers = values[0];
      for (h = 0; h < headers.length; h++) {
        if (text_(headers[h]) === "등록구분") statusCol = h;
        if (isParentRepCodeHeader_(headers[h])) {
          if (text_(headers[h]) === "부모대표코드" || repCodeCol < 0) repCodeCol = h;
        }
      }
    }
  }

  var vendorCol = -1;
  var vendor2Col = -1;
  var timingCol = -1;
  if (values.length) {
    headers = values[0];
    for (var hv = 0; hv < headers.length; hv++) {
      var hvText = text_(headers[hv]);
      if (hvText === "거래처1" || hvText === "주거래처") {
        if (vendorCol < 0 || hvText === "거래처1") vendorCol = hv;
      }
      if (hvText === "거래처2") vendor2Col = hv;
      if (hvText === "구매시기") timingCol = hv;
    }
  }

  var master = {};
  // Pass 1: 대표만 키 등록
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var code = text_(row[1]);
    if (!code) continue;
    var statusRaw = statusCol >= 0 && row.length > statusCol ? row[statusCol] : "";
    var regStatus = normalizeRegStatus_(statusRaw, true);
    if (regStatus === "등록제외") continue;
    if (regStatus !== "대표") continue;
    var name = text_(row[0]);
    var conversion = num_(row[3]);
    if (!conversion) conversion = 1;
    if (master[code]) continue; // 대표 중복 시 첫 행
    var vendor1 = vendorCol >= 0 && row.length > vendorCol ? text_(row[vendorCol]) : "";
    var vendor2 = vendor2Col >= 0 && row.length > vendor2Col ? text_(row[vendor2Col]) : "";
    var timingRaw = timingCol >= 0 && row.length > timingCol ? row[timingCol] : "";
    master[code] = {
      name: name,
      spec: text_(row[2]),
      conversion: conversion,
      stockUnit: text_(row[4]),
      category: text_(row[5]),
      aliases: aliasTokensFromCell_(row[6], name),
      primaryVendor: vendor1,
      vendor1: vendor1,
      vendor2: vendor2,
      purchaseTiming: normalizePurchaseTiming_(timingRaw),
      sheetRow: i + 1,
      regStatus: "대표"
    };
  }

  // Pass 2: 별칭 행을 FK로 병합
  for (var j = 1; j < values.length; j++) {
    var row2 = values[j];
    var statusRaw2 = statusCol >= 0 && row2.length > statusCol ? row2[statusCol] : "";
    var reg2 = normalizeRegStatus_(statusRaw2, !!text_(row2[1]));
    if (reg2 !== "별칭") continue;
    var fk = aliasForeignKey_(
      repCodeCol >= 0 && row2.length > repCodeCol ? row2[repCodeCol] : "",
      row2[1]
    );
    if (!fk || !master[fk]) continue;
    var info = master[fk];
    pushAliasUnique_(info.aliases, text_(row2[0]), info.name);
    aliasTokensFromCell_(row2[6], info.name).forEach(function(tok) {
      pushAliasUnique_(info.aliases, tok, info.name);
    });
  }
  return master;
}

function weightFromSpec_(text) {
  var matches = String(text || "").match(/(\d+(?:\.\d+)?)\s*kg/ig);
  if (!matches || !matches.length) return null;
  var last = matches[matches.length - 1].match(/(\d+(?:\.\d+)?)/);
  return last ? Number(last[1]) : null;
}

/** 별칭 표시코드 M1010_01 → 대표 M1010 (재고·환산 조회용) */
function canonicalMaterialCode_(code) {
  var c = text_(code);
  if (!c || c === "IGNORE") return c;
  var m = String(c).match(/^(M\d{4,})(?:_\d{2})?$/i);
  return m ? m[1].toUpperCase() : c;
}

/** @deprecated 시트 정본: 별칭 입고도 부모대표코드 사용. 레거시 _01 정리용으로만 유지 */
function aliasDisplayCode_(parentCode) {
  return canonicalMaterialCode_(parentCode);
}

function reflectedQuantity_(master, code, unit, receiptQty) {
  var info = master[canonicalMaterialCode_(code)];
  if (!info) return null;
  if (info.category === "고기") {
    var weight = weightFromSpec_(unit);
    return weight === null ? null : tidy_(weight);
  }
  return tidy_(info.conversion * num_(receiptQty));
}

/**
 * 원재료입고 행이 쿠폰·에누리·할인(마이너스 금액)인지.
 * 돈(거래처매입누적)에는 반영하되 재고 수량 합산에서는 제외.
 */
function isDiscountReceiptRow_(row) {
  row = row || [];
  if (typeof isDiscountOcrItem_ === "function") {
    return isDiscountOcrItem_(row[7], row[8], row[9], row[11]);
  }
  var name = text_(row[7]);
  var spec = text_(row[8]);
  if (/쿠폰|에누리|포인트\s*사용|이벤트\s*할인|프로모션|할인/.test(name)) return true;
  if (spec === "할인" || /^할인/.test(spec)) return true;
  var tp = moneyOrNull_(row[11]);
  return tp !== null && tp < 0;
}

function openMonthFromInventory_() {
  var inv = sheet_("원재료_실시간재고").getDataRange().getValues();
  return latestMonth_(inv);
}

/** 3. 입고 수량 환산 — D11 A안: 선택월(없으면 최신월) 대상 */
function jobUpdateReceiptQuantities(pin, month) {
  assertPin_(pin);
  var master = materialMaster_();
  var inv = sheet_("원재료_실시간재고").getDataRange().getValues();
  var resolved = resolveMonth_(month, inv);
  var openMonth = resolved.month;
  var sheet = sheet_("원재료입고");
  var values = sheet.getDataRange().getValues();
  var changed = 0;
  var meat = 0;
  var converted = 0;
  var skipped = 0;
  var meatNoWeight = 0;
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row || !String(row.join("")).trim()) continue;
    if (receiptMonth_(row) !== openMonth) continue;
    // 할인·쿠폰 행: 최종반영수량 0 고정 (재고 환산 금지)
    if (isDiscountReceiptRow_(row)) {
      if (text_(row[14]) !== "" && Math.abs(num_(row[14])) > 1e-9) {
        sheet.getRange(i + 1, 15).setValue(0);
        touchChangedAt_(sheet, i + 1);
        changed++;
      } else if (text_(row[14]) === "") {
        sheet.getRange(i + 1, 15).setValue(0);
        touchChangedAt_(sheet, i + 1);
        changed++;
      }
      skipped++;
      continue;
    }
    var code = canonicalMaterialCode_(text_(row[12]));
    if (!code) {
      skipped++;
      continue;
    }
    if (!master[code]) {
      skipped++;
      continue;
    }
    var next = reflectedQuantity_(master, code, row[8], row[9]);
    if (next === null) {
      meatNoWeight++;
      continue;
    }
    var current = text_(row[14]);
    if (current !== "" && Math.abs(num_(current) - next) < 1e-6) continue;
    sheet.getRange(i + 1, 15).setValue(next);
    touchChangedAt_(sheet, i + 1);
    changed++;
    if (master[code].category === "고기") meat++;
    else converted++;
  }
  SpreadsheetApp.flush();
  var lines = ["완료되었습니다.", "기준월 " + openMonth + " 입고 " + changed + "줄의 최종반영수량을 고쳤습니다."];
  var details = [];
  if (meat) details.push("고기 " + meat + "줄은 단위/규격의 무게");
  if (converted) details.push(converted + "줄은 재고수환산 × 영수증 수량");
  if (details.length) lines.push(details.join(", ") + "입니다.");
  if (skipped) lines.push("코드가 없는/모르는 " + skipped + "줄은 그대로 두었습니다.");
  if (meatNoWeight) lines.push("무게가 없는 고기 " + meatNoWeight + "줄은 그대로 두었습니다.");
  return { ok: true, message: lines.join("\n"), version: APP_VERSION };
}

/** 6. 실시간 재고 계산 (수식 없이 K·N·L 값 기록) — D11 A안: 선택월 대상 */
function jobCalculateInventory(pin, month) {
  return calculateInventory_main(pin, month);
}

/** 구매시기 정규화: pos | 평균주기 | "" */
function normalizePurchaseTiming_(raw) {
  var t = text_(raw).toLowerCase().replace(/\s/g, "");
  if (t === "pos") return "pos";
  if (t === "평균주기" || t === "구매주기" || t === "평균" || t === "주기") return "평균주기";
  return "";
}

function addDaysIso_(iso, days) {
  var d = asDate_(iso);
  if (!d) return "";
  d = new Date(d.getTime());
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd");
}

function daysInclusive_(fromIso, toIso) {
  var a = asDate_(fromIso);
  var b = asDate_(toIso);
  if (!a || !b || b < a) return 0;
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
}

function lastDayOfMonthIso_(ym) {
  var parts = String(ym || "").split("-");
  if (parts.length < 2) return "";
  var y = Number(parts[0]);
  var m = Number(parts[1]);
  if (!(y > 0 && m >= 1 && m <= 12)) return "";
  var d = new Date(y, m, 0);
  return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd");
}

/**
 * 평균주기 재료: 최근 1년 입고(반영완료)로 일평균 사용량·마지막 입고일 산출.
 * 동일 일자 입고는 1회로 합산.
 */
function buildAvgCycleStats_(master, todayIso) {
  var out = {};
  var cutoff = addDaysIso_(todayIso, -365);
  if (!cutoff) cutoff = "2000-01-01";
  var byCode = {};
  try {
    var staging = sheet_("원재료입고").getDataRange().getValues();
    var displays = sheet_("원재료입고").getDataRange().getDisplayValues();
    for (var i = 1; i < staging.length; i++) {
      var row = staging[i];
      if (text_(row[16]) !== "반영완료") continue;
      if (isDiscountReceiptRow_(row)) continue;
      var code = canonicalMaterialCode_(text_(row[12]));
      if (!code || !master[code] || master[code].purchaseTiming !== "평균주기") continue;
      var day = dateText_(displays[i] && displays[i][2], row[2]);
      if (!day || day.length < 10) continue;
      day = day.slice(0, 10);
      if (cutoff && day < cutoff) continue;
      var qty = num_(row[14]);
      if (!(qty > 0)) continue;
      if (!byCode[code]) byCode[code] = {};
      byCode[code][day] = (byCode[code][day] || 0) + qty;
    }
  } catch (e) {
    return out;
  }
  Object.keys(byCode).forEach(function(code) {
    var days = Object.keys(byCode[code]).sort();
    if (!days.length) return;
    var lastDate = days[days.length - 1];
    var qtys = days.map(function(d) { return byCode[code][d]; });
    var avgQty = 0;
    for (var q = 0; q < qtys.length; q++) avgQty += qtys[q];
    avgQty = avgQty / qtys.length;
    var avgCycle = 0;
    if (days.length >= 2) {
      var gapSum = 0;
      for (var g = 1; g < days.length; g++) {
        var a = asDate_(days[g - 1]);
        var b = asDate_(days[g]);
        if (a && b) gapSum += Math.max(1, Math.floor((b.getTime() - a.getTime()) / 86400000));
      }
      avgCycle = gapSum / (days.length - 1);
    }
    var avgDaily = avgCycle > 0 ? tidy_(avgQty / avgCycle) : 0;
    out[code] = {
      avgDaily: avgDaily,
      avgCycle: avgCycle ? tidy_(avgCycle) : 0,
      lastDate: lastDate,
      orders: days.length
    };
  });
  return out;
}

/** 평균주기 → 당월 사용량·당일사용량 */
function cycleUsageForMonth_(stat, openMonth, todayText) {
  var avgDaily = stat && stat.avgDaily > 0 ? Number(stat.avgDaily) : 0;
  if (!(avgDaily > 0)) return { used: 0, usedToday: 0 };
  var monthStart = openMonth + "-01";
  var monthEnd = textMonth_(todayText) === openMonth ? todayText : lastDayOfMonthIso_(openMonth);
  if (!monthEnd) monthEnd = todayText;
  var lastDate = stat.lastDate || "";
  var from = monthStart;
  if (lastDate && lastDate >= monthStart) {
    from = addDaysIso_(lastDate, 1);
  }
  if (!from || from > monthEnd) return { used: 0, usedToday: 0 };
  var days = daysInclusive_(from, monthEnd);
  var used = tidy_(avgDaily * days);
  var usedToday = 0;
  if (textMonth_(todayText) === openMonth && (!lastDate || todayText > lastDate)) {
    usedToday = tidy_(avgDaily);
  }
  return { used: used, usedToday: usedToday };
}

function calculateInventory_main(pin, month) {
  assertPin_(pin);
  var inventory = sheet_("원재료_실시간재고");
  // 헤더 보장
  try {
    var headers = inventory.getRange(1, 1, 1, INV_COL.AVG_USED).getValues()[0];
    if (text_(headers[INV_IDX.USED_TODAY]) !== "당일사용량") {
      inventory.getRange(1, INV_COL.USED_TODAY).setValue("당일사용량");
    }
    if (text_(headers[INV_IDX.AVG_USED]) !== "평균사용량") {
      inventory.getRange(1, INV_COL.AVG_USED).setValue("평균사용량");
    }
  } catch (eH) {}
  var values = inventory.getDataRange().getValues();
  if (values.length <= 1) throw new Error("원재료_실시간재고에 계산할 재료가 없습니다.");
  var resolved = resolveMonth_(month, values);
  var openMonth = resolved.month;
  if (!resolved.hasInventoryMonth) {
    throw new Error(
      "재고 시트에 " + openMonth + " 기준월이 없습니다.\n" +
      "월마감 전에는 다음달 재고계산을 할 수 없습니다. 입고검수만 진행하세요."
    );
  }

  var master = {};
  try { master = materialMaster_() || {}; } catch (eM) { master = {}; }
  var todayText = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  var cycleStats = buildAvgCycleStats_(master, todayText);

  var salesQty = {};
  var salesQtyToday = {};
  try {
    var salesRange = sheet_("pos판매내역").getDataRange();
    var sales = salesRange.getValues();
    var salesDisp = salesRange.getDisplayValues();
    var salesMap = posHeaderMap_(sales[0]);
    var useSalesMap = salesMap.name >= 0 && salesMap.qty >= 0;
    for (var s = 1; s < sales.length; s++) {
      var pos = parsePosSalesRow_(sales[s], salesDisp[s], useSalesMap ? salesMap : null);
      if (!pos) continue;
      if (textMonth_(pos.date || sales[s][0]) !== openMonth) continue;
      var menu = pos.name;
      var qty = num_(pos.qty);
      if (!(menu && qty > 0)) continue;
      salesQty[menu] = (salesQty[menu] || 0) + qty;
      var saleDay = String(pos.date || "").trim().slice(0, 10);
      if (saleDay === todayText) {
        salesQtyToday[menu] = (salesQtyToday[menu] || 0) + qty;
      }
    }
  } catch (e) {}

  var usage = {};
  var usageToday = {};
  var avgUsed = {};
  var names = {};
  try {
    var recipe = sheet_("레시피배합표").getDataRange().getValues();
    for (var r = 1; r < recipe.length; r++) {
      if (recipe[r].length < 6) continue;
      var menuName = text_(recipe[r][2]);
      var ingName = recipe[r][3];
      var code = text_(recipe[r][4]);
      var amount = num_(recipe[r][5]);
      if (!code || code === "undefined" || code === "nan") continue;
      var canon = canonicalMaterialCode_(code) || code;
      // pos 구매시기만 레시피×판매 반영 (마스터 없는 코드·빈 구매시기 제외)
      if (!master[canon] || master[canon].purchaseTiming !== "pos") continue;
      names[canon] = text_(ingName) || names[canon] || canon;
      usage[canon] = (usage[canon] || 0) + ((salesQty[menuName] || 0) * amount);
      usageToday[canon] = (usageToday[canon] || 0) + ((salesQtyToday[menuName] || 0) * amount);
    }
  } catch (e2) {}

  var received = {};
  var receiptNames = {};
  try {
    var staging = sheet_("원재료입고").getDataRange().getValues();
    for (var i = 1; i < staging.length; i++) {
      var row = staging[i];
      if (text_(row[16]) !== "반영완료") continue;
      if (receiptMonth_(row) !== openMonth) continue;
      if (isDiscountReceiptRow_(row)) continue;
      var rcode = canonicalMaterialCode_(text_(row[12]));
      if (!rcode || !master[rcode]) continue;
      var timing = master[rcode].purchaseTiming;
      if (timing !== "pos" && timing !== "평균주기") continue;
      var addQty = num_(row[14]);
      if (!addQty) continue;
      received[rcode] = (received[rcode] || 0) + addQty;
      var official = text_(row[13]);
      if (official) receiptNames[rcode] = official;
    }
  } catch (e3) {}

  // 평균주기 사용량 덮어쓰기
  Object.keys(cycleStats).forEach(function(code) {
    if (!master[code] || master[code].purchaseTiming !== "평균주기") return;
    var cu = cycleUsageForMonth_(cycleStats[code], openMonth, todayText);
    usage[code] = cu.used;
    usageToday[code] = cu.usedToday;
    avgUsed[code] = cycleStats[code].avgDaily || 0;
    if (!names[code]) names[code] = master[code].name || code;
  });

  var rowOf = {};
  for (var v = 1; v < values.length; v++) {
    if (textMonth_(values[v][INV_IDX.MONTH]) !== openMonth) continue;
    var c = text_(values[v][INV_IDX.CODE]);
    if (c) rowOf[c] = v + 1;
  }

  var timestamp = nowText_();
  var tracked = {};
  Object.keys(names).forEach(function(k) { tracked[k] = true; });
  Object.keys(received).forEach(function(k) { tracked[k] = true; });
  Object.keys(cycleStats).forEach(function(k) { tracked[k] = true; });
  // 재고행에 있는 평균주기 재료도 갱신
  Object.keys(rowOf).forEach(function(code) {
    if (master[code] && master[code].purchaseTiming === "평균주기") tracked[code] = true;
    if (master[code] && master[code].purchaseTiming === "pos") tracked[code] = true;
  });

  var migrated = 0;
  var newRows = [];
  var posCount = 0;
  var cycleCount = 0;

  Object.keys(tracked).forEach(function(code) {
    if (!master[code]) return; // 원재료관리 대표만
    var timing = master[code].purchaseTiming;
    if (timing !== "pos" && timing !== "평균주기") return;
    var name = text_(names[code]) || receiptNames[code] || master[code].name || code;
    var used = usage[code] || 0;
    var usedToday = usageToday[code] || 0;
    var avgVal = timing === "평균주기" && avgUsed[code] > 0 ? avgUsed[code] : "";
    if (timing === "평균주기") cycleCount++;
    else posCount++;
    var monthReceived = received[code] || 0;
    if (rowOf[code]) {
      var rowNumber = rowOf[code];
      var current = values[rowNumber - 1];
      var opening = num_(current[INV_IDX.OPENING]);
      var adjIn = text_(current[INV_IDX.ADJ_IN]) === "" ? 0 : num_(current[INV_IDX.ADJ_IN]);
      var adjLoss = text_(current[INV_IDX.ADJ_LOSS]) === "" ? 0 : num_(current[INV_IDX.ADJ_LOSS]);
      var safety = current[INV_IDX.SAFETY];
      var unit = text_(current[INV_IDX.UNIT]) || text_(master[code].stockUnit);
      var spec = text_(current[INV_IDX.SPEC]) || text_(master[code].spec);
      var category = text_(current[INV_IDX.CATEGORY]) || text_(master[code].category);

      if (text_(current[INV_IDX.OPENING]) === "") {
        var stockNow = num_(current[INV_IDX.STOCK]);
        opening = stockNow - monthReceived + used - adjIn + adjLoss;
        if (Math.abs(opening) < 1e-9) opening = 0;
        opening = tidy_(opening);
        migrated++;
      }

      var stock = calcCurrentStock_(opening, monthReceived, used, adjIn, adjLoss);
      var display = calcDisplayQty_(stock, unit, spec);
      var shortage = calcShortageValue_(stock, safety);
      inventory.getRange(rowNumber, 1, 1, INV_COL.AVG_USED).setValues([[
        openMonth, timestamp, code, name,
        opening, monthReceived, used, adjIn, adjLoss,
        safety, stock, shortage, unit, display, spec, category, usedToday, avgVal
      ]]);
    } else {
      newRows.push([code, name, monthReceived, used, usedToday, avgVal]);
    }
  });

  if (newRows.length) {
    var start = inventory.getLastRow() + 1;
    var prepared = newRows.map(function(item) {
      var stock = calcCurrentStock_(0, item[2], item[3], 0, 0);
      var display = calcDisplayQty_(stock, "", "");
      var shortage = calcShortageValue_(stock, "");
      return [
        openMonth, timestamp, item[0], item[1],
        0, item[2], item[3], 0, 0,
        "", stock, shortage, "", display, "", "", item[4] || 0, item[5] === "" ? "" : item[5]
      ];
    });
    inventory.getRange(start, 1, prepared.length, prepared[0].length).setValues(prepared);
  }
  SpreadsheetApp.flush();
  var kept = migrated
    ? "비어 있던 이월재고 " + migrated + "개는 현재 재고가 유지되도록 채웠습니다."
    : "이월재고·조정입고·조정로스는 그대로 두었습니다.";
  return {
    ok: true,
    message:
      "완료되었습니다.\n기준월 " + openMonth +
      " · pos " + posCount + " · 평균주기 " + cycleCount + "건 반영.\n" + kept,
    version: APP_VERSION
  };
}

/** 8. 월마감 — 현재고(K)를 다음 달 이월재고(E)로 넘기고 K·N·L 값으로 기록 */
function jobMonthlyClose(pin) {
  return monthlyClose_logic(pin);
}

function monthlyClose_logic(pin) {
  assertPin_(pin);
  var inventory = sheet_("원재료_실시간재고");
  var values = inventory.getDataRange().getValues();
  if (values.length <= 1) throw new Error("원재료_실시간재고에 마감할 데이터가 없습니다.");
  var current = latestMonth_(values);
  var following = nextMonthText_(current);
  // 당월(M) 마감은 M+1월 1일부터 (달력일, Asia/Seoul)
  var today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  var openFrom = following + "-01";
  if (today < openFrom) {
    throw new Error(
      current + " 월마감은 " + openFrom + "부터 가능합니다.\n(오늘은 " + today + ")"
    );
  }
  var currentRows = {};
  var nextRows = {};
  for (var i = 1; i < values.length; i++) {
    var code = text_(values[i][INV_IDX.CODE]);
    if (!code) continue;
    var month = textMonth_(values[i][INV_IDX.MONTH]);
    if (month === current) currentRows[code] = values[i];
    else if (month === following) nextRows[code] = i + 1;
  }
  if (!Object.keys(currentRows).length) throw new Error(current + " 기준월 재고가 없습니다.");

  var timestamp = nowText_();
  var prepared = [];
  Object.keys(currentRows).forEach(function(code) {
    var row = currentRows[code];
    var unit = text_(row[INV_IDX.UNIT]);
    var spec = text_(row[INV_IDX.SPEC]);
    // 현재고(K). 비어 있으면 재계산
    var stock = text_(row[INV_IDX.STOCK]) === ""
      ? calcCurrentStock_(
          row[INV_IDX.OPENING], row[INV_IDX.INCOMING], row[INV_IDX.USED],
          row[INV_IDX.ADJ_IN], row[INV_IDX.ADJ_LOSS]
        )
      : num_(row[INV_IDX.STOCK]);
    // 이월재고 = 현재고 (동일 재고단위). 규격숫자는 직관적수량(N) 조립에만 사용
    var opening = Math.abs(stock) < 1e-9 ? 0 : tidy_(stock);
    var nextStock = calcCurrentStock_(opening, 0, 0, 0, 0);
    var nextDisplay = calcDisplayQty_(nextStock, unit, spec);

    if (nextRows[code]) {
      var rowNumber = nextRows[code];
      var existing = values[rowNumber - 1];
      var keepUnit = text_(existing[INV_IDX.UNIT]) || unit;
      var keepSpec = text_(existing[INV_IDX.SPEC]) || spec;
      var keepCat = text_(existing[INV_IDX.CATEGORY]) || text_(row[INV_IDX.CATEGORY]);
      var keepSafety = existing[INV_IDX.SAFETY];
      if (text_(keepSafety) === "" && text_(row[INV_IDX.SAFETY]) !== "") keepSafety = row[INV_IDX.SAFETY];
      nextDisplay = calcDisplayQty_(nextStock, keepUnit, keepSpec);
      var keepShortage = calcShortageValue_(nextStock, keepSafety);
      inventory.getRange(rowNumber, 1, 1, INV_COL.AVG_USED).setValues([[
        following, timestamp, code, text_(row[INV_IDX.NAME]),
        opening, 0, 0, 0, 0,
        keepSafety, nextStock, keepShortage, keepUnit, nextDisplay, keepSpec, keepCat, 0, ""
      ]]);
      return;
    }
    var nextSafety = row[INV_IDX.SAFETY];
    var nextShortage = calcShortageValue_(nextStock, nextSafety);
    prepared.push([
      following, timestamp, code, text_(row[INV_IDX.NAME]),
      opening, 0, 0, 0, 0,
      nextSafety, nextStock, nextShortage, unit, nextDisplay, spec, text_(row[INV_IDX.CATEGORY]), 0, ""
    ]);
  });
  if (prepared.length) {
    var start = inventory.getLastRow() + 1;
    inventory.getRange(start, 1, prepared.length, INV_COL.AVG_USED).setValues(prepared);
  }
  SpreadsheetApp.flush();
  return {
    ok: true,
    message: "완료되었습니다.\n" + current + " 행은 그대로 두었습니다.\n남은 재고를 " + following +
      " 이월재고로 같은 시트에 " + Object.keys(currentRows).length + "개 만들었습니다.\n다음 달 입고, 사용량, 조정입고·로스는 0입니다.",
    month: current,
    latestMonth: following,
    months: listInventoryMonths_(inventory.getDataRange().getValues()),
    isLatest: true,
    version: APP_VERSION
  };
}

/**
 * 검증 상태:
 *  - 누적 미제공 패턴(명세서누적 없음, 또는 누적이 당일과 같고 기초>0):
 *      · 당월누적계산 = 기초 + 당일 (결제/조정은 누적에 넣지 않음)
 *      · 결제/조정 미입력 → 금액 불일치
 *      · 결제/조정 = 명세서금액 → OK, 아니면 불일치
 *  - 입금 재확인: 잔액이 줄었는데 결제/조정 0
 *  - 금액 불일치: 검증누계 vs 명세 누적 오차 ≥ 0.5
 *  - OK: 일치
 *
 * 결제/조정(enteredPayment):
 *   누적 있는 전표: 명세서누적−당월누적계산(부호 있는 조정).
 *   누적 없는 전표: 중간결제 = 명세서금액(양수) 입력.
 */
function settleReceipt_(opening, amount, monthTotal, enteredPayment, prevMonthTotal) {
  opening = num_(opening);
  amount = num_(amount);
  var paymentEntered =
    enteredPayment !== null && enteredPayment !== undefined && text_(enteredPayment) !== "";
  var payment = paymentEntered ? num_(enteredPayment) : 0;
  var shown = paymentEntered ? tidy_(payment) : null;
  var monthEmpty = monthTotal === null || monthTotal === undefined || monthTotal === "";
  // 누적이 당일만 찍혀 있고 이전 이월(기초)이 남아 있으면 → 누적 미제공과 동일 취급
  var monthIsDailyOnly =
    !monthEmpty &&
    Math.abs(opening) >= 0.5 &&
    amountsMatch_(num_(monthTotal), amount);
  var noCumulativeSlip = monthEmpty || monthIsDailyOnly;

  // 누적 미제공: 당월누적계산은 결제와 무관하게 기초+당일만 누적
  if (noCumulativeSlip) {
    var runTotal = tidy_(opening + amount);
    if (!paymentEntered) {
      if (Math.abs(opening) < 0.5 && Math.abs(amount) < 0.5) {
        return { payment: shown, checkTotal: runTotal, status: "OK", carried: runTotal };
      }
      return { payment: shown, checkTotal: runTotal, status: "금액 불일치", carried: runTotal };
    }
    if (amountsMatch_(payment, amount)) {
      return { payment: shown, checkTotal: runTotal, status: "OK", carried: runTotal };
    }
    return { payment: shown, checkTotal: runTotal, status: "금액 불일치", carried: runTotal };
  }

  var checkTotal = tidy_(opening + amount + payment);
  monthTotal = num_(monthTotal);
  if (amountsMatch_(checkTotal, monthTotal)) {
    return { payment: shown, checkTotal: checkTotal, status: "OK", carried: checkTotal };
  }
  // 영수증이 전일잔액만 당월누적으로 찍는 패턴 → 검증누계를 기초+당일로 맞춤
  if (!paymentEntered && amountsMatch_(monthTotal, opening) && amount > 0 && (opening > 0 || monthTotal > 0)) {
    var after = tidy_(opening + amount);
    return { payment: null, checkTotal: after, status: "OK", carried: after };
  }
  var carried = monthTotal < 0 ? checkTotal : monthTotal;
  if (
    prevMonthTotal !== null && prevMonthTotal !== undefined && prevMonthTotal !== "" &&
    !paymentEntered &&
    num_(monthTotal) < num_(prevMonthTotal) - 0.5
  ) {
    return { payment: shown, checkTotal: checkTotal, status: "입금 재확인", carried: carried };
  }
  return { payment: shown, checkTotal: checkTotal, status: "금액 불일치", carried: carried };
}

/** 주류 거래처: 전일채권 + 매출합계 - 회수합계 - 중간결제(입금) == 채권잔액 */
function isLiquorVendor_(name) {
  var n = normalizeVendor_(name);
  if (!n) return false;
  return n.indexOf("주류") >= 0 || n.indexOf("정성주류") >= 0;
}

/**
 * 주류 검증:
 *   |전일채권 - 채권잔액| == |상품합계 - 회수금 + 결제/조정|  → OK
 * 당월누적계산(checkTotal)은 호출측에서 누적(상품합)-누적(회수)로 넣는다.
 * 결제/조정은 부호 있는 조정액(불일치 뱃지와 동일 부호로 입력).
 *
 * @param previousCredit 전일채권
 * @param amount 매출합계(명세서 총액)
 * @param creditBalance 채권잔액(명세)
 * @param enteredPayment 결제/조정 (부호 있음)
 * @param recoveryTotal 회수합계(보증금/V열)
 * @param monthNetCum 당월누적계산 = 누적(상품합) - 누적(회수)
 */
function settleLiquorReceipt_(previousCredit, amount, creditBalance, enteredPayment, prevMonthTotal, recoveryTotal, monthNetCum) {
  var opening = previousCredit === null || previousCredit === undefined ? 0 : num_(previousCredit);
  amount = num_(amount);
  var recovery = recoveryTotal === null || recoveryTotal === undefined || recoveryTotal === "" ? 0 : num_(recoveryTotal);
  if (recovery < 0) recovery = 0;
  var paymentEntered =
    enteredPayment !== null && enteredPayment !== undefined && text_(enteredPayment) !== "";
  var payment = paymentEntered ? num_(enteredPayment) : 0;
  var shown = paymentEntered ? tidy_(payment) : null;
  var netSales = tidy_(amount - recovery);
  var creditEmpty = creditBalance === null || creditBalance === undefined || creditBalance === "";
  var creditIsDailyOnly =
    !creditEmpty &&
    Math.abs(opening) >= 0.5 &&
    amountsMatch_(num_(creditBalance), netSales);
  var noCumulativeSlip = creditEmpty || creditIsDailyOnly;
  var runTotal = monthNetCum === null || monthNetCum === undefined || monthNetCum === ""
    ? tidy_(netSales)
    : tidy_(num_(monthNetCum));
  var carriedRun = tidy_(opening + amount - recovery);

  // 누적 미제공: 당월누적계산에 결제 미반영, 결제/조정=당일(순매출)이면 OK
  if (noCumulativeSlip) {
    if (!paymentEntered) {
      if (Math.abs(netSales) < 0.5 && Math.abs(opening) < 0.5 && Math.abs(amount) < 0.5) {
        return {
          payment: shown,
          checkTotal: runTotal,
          status: "OK",
          carried: carriedRun,
          displayAmount: netSales
        };
      }
      return {
        payment: shown,
        checkTotal: runTotal,
        status: "금액 불일치",
        carried: carriedRun,
        displayAmount: netSales
      };
    }
    if (amountsMatch_(payment, netSales) || amountsMatch_(payment, amount)) {
      return {
        payment: shown,
        checkTotal: runTotal,
        status: "OK",
        carried: carriedRun,
        displayAmount: netSales
      };
    }
    return {
      payment: shown,
      checkTotal: runTotal,
      status: "금액 불일치",
      carried: carriedRun,
      displayAmount: netSales
    };
  }

  var expectedBalance = tidy_(opening + amount - recovery + payment);
  var checkTotal = tidy_(runTotal + payment);
  creditBalance = num_(creditBalance);
  // 검증: |전일채권 - 채권잔액| == |상품합계 - 회수금 + 결제/조정|
  var deltaBond = tidy_(opening - creditBalance);
  var deltaNet = tidy_(amount - recovery + payment);
  if (amountsMatch_(Math.abs(deltaBond), Math.abs(deltaNet)) || amountsMatch_(expectedBalance, creditBalance)) {
    return {
      payment: shown,
      checkTotal: checkTotal,
      status: "OK",
      carried: creditBalance,
      displayAmount: netSales
    };
  }
  var carried = creditBalance < 0 ? expectedBalance : creditBalance;
  if (
    prevMonthTotal !== null && prevMonthTotal !== undefined && prevMonthTotal !== "" &&
    !paymentEntered &&
    creditBalance < num_(prevMonthTotal) - 0.5
  ) {
    return {
      payment: shown,
      checkTotal: checkTotal,
      status: "입금 재확인",
      carried: carried,
      displayAmount: netSales
    };
  }
  return {
    payment: shown,
    checkTotal: checkTotal,
    status: "금액 불일치",
    carried: carried,
    displayAmount: netSales
  };
}

/** 7. 거래처 금액 검증 계산 — 검증대상 Y 거래처를 사업자번호로 원재료입고와 매칭 */
function jobRebuildVendorBalances(pin) {
  assertPin_(pin);
  var vendorSheet = sheet_("거래처관리");
  var vendors = vendorSheet.getDataRange().getValues();
  // allowed: 관리 거래처명(정규화) → 표시명. allowedByBiz: 사업자숫자 → 표시명
  var allowed = {};
  var allowedByBiz = {};
  for (var v = 1; v < vendors.length; v++) {
    var name = text_(vendors[v][0]);
    if (!name) continue;
    if (String(vendors[v][2] || "").trim().toUpperCase() !== "Y") continue;
    allowed[normalizeVendor_(name)] = name;
    var masterBiz = digitsBiz_(vendors[v][1]);
    if (masterBiz.length === 10) allowedByBiz[masterBiz] = name;
  }

  var balanceSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("거래처매입누적");
  if (!balanceSheet) {
    balanceSheet = SpreadsheetApp.openById(SPREADSHEET_ID).insertSheet("거래처매입누적");
  }
  // 기존 결제/조정(중간결제)은 보존 → 사용자가 저장한 차액으로 재검증 시 OK 가능
  var saved = {};
  var existing = balanceSheet.getDataRange().getValues();
  if (existing.length) {
    var exHeaders = existing[0].map(function(h) { return text_(h); });
    var exDaily = balanceHeaderIndex_(exHeaders, ["영수증합계금액", "당일금액", "명세서금액"], 2);
    var exPay = balanceHeaderIndex_(exHeaders, ["중간결제", "입금", "수금", "결제/조정"], -1);
    var exMonth = balanceHeaderIndex_(exHeaders, ["당월누적금액", "명세서누적금액"], -1);
    if (exPay < 0 || text_(exHeaders[exPay]) === "회수합계" || text_(exHeaders[exPay]) === "회수금") {
      exPay = balanceHeaderIndex_(exHeaders, ["중간결제", "입금", "수금", "결제/조정"], 3);
    }
    if (exMonth < 0 || text_(exHeaders[exMonth]) === "중간결제" || text_(exHeaders[exMonth]) === "수금") {
      exMonth = balanceHeaderIndex_(exHeaders, ["당월누적금액", "명세서누적금액"], 4);
    }
    for (var e = 1; e < existing.length; e++) {
      var key = normalizeVendor_(existing[e][0]);
      var date = text_(existing[e][1]);
      if (!key || !date) continue;
      var sk = key + "|" + date;
      if (!saved[sk]) saved[sk] = [];
      saved[sk].push({
        daily: moneyOrNull_(existing[e][exDaily]),
        payment: exPay >= 0 ? moneyOrNull_(existing[e][exPay]) : null,
        month: exMonth >= 0 ? moneyOrNull_(existing[e][exMonth]) : null
      });
    }
  }

  var stagingRange = sheet_("원재료입고").getDataRange();
  var staging = stagingRange.getValues();
  var displays = stagingRange.getDisplayValues();
  var stagingHeaders = staging.length ? staging[0].map(function(h) { return text_(h); }) : [];
  var prevCreditCol = balanceHeaderIndex_(stagingHeaders, ["전일채권"], 20);
  var recoveryCol = balanceHeaderIndex_(stagingHeaders, ["회수합계", "회수금", "보증금"], 21);
  // 원재료입고 S열(중간결제) 미사용. 결제/조정은 거래처매입누적 사용자 입력만.
  var grouped = {};
  for (var i = 1; i < staging.length; i++) {
    var row = staging[i];
    if (!row || !String(row.join("")).trim()) continue;
    if (moneyOrNull_(row[11]) === null) continue;
    var dailyKnown = moneyOrNull_(row[5]) !== null;
    var bizDigits = digitsBiz_(row[4]);
    var status = text_(row[16]);
    if (!dailyKnown && bizDigits.length !== 10 && status !== "검수대기" && status !== "반영완료") continue;
    // 1순위 사업자번호, 2순위 거래처명(정규화) — 누적 시트에는 관리 거래처명(001_회승) 기록
    var masterName = null;
    if (bizDigits.length === 10 && allowedByBiz[bizDigits]) {
      masterName = allowedByBiz[bizDigits];
    } else {
      var nameKey = normalizeVendor_(row[3]);
      if (allowed[nameKey]) masterName = allowed[nameKey];
    }
    var date = dateText_(displays[i][2], row[2]);
    if (!masterName || !date) continue;
    var vkey = normalizeVendor_(masterName);
    var daily = moneyOrNull_(row[5]);
    var uniqueId = text_(row[1]);
    var vendorName = text_(row[3]);
    // 전표 키: 고유ID를 거래처명까지 자른 값(날짜·순번·거래처). 없으면 관리키+일+합계
    var slipBase = slipBaseId_(uniqueId, vendorName);
    var gkey = slipBase
      ? ("uid:" + slipBase)
      : (vkey + "|" + date + "|" + String(daily));
    var meta = receiptMetaFromRow_(row, stagingHeaders, displays[i] || []);
    if (!grouped[gkey]) {
      grouped[gkey] = {
        key: vkey,
        date: date,
        uniqueId: uniqueId,
        slipBase: slipBase,
        daily: daily,
        month: null,
        lines: 0,
        previousCredit: null,
        recoveryTotal: null,
        imageUrl: meta.imageUrl,
        imageVer: meta.imageVer
      };
    }
    var bucket = grouped[gkey];
    if (uniqueId && (!bucket.uniqueId || uniqueId < bucket.uniqueId)) bucket.uniqueId = uniqueId;
    bucket.lines += num_(row[11]);
    var month = moneyOrNull_(row[6]);
    if (month !== null) bucket.month = month;
    if (!bucket.imageUrl && meta.imageUrl) {
      bucket.imageUrl = meta.imageUrl;
      bucket.imageVer = meta.imageVer;
    }
    if (prevCreditCol >= 0) {
      var prevCredit = moneyOrNull_(row[prevCreditCol]);
      if (prevCredit !== null) bucket.previousCredit = prevCredit;
    }
    if (recoveryCol >= 0) {
      var recovery = moneyOrNull_(row[recoveryCol]);
      if (recovery !== null) bucket.recoveryTotal = recovery;
    }
  }

  var byVendor = {};
  Object.keys(grouped).forEach(function(gkey) {
    var b = grouped[gkey];
    if (!byVendor[b.key]) byVendor[b.key] = [];
    byVendor[b.key].push(b);
  });

  var built = [];
  Object.keys(allowed).sort(function(a, b) {
    return String(allowed[a]).localeCompare(String(allowed[b]), "ko");
  }).forEach(function(vkey) {
    if (!byVendor[vkey]) return;
    var liquor = isLiquorVendor_(allowed[vkey]);
    // 누적 계산은 반드시 거래일 순 (고유ID 우선이면 10/12가 11월 뒤로 밀려 기초가 틀어짐)
    var buckets = byVendor[vkey].slice().sort(function(a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var idA = text_(a.uniqueId) || "";
      var idB = text_(b.uniqueId) || "";
      if (idA !== idB) return idA < idB ? -1 : 1;
      return 0;
    });
    var previous = 0;
    var previousMonth = "";
    var prevMonthTotal = null;
    var cumSalesMonth = 0;
    var cumRecoveryMonth = 0;
    buckets.forEach(function(bucket) {
      var date = bucket.date;
      var amount = bucket.daily !== null ? bucket.daily : tidy_(bucket.lines);
      var recoveryAmt = 0;
      if (bucket.recoveryTotal !== null && bucket.recoveryTotal !== undefined && bucket.recoveryTotal !== "") {
        recoveryAmt = num_(bucket.recoveryTotal);
        if (recoveryAmt < 0) recoveryAmt = 0;
      }
      // 결제/조정: 시트에 사용자가 저장한 값 유지 (원재료입고에서는 읽지 않음)
      var savedList = saved[vkey + "|" + date] || [];
      var entered = null;
      for (var s = 0; s < savedList.length; s++) {
        if (savedList[s].payment === null || savedList[s].payment === undefined) continue;
        if (amountsMatch_(savedList[s].daily, bucket.daily)) {
          entered = savedList[s].payment;
          break;
        }
      }
      if (entered === null && savedList.length === 1 && bucket.daily === null) {
        entered = savedList[0].payment;
      }

      var settled;
      var currentMonth = date.slice(0, 7);
      if (previousMonth && currentMonth !== previousMonth) {
        cumSalesMonth = 0;
        cumRecoveryMonth = 0;
      }
      if (liquor) {
        cumSalesMonth = tidy_(cumSalesMonth + amount);
        cumRecoveryMonth = tidy_(cumRecoveryMonth + recoveryAmt);
        var monthNetCum = tidy_(cumSalesMonth - cumRecoveryMonth);
        var openingCredit = bucket.previousCredit;
        if (openingCredit === null) openingCredit = previous;
        settled = settleLiquorReceipt_(
          openingCredit,
          amount,
          bucket.month,
          entered,
          prevMonthTotal,
          bucket.recoveryTotal,
          monthNetCum
        );
      } else {
        var opening = previous;
        if (previousMonth && currentMonth !== previousMonth && amountsMatch_(bucket.month, amount)) opening = 0;
        settled = settleReceipt_(opening, amount, bucket.month, entered, prevMonthTotal);
      }
      previousMonth = currentMonth;
      previous = settled.carried;
      if (bucket.month !== null && bucket.month !== undefined && bucket.month !== "") {
        prevMonthTotal = bucket.month;
      }
      // 명세서금액=매출합계. 회수=뱃지/열. 당월누적계산(주류)=누적상품-누적회수
      var dailyOut = bucket.daily === null ? "" : bucket.daily;
      var recoveryOut = recoveryAmt > 0 ? recoveryAmt : "";
      built.push({
        vendor: allowed[vkey],
        date: date,
        uniqueId: text_(bucket.uniqueId) || date,
        row: [
          allowed[vkey],
          date,
          dailyOut,
          recoveryOut === "" ? "" : recoveryOut,
          settled.payment === null ? "" : settled.payment,
          bucket.month === null ? "" : bucket.month,
          settled.checkTotal,
          settled.status,
          bucket.imageUrl || "",
          bucket.imageVer || ""
        ]
      });
    });
  });

  built.sort(function(a, b) {
    if (a.vendor !== b.vendor) return String(a.vendor).localeCompare(String(b.vendor), "ko");
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.uniqueId !== b.uniqueId) return a.uniqueId < b.uniqueId ? -1 : 1;
    return 0;
  });
  var valuesOut = built.map(function(x) { return x.row; });

  balanceSheet.clearContents();
  balanceSheet.getRange(1, 1, 1, BALANCE_HEADERS_.length).setValues([BALANCE_HEADERS_]);
  if (valuesOut.length) {
    balanceSheet.getRange(2, 1, valuesOut.length, BALANCE_HEADERS_.length).setValues(valuesOut);
  }
  SpreadsheetApp.flush();
  var warnings = valuesOut.filter(function(r) { return r[7] !== "OK"; }).length;
  var statusCounts = {};
  valuesOut.forEach(function(r) {
    var st = String(r[7] || "");
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  });
  var detailBits = ["OK", "미수금 이월", "입금 재확인", "수금 재확인", "금액 불일치"].map(function(k) {
    return k + " " + (statusCounts[k] || 0) + "건";
  }).join(" · ");
  var rebuildAt = setBalanceRebuildAtNow_();
  return {
    ok: true,
    message: "완료되었습니다.\n검증대상 거래처 줄을 " + valuesOut.length + "건 넣었습니다.\n결제/조정은 기존 입력을 유지했습니다.\n이상 " + warnings + "건입니다.\n" + detailBits,
    warnCount: warnings,
    balanceRebuildAt: rebuildAt,
    version: APP_VERSION
  };
}

/** 미등록 목록에서 영구제외(IGNORE) 행 판별 — M코드 / N공식명 / Q상태 */
function isIgnoredUnregisteredRow_(row) {
  var code = text_(row[12]);
  var official = text_(row[13]);
  var status = text_(row[16]);
  var markers = { IGNORE: true, "영구제외": true };
  return !!(markers[code] || markers[official] || markers[status]);
}

/** 원재료관리 '등록구분' 열(0-based). 없으면 맨 오른쪽에 헤더 추가 */
function ensureCatalogRegStatusCol_() {
  var sheet = sheet_("원재료관리");
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (text_(headers[i]) === "등록구분") return i;
  }
  var col = lastCol + 1;
  sheet.getRange(1, col).setValue("등록구분");
  return col - 1;
}

/** 서울 시각 문자열 (변경일시 기록용) */
function changedAtNow_() {
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
}

/**
 * 시트 '변경일시' 열(0-based).
 * 없으면 '등록일시'를 변경일시로 승격, 둘 다 없으면 맨 오른쪽에 생성.
 */
function ensureChangedAtCol_(sheet) {
  if (!sheet) return -1;
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var changed = -1;
  var registered = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = text_(headers[i]);
    if (h === "변경일시") changed = i;
    if (h === "등록일시") registered = i;
  }
  if (changed >= 0) return changed;
  if (registered >= 0) {
    sheet.getRange(1, registered + 1).setValue("변경일시");
    SpreadsheetApp.flush();
    return registered;
  }
  var col = lastCol + 1;
  sheet.getRange(1, col).setValue("변경일시");
  SpreadsheetApp.flush();
  return col - 1;
}

/** 해당 시트 행에 변경일시 기록 (1-based row) */
function touchChangedAt_(sheet, rowNumber) {
  var row = Math.floor(Number(rowNumber) || 0);
  if (!sheet || row < 2) return;
  var col = ensureChangedAtCol_(sheet);
  if (col < 0) return;
  sheet.getRange(row, col + 1).setValue(changedAtNow_());
}

/** 등록구분: 대표 | 별칭 | 미등록 | 등록제외 (레거시 '등록' → 대표) */
function normalizeRegStatus_(value, hasCode) {
  var s = text_(value);
  if (s === "등록") return "대표";
  if (s === "대표" || s === "별칭" || s === "미등록" || s === "등록제외") return s;
  if (s === "IGNORE" || s === "영구제외") return "등록제외";
  return hasCode ? "대표" : "미등록";
}

function normalizeUnregNameKey_(name) {
  return text_(name).replace(/\s+/g, "").toLowerCase();
}

/** 괄호·대괄호 안 부가정보 제거 후 키 */
function normalizeUnregNameKeyLoose_(name) {
  return normalizeUnregNameKey_(
    String(name || "").replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")
  );
}

/** 품목명 느슨한 동일 여부 (축약명 ↔ 영수증 긴 이름) */
function unregNamesRelated_(a, b) {
  var ka = normalizeUnregNameKey_(a);
  var kb = normalizeUnregNameKey_(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length >= 4 && kb.indexOf(ka) >= 0) return true;
  if (kb.length >= 4 && ka.indexOf(kb) >= 0) return true;
  var la = normalizeUnregNameKeyLoose_(a);
  var lb = normalizeUnregNameKeyLoose_(b);
  if (la && lb && la === lb) return true;
  if (la.length >= 4 && lb.indexOf(la) >= 0) return true;
  if (lb.length >= 4 && la.indexOf(lb) >= 0) return true;
  // 동일 kg 무게 + 앞 토큰 공유 (예: 스테이크목살4.2kg ↔ 스테이크돼지갈비4.2kg…)
  var wa = String(a || "").match(/(\d+(?:\.\d+)?)\s*kg/ig);
  var wb = String(b || "").match(/(\d+(?:\.\d+)?)\s*kg/ig);
  if (wa && wb && wa.length && wb.length) {
    var waN = String(wa[wa.length - 1]).toLowerCase().replace(/\s+/g, "");
    var wbN = String(wb[wb.length - 1]).toLowerCase().replace(/\s+/g, "");
    if (waN === wbN) {
      var pa = la.replace(/[\d\.]+kg.*$/i, "");
      var pb = lb.replace(/[\d\.]+kg.*$/i, "");
      var pref = pa.length <= pb.length ? pa : pb;
      var longer = pa.length > pb.length ? pa : pb;
      if (pref.length >= 3 && longer.indexOf(pref.substring(0, Math.min(4, pref.length))) >= 0) return true;
    }
  }
  return false;
}

/**
 * 동일 영수증 URL의 입고 행에서 영수증명 찾기.
 * preferName 과 관련 있는 행 우선, 없으면 코드 비어 있는 첫 행.
 */
function findStagingReceiptNameByUrl_(receiptUrl, preferName) {
  var wantUrl = text_(receiptUrl);
  if (!wantUrl || wantUrl === "초기데이터없음") return "";
  var sheet = sheet_("원재료입고");
  var values = sheet.getDataRange().getValues();
  if (!values.length) return "";
  var headers = values[0].map(function(h) { return text_(h); });
  var urlCol = balanceHeaderIndex_(headers, RECEIPT_URL_HEADER_NAMES_, -1);
  if (urlCol < 0) return "";
  var codeCol = findStagingMappedCodeCol_(headers);
  var fallback = "";
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row || !String(row.join("")).trim()) continue;
    if (text_(row[urlCol]) !== wantUrl) continue;
    var nm = text_(row[7]);
    if (!nm) continue;
    if (preferName && unregNamesRelated_(preferName, nm)) return nm;
    if (!fallback && !text_(row[codeCol])) fallback = nm;
  }
  return fallback;
}

/**
 * 원재료입고(코드 없는 줄) → 원재료관리에 '미등록' 행으로 빠르게 동기화.
 * Gemini/OCR 호출 없음.
 */
function syncPendingUnregisteredToCatalog_(statusCol) {
  var catalog = sheet_("원재료관리");
  var catValues = catalog.getDataRange().getValues();
  var byKey = {};
  for (var c = 1; c < catValues.length; c++) {
    var crow = catValues[c];
    var cname = text_(crow[0]);
    if (!cname) continue;
    byKey[normalizeUnregNameKey_(cname)] = c + 1;
    String(crow[6] || "").split("|").forEach(function(alias) {
      var a = text_(alias);
      if (a) byKey[normalizeUnregNameKey_(a)] = c + 1;
    });
  }

  var staging = sheet_("원재료입고").getDataRange().getValues();
  var pendingNames = {};
  for (var i = 1; i < staging.length; i++) {
    var row = staging[i];
    if (!row || !String(row.join("")).trim()) continue;
    if (isIgnoredUnregisteredRow_(row)) continue;
    if (text_(row[12])) continue;
    var name = text_(row[7]);
    if (!name) continue;
    var key = normalizeUnregNameKey_(name);
    if (!pendingNames[key]) {
      pendingNames[key] = { name: name, unit: text_(row[8]) };
    } else if (!pendingNames[key].unit && text_(row[8])) {
      pendingNames[key].unit = text_(row[8]);
    }
  }

  var appended = 0;
  Object.keys(pendingNames).forEach(function(key) {
    if (byKey[key]) return;
    var p = pendingNames[key];
    var spec = p.unit || "";
    // A~H + 등록구분(I…)
    var newRow = ["", "", "", "", "", "", "", "", ""];
    newRow[0] = p.name;
    newRow[1] = ""; // 코드 없음 = 미등록 대기
    newRow[2] = spec;
    newRow[3] = 1;
    newRow[4] = "개";
    newRow[5] = "기타";
    newRow[6] = p.name;
    newRow[7] = "";
    while (newRow.length <= statusCol) newRow.push("");
    newRow[statusCol] = "미등록";
    catalog.appendRow(newRow);
    appended++;
  });
  if (appended) SpreadsheetApp.flush();
  return appended;
}

/** 등록 시 1회: 품목명으로 원재료입고에서 영수증위치·UPTIME 조회 */
function lookupStagingReceiptMetaByName_(receiptName) {
  var want = normalizeUnregNameKey_(receiptName);
  if (!want) return { imageUrl: "", imageVer: "" };
  var sheet = sheet_("원재료입고");
  var values = sheet.getDataRange().getValues();
  if (!values.length) return { imageUrl: "", imageVer: "" };
  var headers = values[0].map(function(h) { return text_(h); });
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row || !String(row.join("")).trim()) continue;
    if (normalizeUnregNameKey_(row[7]) !== want) continue;
    var meta = receiptMetaFromRow_(row, headers, null);
    if (meta.imageUrl) return meta;
  }
  return { imageUrl: "", imageVer: "" };
}

/** 코드 없는 입고 → 이름별 rows/단위/이미지 인덱스 (Gemini 없음) */
function buildUncodedStagingIndex_() {
  var sheet = sheet_("원재료입고");
  var range = sheet.getDataRange();
  var staging = range.getValues();
  var displays = range.getDisplayValues();
  var headers = staging.length ? staging[0].map(function(h) { return text_(h); }) : [];
  var map = {};
  for (var i = 1; i < staging.length; i++) {
    var row = staging[i];
    var disp = displays[i] || [];
    if (!row || !String(row.join("")).trim()) continue;
    if (isIgnoredUnregisteredRow_(row)) continue;
    if (text_(row[12])) continue;
    var name = text_(row[7]);
    if (!name) continue;
    var key = normalizeUnregNameKey_(name);
    var meta = receiptMetaFromRow_(row, headers, disp);
    if (!map[key]) {
      map[key] = {
        rows: [],
        units: {},
        count: 0,
        imageUrl: meta.imageUrl,
        imageVer: meta.imageVer
      };
    }
    map[key].count++;
    map[key].rows.push(i + 1);
    var unit = text_(row[8]);
    if (unit) map[key].units[unit] = true;
    if (!map[key].imageUrl && meta.imageUrl) {
      map[key].imageUrl = meta.imageUrl;
      map[key].imageVer = meta.imageVer;
    }
  }
  return map;
}

function formatMaterialCode_(prefix, num) {
  var seq = String(Math.floor(Number(num) || 0));
  while (seq.length < 3) seq = "0" + seq;
  return String(prefix || "M9") + seq;
}

function categoryPrefix_(category) {
  var cat = text_(category) || "기타";
  return CATEGORY_CODE_PREFIX_[cat] || "M9";
}

/** 구분별 다음 5자리 코드 (예: 공산품 최대 M8003 → M8004) */
function nextMaterialCode_(category, master) {
  var prefix = categoryPrefix_(category);
  var max = 0;
  Object.keys(master || {}).forEach(function(code) {
    if (String(code).indexOf(prefix) !== 0) return;
    var n = parseInt(String(code).slice(prefix.length), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  var next = max + 1;
  var candidate = formatMaterialCode_(prefix, next);
  while (master[candidate]) {
    next++;
    candidate = formatMaterialCode_(prefix, next);
  }
  return candidate;
}

function normalizeSuggestedCategory_(value) {
  var cat = text_(value);
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i] === cat) return cat;
  }
  return "기타";
}

/**
 * Gemini로 미등록 품목 추천
 * @param {Array<{name:string, units:string[]}>} items
 * @return {Object} name -> { category, spec, conversion, stockUnit }
 */
function suggestCategoriesWithGemini_(items) {
  var result = {};
  var list = [];
  for (var i0 = 0; i0 < (items || []).length; i0++) {
    var it0 = items[i0] || {};
    var nm0 = text_(it0.name);
    if (!nm0) continue;
    list.push({
      name: nm0,
      units: (it0.units || []).map(function(u) { return text_(u); }).filter(Boolean)
    });
  }
  if (!list.length) return result;
  var key = "";
  try {
    key = geminiApiKey_();
  } catch (e0) {
    key = "";
  }
  if (!key) return result;

  var allowed = CATEGORIES.join(", ");
  var prompt =
    "당신은 식당 원재료 마스터 데이터 작성 도우미입니다.\n" +
    "아래 품목(이름 + 영수증 규격/단위 힌트)을 보고 각 품목에 대해 JSON으로 답하세요.\n" +
    "허용 구분(category): " + allowed + "\n" +
    "각 항목 필드:\n" +
    "- name: 입력 품목명 그대로\n" +
    "- category: 위 허용 구분 중 하나\n" +
    "- spec: 입고단위/규격 문자열 (예: Box / Kg, 팩 / 30 개, 1박스=20개). 영수증 힌트를 우선 반영\n" +
    "- conversion: 재고수환산(순수 숫자). 입고 1단위가 재고 몇 단위인지. 모르면 1\n" +
    "- stockUnit: 재고단위 (예: kg, 개, 팩, g, L)\n" +
    "출력 형식(반드시 JSON 배열):\n" +
    "[{\"name\":\"품목명\",\"category\":\"구분\",\"spec\":\"입고단위/규격\",\"conversion\":1,\"stockUnit\":\"개\"}, ...]\n" +
    "입력:\n" + JSON.stringify(list);

  var body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
  };
  var models = (typeof OCR_GEMINI_MODELS_ !== "undefined" && OCR_GEMINI_MODELS_) || [
    "gemini-3.5-flash-lite",
    "gemini-flash-latest",
    "gemini-2.5-flash"
  ];

  for (var m = 0; m < models.length; m++) {
    var model = models[m];
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      model + ":generateContent?key=" + encodeURIComponent(key);
    try {
      var res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) continue;
      var json = JSON.parse(res.getContentText());
      var parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
      var raw = "";
      for (var p = 0; p < parts.length; p++) if (parts[p].text) raw += parts[p].text;
      raw = String(raw || "").trim()
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
      var parsed = JSON.parse(raw);
      if (!parsed) continue;
      var arr = parsed;
      if (parsed.items) arr = parsed.items;
      if (parsed.categories) arr = parsed.categories;
      if (!Array.isArray(arr)) continue;
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i] || {};
        var nm = text_(it.name || it.item || it.title);
        if (!nm) continue;
        var conv = moneyOrNull_ ? moneyOrNull_(it.conversion) : null;
        if (conv === null) {
          var n = Number(it.conversion);
          conv = isNaN(n) ? 1 : n;
        }
        if (!(conv > 0)) conv = 1;
        result[nm] = {
          category: normalizeSuggestedCategory_(it.category || it.구분 || it.cat),
          spec: text_(it.spec || it.unit || it.규격 || ""),
          conversion: conv,
          stockUnit: text_(it.stockUnit || it.stock_unit || it.재고단위 || "") || "개"
        };
      }
      if (Object.keys(result).length) return result;
    } catch (err) {
      // 다음 모델 시도
    }
  }
  return result;
}

/** 원재료입고 → 품목명키별 영수증위치/UPTIME 인덱스 (URL 있는 행만) */
function buildStagingReceiptMetaIndex_() {
  var byName = {};
  var staging;
  try {
    staging = sheet_("원재료입고").getDataRange().getValues();
  } catch (e0) {
    return byName;
  }
  if (!staging.length) return byName;
  var stHeaders = staging[0].map(function(h) { return text_(h); });
  var stUrlCol = stHeaders.indexOf("영수증위치");
  if (stUrlCol < 0) stUrlCol = 19;
  var stUpCol = stHeaders.indexOf("영수증UPTIME");
  var put_ = function(rawName, url, uptime) {
    var key = normalizeUnregNameKey_(rawName);
    if (!key || !url) return;
    byName[key] = { url: url, uptime: uptime || "" };
  };
  for (var s = 1; s < staging.length; s++) {
    var srow = staging[s];
    if (!srow || !String(srow.join("")).trim()) continue;
    var url = stUrlCol >= 0 && srow.length > stUrlCol ? text_(srow[stUrlCol]) : "";
    if (!url && srow.length > 19) url = text_(srow[19]);
    if (!url) continue;
    var uptime = stUpCol >= 0 && srow.length > stUpCol ? text_(srow[stUpCol]) : "";
    if (!uptime) uptime = receiptImageStamp_(srow, null);
    put_(srow[7], url, uptime);
    put_(srow[13], url, uptime);
  }
  return byName;
}

function isBlankReceiptUrl_(url) {
  var u = text_(url);
  return !u || u === "초기데이터없음";
}

/** 별칭 뱃지용 표시명 — 품목명 우선, 없으면 영수증별칭 좌측 */
function aliasDisplayLabel_(name, receiptAliasCell) {
  var n = text_(name);
  if (n) return n;
  var a = text_(receiptAliasCell);
  if (!a) return "";
  if (/➔|=>|→/.test(a)) {
    var left = text_(a.split(/➔|=>|→/)[0]);
    if (left) return left;
  }
  return a;
}

function pushUniqueAliasLabel_(arr, label) {
  var s = text_(label);
  if (!s) return;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === s) return;
  }
  arr.push(s);
}

/**
 * 원재료관리 → 화면용 groups (대표코드 FK)
 * - 대표: 원재료코드(B) 기준 1코드=1객체 (대표코드 무시)
 * - 별칭: 대표코드(FK)로 부모.aliases 에 품목명(A) push, 단독 리스트 금지
 * - 미등록·등록제외: 개별 객체
 */
function jobUnregisteredList(pin) {
  assertPin_(pin);
  var statusCol = ensureCatalogRegStatusCol_();
  var repCodeCol = ensureRepresentativeCodeCol_();
  var catalog = sheet_("원재료관리");
  var values = catalog.getDataRange().getValues();
  if (!values.length) {
    return { groups: [], materials: [], categories: CATEGORIES, version: APP_VERSION };
  }
  var headers = values[0].map(function(h) { return text_(h); });
  // 헤더 재탐색 (ensure 후 열 위치 변동 가능)
  statusCol = headers.indexOf("등록구분");
  if (statusCol < 0) statusCol = ensureCatalogRegStatusCol_();
  repCodeCol = -1;
  for (var rh = 0; rh < headers.length; rh++) {
    if (isParentRepCodeHeader_(headers[rh])) {
      if (headers[rh] === "부모대표코드" || repCodeCol < 0) repCodeCol = rh;
    }
  }
  if (repCodeCol < 0) repCodeCol = ensureRepresentativeCodeCol_();

  var urlCol = headers.indexOf("영수증위치");
  if (urlCol < 0) urlCol = balanceHeaderIndex_(headers, RECEIPT_URL_HEADER_NAMES_, -1);
  var upCol = headers.indexOf("영수증UPTIME");
  if (upCol < 0) upCol = balanceHeaderIndex_(headers, RECEIPT_UPTIME_HEADER_NAMES_, -1);
  if (urlCol < 0 || upCol < 0) {
    var cols = ensureReceiptMetaCols_(catalog, null, null);
    urlCol = cols.urlCol;
    upCol = cols.uptimeCol;
    values = catalog.getDataRange().getValues();
    headers = values[0].map(function(h) { return text_(h); });
    statusCol = headers.indexOf("등록구분");
    repCodeCol = -1;
    for (rh = 0; rh < headers.length; rh++) {
      if (isParentRepCodeHeader_(headers[rh])) {
        if (headers[rh] === "부모대표코드" || repCodeCol < 0) repCodeCol = rh;
      }
    }
  }

  var stagingMeta = buildStagingReceiptMetaIndex_();
  var sheetDirty = false;
  var rawRows = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var name = text_(row[0]);
    if (!name) continue;
    var code = text_(row[1]);
    var parentCode = repCodeCol >= 0 && row.length > repCodeCol ? text_(row[repCodeCol]) : "";
    var statusRaw = statusCol >= 0 && row.length > statusCol ? row[statusCol] : "";
    var regStatus = normalizeRegStatus_(statusRaw, !!code);
    var receiptUrl = urlCol >= 0 && row.length > urlCol ? text_(row[urlCol]) : "";
    var receiptUptime = upCol >= 0 && row.length > upCol ? text_(row[upCol]) : "";

    if (isBlankReceiptUrl_(receiptUrl)) {
      var hit = stagingMeta[normalizeUnregNameKey_(name)] || null;
      if (!hit) {
        String(row[6] || "").split("|").some(function(alias) {
          var akey = normalizeUnregNameKey_(alias);
          if (akey && stagingMeta[akey]) {
            hit = stagingMeta[akey];
            return true;
          }
          return false;
        });
      }
      if (hit && hit.url) {
        receiptUrl = hit.url;
        if (!receiptUptime) receiptUptime = hit.uptime || "";
        if (urlCol >= 0) {
          values[i][urlCol] = receiptUrl;
          sheetDirty = true;
        }
        if (upCol >= 0 && !text_(row[upCol]) && receiptUptime) {
          values[i][upCol] = receiptUptime;
          sheetDirty = true;
        }
      }
    } else if (!receiptUptime && upCol >= 0) {
      var hit2 = stagingMeta[normalizeUnregNameKey_(name)] || null;
      receiptUptime = (hit2 && hit2.uptime) || receiptUptimeNow_();
      values[i][upCol] = receiptUptime;
      sheetDirty = true;
    }

    var spec = text_(row[2]);
    var conversion = num_(row[3]);
    if (!(conversion > 0)) conversion = 1;
    var stockUnit = text_(row[4]) || "개";
    var category = normalizeSuggestedCategory_(row[5] || "기타");
    var receiptAlias = text_(row[6]);

    rawRows.push({
      sheetRow: i + 1,
      name: name,
      code: code,
      parentCode: parentCode,
      regStatus: regStatus,
      receiptAlias: receiptAlias,
      spec: spec,
      conversion: conversion,
      stockUnit: stockUnit,
      category: category,
      receiptUrl: isBlankReceiptUrl_(receiptUrl) ? "" : receiptUrl,
      receiptUptime: receiptUptime
    });
  }

  if (sheetDirty) {
    catalog.getRange(1, 1, values.length, values[0].length).setValues(values);
    SpreadsheetApp.flush();
  }

  // 1) 대표만 — 원재료코드 기준 1객체 (대표코드 무시)
  var byCode = {};
  var list = [];
  var materials = [];
  for (var r = 0; r < rawRows.length; r++) {
    var it = rawRows[r];
    if (it.regStatus !== "대표" || !it.code) continue;
    if (byCode[it.code]) continue;
    var item = {
      key: "c" + it.sheetRow,
      sheetRow: it.sheetRow,
      name: it.name,
      code: it.code,
      parentCode: "",
      regStatus: "대표",
      aliases: [],
      count: 0,
      rows: [],
      units: it.spec ? [it.spec] : [],
      imageUrl: it.receiptUrl,
      imageVer: it.receiptUptime,
      receiptUrl: it.receiptUrl,
      receiptUptime: it.receiptUptime,
      suggestedCategory: it.category,
      suggestedSpec: it.spec,
      suggestedConversion: it.conversion,
      suggestedStockUnit: it.stockUnit
    };
    aliasTokensFromCell_(it.receiptAlias, it.name).forEach(function(lab) {
      pushUniqueAliasLabel_(item.aliases, lab);
    });
    byCode[it.code] = item;
    list.push(item);
    materials.push({ code: it.code, name: it.name, category: it.category });
  }

  // 2) 별칭 — 부모 aliases 뱃지용 push + 단독 리스트 행으로도 포함 (전체/별칭 조회)
  for (var a = 0; a < rawRows.length; a++) {
    var al = rawRows[a];
    if (al.regStatus !== "별칭") continue;
    var fk = aliasForeignKey_(al.parentCode, al.code);
    var parent = fk ? byCode[fk] : null;
    if (parent) {
      pushUniqueAliasLabel_(parent.aliases, aliasDisplayLabel_(al.name, al.receiptAlias));
    }
    list.push({
      key: "c" + al.sheetRow,
      sheetRow: al.sheetRow,
      name: al.name,
      code: "", // 별칭은 B 비움
      parentCode: fk || "",
      regStatus: "별칭",
      aliases: [],
      count: 0,
      rows: [],
      units: al.spec ? [al.spec] : [],
      imageUrl: al.receiptUrl,
      imageVer: al.receiptUptime,
      receiptUrl: al.receiptUrl,
      receiptUptime: al.receiptUptime,
      suggestedCategory: al.category,
      suggestedSpec: al.spec,
      suggestedConversion: al.conversion,
      suggestedStockUnit: al.stockUnit
    });
  }

  // 3) 미등록·등록제외
  for (var u = 0; u < rawRows.length; u++) {
    var un = rawRows[u];
    if (un.regStatus === "대표" || un.regStatus === "별칭") continue;
    list.push({
      key: "c" + un.sheetRow,
      sheetRow: un.sheetRow,
      name: un.name,
      code: un.code || "",
      parentCode: un.parentCode || "",
      regStatus: un.regStatus,
      aliases: [],
      count: 0,
      rows: [],
      units: un.spec ? [un.spec] : [],
      imageUrl: un.receiptUrl,
      imageVer: un.receiptUptime,
      receiptUrl: un.receiptUrl,
      receiptUptime: un.receiptUptime,
      suggestedCategory: un.category,
      suggestedSpec: un.spec,
      suggestedConversion: un.conversion,
      suggestedStockUnit: un.stockUnit
    });
  }

  // 정렬: 유효코드(원재료코드 또는 대표코드) 오름차순 → 대표 먼저 → 이름
  list.sort(function(a, b) {
    var ca = text_(a.code) || text_(a.parentCode);
    var cb = text_(b.code) || text_(b.parentCode);
    if (!ca && !cb) return String(a.name || "").localeCompare(String(b.name || ""), "ko");
    if (!ca) return 1;
    if (!cb) return -1;
    var cmp = ca.localeCompare(cb, "ko", { numeric: true, sensitivity: "base" });
    if (cmp !== 0) return cmp;
    if (a.regStatus === "대표" && b.regStatus !== "대표") return -1;
    if (b.regStatus === "대표" && a.regStatus !== "대표") return 1;
    return String(a.name || "").localeCompare(String(b.name || ""), "ko");
  });
  materials.sort(function(a, b) {
    return String(a.name).localeCompare(String(b.name), "ko");
  });

  return {
    groups: list,
    materials: materials,
    categories: CATEGORIES,
    version: APP_VERSION
  };
}

/** 원재료관리에서 코드+등록구분=대표 인 단 하나의 행 번호(1-based). 없으면 0 */
function findRepresentativeSheetRow_(catalog, statusCol, code) {
  var want = text_(code);
  if (!want) return 0;
  var values = catalog.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (text_(values[i][1]) !== want) continue;
    var st = normalizeRegStatus_(statusCol >= 0 && values[i].length > statusCol ? values[i][statusCol] : "", true);
    if (st === "대표") return i + 1;
  }
  return 0;
}

/** 원재료입고 매핑 코드 열(0-based). 헤더 우선, 없으면 M열(12) */
function findStagingMappedCodeCol_(headers) {
  var names = [
    "🔗 원재료 코드 (AI매핑)",
    "원재료 코드 (AI매핑)",
    "AI매핑",
    "원재료코드"
  ];
  for (var n = 0; n < names.length; n++) {
    var idx = headers.indexOf(names[n]);
    if (idx >= 0) return idx;
  }
  return 12;
}

/** 원재료입고 공식 품목명 열(0-based). 헤더 우선, 없으면 N열(13) */
function findStagingOfficialCol_(headers) {
  var names = [
    "공식 품목명 (AI매핑)",
    "공식품목명 (AI매핑)",
    "공식 품목명",
    "공식품목명",
    "공식명"
  ];
  for (var n = 0; n < names.length; n++) {
    var idx = headers.indexOf(names[n]);
    if (idx >= 0) return idx;
  }
  return 13;
}

/**
 * 입고 행 매칭
 * opts: { receiptName, altNames[], receiptUrl, oldCode, matchEmptyOnly, nameOnly, includeIgnored }
 * - altNames: 원재료명·영수증별칭 등 추가 매칭 키
 * - nameOnly: 품목명(+URL) 매칭 (별칭 Cascade)
 */
function stagingRowMatchesCascade_(row, headers, opts) {
  opts = opts || {};
  if (!row || !String(row.join("")).trim()) return false;
  var codeCol = findStagingMappedCodeCol_(headers);
  var urlCol = balanceHeaderIndex_(headers, RECEIPT_URL_HEADER_NAMES_, -1);
  var nameCol = 7;
  var existing = text_(row[codeCol]);
  // 등록제외→미등록 Clear 시에만 IGNORE/영구제외 행도 매칭
  if (!opts.includeIgnored) {
    if (isIgnoredUnregisteredRow_(row)) return false;
    if (existing === "IGNORE") return false;
  }
  var oldCode = text_(opts.oldCode);
  var rowName = text_(row[nameCol]);
  var nameKeys = [];
  function pushNameKey_(raw) {
    var k = normalizeUnregNameKey_(raw);
    if (k && nameKeys.indexOf(k) < 0) nameKeys.push(k);
  }
  pushNameKey_(opts.receiptName);
  var alts = opts.altNames || [];
  for (var ai = 0; ai < alts.length; ai++) pushNameKey_(alts[ai]);

  function nameHit_() {
    if (!nameKeys.length) return false;
    var rk = normalizeUnregNameKey_(rowName);
    if (nameKeys.indexOf(rk) >= 0) return true;
    for (var i = 0; i < nameKeys.length; i++) {
      if (unregNamesRelated_(nameKeys[i], rowName)) return true;
    }
    return false;
  }

  function urlOk_() {
    var wantUrl = text_(opts.receiptUrl);
    if (!wantUrl || urlCol < 0 || row.length <= urlCol) return true;
    var rowUrl = text_(row[urlCol]);
    if (!rowUrl || rowUrl === "초기데이터없음") return true;
    return rowUrl === wantUrl;
  }

  function nameUrlOk_() {
    if (!nameHit_()) return false;
    return urlOk_();
  }

  if (opts.nameOnly) {
    if (!nameUrlOk_()) return false;
    return true;
  }
  if (oldCode && existing === oldCode) return true;
  if (oldCode && existing && canonicalMaterialCode_(existing) === canonicalMaterialCode_(oldCode)) return true;
  if (!nameUrlOk_()) return false;
  if (opts.matchEmptyOnly && existing && existing !== oldCode) return false;
  return true;
}

/**
 * 입고 Cascade: clear=true 이면 코드·공식명 삭제, 아니면 새 마스터로 덮어쓰기.
 * oldCode 가 있으면 해당 코드로 매핑된 행도 포함.
 */
function cascadeStagingMapping_(opts) {
  opts = opts || {};
  var staging = sheet_("원재료입고");
  var values = staging.getDataRange().getValues();
  if (!values.length) return 0;
  var headers = values[0].map(function(h) { return text_(h); });
  var codeCol = findStagingMappedCodeCol_(headers);
  var officialCol = findStagingOfficialCol_(headers);
  var qtyCol = 14;
  var touched = 0;
  var newCode = text_(opts.newCode);
  var newOfficial = text_(opts.newOfficial);
  var master = opts.master || {};
  var clear = !!opts.clear;

  for (var s = 1; s < values.length; s++) {
    var row = values[s];
    if (!stagingRowMatchesCascade_(row, headers, {
      receiptName: opts.receiptName,
      receiptUrl: opts.receiptUrl,
      oldCode: opts.oldCode,
      matchEmptyOnly: !opts.oldCode && !clear,
      nameOnly: !!opts.nameOnly,
      includeIgnored: !!opts.includeIgnored
    })) continue;

    if (clear) {
      staging.getRange(s + 1, codeCol + 1).setValue("");
      staging.getRange(s + 1, officialCol + 1).setValue("");
      if (opts.includeIgnored) {
        // 등록제외→미등록: Q상태 영구제외도 해제
        try { staging.getRange(s + 1, 17).setValue(""); } catch (eClr) {}
      }
      touchChangedAt_(staging, s + 1);
      touched++;
      continue;
    }
    if (!newCode) continue;
    var qtyCode = text_(opts.qtyCode) || canonicalMaterialCode_(newCode);
    staging.getRange(s + 1, codeCol + 1).setValue(newCode);
    staging.getRange(s + 1, officialCol + 1).setValue(
      newOfficial || (master[qtyCode] && master[qtyCode].name) || newCode
    );
    var finalQty = reflectedQuantity_(master, qtyCode, row[8], row[9]);
    if (finalQty === null) finalQty = num_(row[9]);
    staging.getRange(s + 1, qtyCol + 1).setValue(finalQty);
    touchChangedAt_(staging, s + 1);
    touched++;
  }
  return touched;
}

/** create 성공 후 원재료입고에 대표 코드·공식명 기록 */
function syncStagingMappedCode_(receiptName, receiptUrl, masterCode, officialName, master) {
  return cascadeStagingMapping_({
    receiptName: receiptName,
    receiptUrl: receiptUrl,
    newCode: masterCode,
    newOfficial: officialName,
    master: master,
    clear: false,
    oldCode: ""
  });
}

/**
 * link(별칭) 후 입고: 코드=부모대표코드, 공식명=대표 원재료명 (시트 정본)
 * altNames: 원재료명·영수증별칭 등 (축약명↔긴 영수증명 매칭용)
 */
function syncStagingAliasMappedCode_(receiptName, receiptUrl, parentCode, aliasName, master, altNames) {
  var parent = canonicalMaterialCode_(parentCode);
  var parentOfficial = (master[parent] && master[parent].name) || parent;
  return cascadeStagingMapping_({
    receiptName: receiptName || aliasName,
    altNames: altNames || [],
    receiptUrl: receiptUrl,
    newCode: parent,
    newOfficial: parentOfficial,
    master: master,
    clear: false,
    nameOnly: true,
    qtyCode: parent,
    oldCode: parent
  });
}

/**
 * 미등록 강등 시 입고 매핑 Clear
 * - fromAlias=false(대표): oldCode로 매핑된 입고 전부 + 동일 품목명
 * - fromAlias=true(별칭): 해당 품목명 행만 Clear (부모 대표 코드 전체는 건드리지 않음)
 */
function clearStagingMappedCode_(receiptName, receiptUrl, oldCode, nameOnlyClear) {
  return cascadeStagingMapping_({
    receiptName: receiptName,
    receiptUrl: receiptUrl,
    oldCode: nameOnlyClear ? "" : oldCode,
    clear: true,
    nameOnly: !!nameOnlyClear,
    includeIgnored: !!nameOnlyClear
  });
}

/**
 * 등록제외 — 원재료관리 등록구분=등록제외 + 관련 입고 IGNORE
 * body.items: [{ sheetRow, name, rows }] 또는 body.rows + receiptName (하위호환)
 */
function jobIgnoreUnregistered(pin, body) {
  assertPin_(pin);
  body = body || {};
  var statusCol = ensureCatalogRegStatusCol_();
  var repCodeCol = ensureRepresentativeCodeCol_();
  var catalog = sheet_("원재료관리");
  var staging = sheet_("원재료입고");
  var stagingValues = staging.getDataRange().getValues();
  var items = body.items || [];
  if (!items.length && (body.rows || []).length) {
    items = [{ sheetRow: body.sheetRow, name: body.receiptName || body.name, rows: body.rows }];
  }
  if (!items.length) throw new Error("제외할 항목이 없습니다.");

  var ignoredStaging = 0;
  var excludedCatalog = 0;

  for (var t = 0; t < items.length; t++) {
    var it = items[t] || {};
    var sheetRow = Math.floor(Number(it.sheetRow) || 0);
    if (sheetRow >= 2) {
      catalog.getRange(sheetRow, 2).setValue(""); // B 원재료코드
      if (repCodeCol >= 0) catalog.getRange(sheetRow, repCodeCol + 1).setValue("");
      catalog.getRange(sheetRow, statusCol + 1).setValue("등록제외");
      touchChangedAt_(catalog, sheetRow);
      excludedCatalog++;
    }
    var rowNumbers = it.rows || [];
    var receiptName = text_(it.name || it.receiptName || "");
    if (!rowNumbers.length && receiptName) {
      var want = normalizeUnregNameKey_(receiptName);
      var stHeaders = stagingValues.length ? stagingValues[0].map(function(h) { return text_(h); }) : [];
      var stCodeCol = findStagingMappedCodeCol_(stHeaders);
      for (var s = 1; s < stagingValues.length; s++) {
        var srow = stagingValues[s];
        if (isIgnoredUnregisteredRow_(srow)) continue;
        if (normalizeUnregNameKey_(srow[7]) === want) rowNumbers.push(s + 1);
      }
    }
    var stHeaders2 = stagingValues.length ? stagingValues[0].map(function(h) { return text_(h); }) : [];
    var stCodeCol2 = findStagingMappedCodeCol_(stHeaders2);
    var stOfficialCol2 = findStagingOfficialCol_(stHeaders2);
    for (var i = 0; i < rowNumbers.length; i++) {
      var rowNumber = Math.floor(Number(rowNumbers[i]));
      if (rowNumber < 2 || rowNumber > stagingValues.length) continue;
      var row = stagingValues[rowNumber - 1];
      if (isIgnoredUnregisteredRow_(row)) continue;
      staging.getRange(rowNumber, stCodeCol2 + 1).setValue("IGNORE");
      staging.getRange(rowNumber, stOfficialCol2 + 1).setValue("영구제외");
      staging.getRange(rowNumber, 17).setValue("영구제외");
      touchChangedAt_(staging, rowNumber);
      ignoredStaging++;
    }
  }
  SpreadsheetApp.flush();
  return {
    ok: true,
    ignored: ignoredStaging,
    excluded: excludedCatalog,
    message: "등록제외 " + excludedCatalog + "종 · 입고 IGNORE " + ignoredStaging + "건",
    version: APP_VERSION
  };
}

/** 미등록 일괄 등록 — items: [{mode,receiptName,rows,code,name,category}] */
function jobRegisterUnregisteredBatch(pin, body) {
  assertPin_(pin);
  body = body || {};
  var items = body.items || [];
  if (!items.length) throw new Error("저장할 항목이 없습니다.");
  var ok = 0;
  var fail = 0;
  var messages = [];
  for (var i = 0; i < items.length; i++) {
    try {
      var one = jobRegisterUnregistered(pin, items[i]);
      ok++;
      if (one && one.message) messages.push(one.message.split("\n")[0]);
    } catch (err) {
      fail++;
      messages.push((items[i] && items[i].receiptName ? items[i].receiptName : "항목") + ": " + (err.message || err));
    }
  }
  return {
    ok: fail === 0,
    saved: ok,
    failed: fail,
    message: "일괄 저장 완료 " + ok + "건" + (fail ? (", 실패 " + fail + "건") : "") + (messages.length ? ("\n" + messages.slice(0, 5).join("\n")) : ""),
    version: APP_VERSION
  };
}

/**
 * 원재료 코드 관리 저장 (대표코드 FK)
 * - update / create / link
 * - downgrade_unreg: 대표|별칭→미등록 (B·FK 클리어 + 입고 매핑 Clear)
 * - 대표→별칭 직행 금지: 반드시 미등록 경유 후 link
 */
function jobRegisterUnregistered(pin, body) {
  assertPin_(pin);
  body = body || {};
  var mode = String(body.mode || "create");
  if (mode === "신규") mode = "create";
  if (mode === "기존") mode = "link";
  if (mode === "수정") mode = "update";

  var receiptName = text_(body.receiptName);
  var rowNumbers = body.rows || [];
  var code = text_(body.code);
  var previousCode = text_(body.previousCode);
  var parentCode = text_(body.parentCode || body.code);
  var name = text_(body.name);
  var wantStatus = normalizeRegStatus_(body.regStatus || "", !!code);
  var category = normalizeSuggestedCategory_(body.category || "기타");
  var spec = text_(body.spec);
  var conversion = moneyOrNull_(body.conversion);
  if (conversion === null) conversion = num_(body.conversion);
  if (!(conversion > 0)) conversion = 1;
  var stockUnit = text_(body.stockUnit) || "개";

  var catalog = sheet_("원재료관리");
  var statusCol = ensureCatalogRegStatusCol_();
  var repCodeCol = ensureRepresentativeCodeCol_();
  var metaCols = ensureReceiptMetaCols_(catalog, null, null);
  var master = materialMaster_();
  var official = "";
  var saveStatus = "대표";
  var registeredAt = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
  var catalogRow = Math.floor(Number(body.sheetRow) || 0);
  var receiptUrl = text_(body.receiptUrl || body.imageUrl || "");
  var receiptUptime = text_(body.receiptUptime || body.imageVer || "");
  if (!receiptUrl && receiptName) {
    var looked = lookupStagingReceiptMetaByName_(receiptName);
    if (looked.imageUrl) {
      receiptUrl = looked.imageUrl;
      if (!receiptUptime) receiptUptime = looked.imageVer || "";
    }
  }
  if (!receiptUptime) receiptUptime = receiptUptimeNow_();

  function extractCode_(raw) {
    var m = String(raw || "").match(/\b(M\d{4,})\b/i);
    return m ? m[1].toUpperCase() : text_(raw);
  }

  // 대표 → 별칭 직행 금지 (프론트·레거시 모두)
  if (mode === "downgrade_alias") {
    throw new Error("대표 → 별칭은 한 번에 할 수 없습니다. 먼저 미등록으로 저장한 뒤, 다시 별칭으로 연결하세요.");
  }
  var prevStatusHint = normalizeRegStatus_(body.prevStatus || "", !!(previousCode || code));
  if (wantStatus === "별칭" && prevStatusHint === "대표") {
    throw new Error("대표 → 별칭은 한 번에 할 수 없습니다. 먼저 미등록으로 저장한 뒤, 다시 별칭으로 연결하세요.");
  }

  // 강등 모드 유지. 그 외 기존 분기
  if (mode !== "downgrade_unreg") {
    if (mode === "update" || (mode !== "link" && mode !== "create" && code)) {
      mode = "update";
    }
    if (mode === "create" && extractCode_(code)) {
      mode = "update";
    }
    // 대표/별칭 → 미등록 요청이면 강등 모드로 승격 (sheetRow 또는 코드 기준)
    if (wantStatus === "미등록" && (previousCode || code || catalogRow >= 2 || text_(body.prevStatus))) {
      var ps = normalizeRegStatus_(body.prevStatus || "", !!(previousCode || code));
      if (ps === "대표" || ps === "별칭" || previousCode || (mode === "update" && code)) {
        mode = "downgrade_unreg";
        if (!previousCode) previousCode = extractCode_(code || parentCode);
      }
    }
  }

  var linked = 0;

  if (mode === "downgrade_unreg") {
    previousCode = extractCode_(previousCode || code || parentCode);
    var prevStatusIn = normalizeRegStatus_(body.prevStatus || "", !!previousCode);
    // sheetRow 우선 (별칭 행은 B가 비어 있어 코드로 찾을 수 없음)
    var rowU = catalogRow >= 2 ? catalogRow : 0;
    if (rowU < 2 && previousCode) {
      rowU = findRepresentativeSheetRow_(catalog, statusCol, previousCode);
    }
    if (rowU < 2) throw new Error("미등록으로 바꿀 원재료관리 행을 찾을 수 없습니다.");
    catalogRow = rowU;

    // 전환 전 시트 상태 확인
    var beforeCode = text_(catalog.getRange(catalogRow, 2).getValue());
    var beforeParent = repCodeCol >= 0 ? text_(catalog.getRange(catalogRow, repCodeCol + 1).getValue()) : "";
    var beforeStatus = normalizeRegStatus_(
      statusCol >= 0 ? catalog.getRange(catalogRow, statusCol + 1).getValue() : "",
      !!beforeCode
    );
    var fromAlias = prevStatusIn === "별칭" || beforeStatus === "별칭" || (!beforeCode && !!beforeParent);
    var fromExclude = prevStatusIn === "등록제외" || beforeStatus === "등록제외";
    var mappedCode = beforeCode || beforeParent || previousCode;

    official = name || text_(catalog.getRange(catalogRow, 1).getValue()) || receiptName || mappedCode || "";
    // 원재료관리: B·부모대표코드 비움, 등록구분=미등록
    catalog.getRange(catalogRow, 2).setValue("");
    if (repCodeCol >= 0) catalog.getRange(catalogRow, repCodeCol + 1).setValue("");
    catalog.getRange(catalogRow, statusCol + 1).setValue("미등록");
    if (official) catalog.getRange(catalogRow, 1).setValue(official);
    saveStatus = "미등록";
    // 원재료입고 Cascade Clear (별칭·등록제외는 동명만)
    linked = clearStagingMappedCode_(receiptName || official, receiptUrl, mappedCode, fromAlias || fromExclude);
    code = "";
  } else if (mode === "update") {
    code = extractCode_(code);
    if (!code) throw new Error("수정할 원재료코드가 없습니다.");
    var repRow = findRepresentativeSheetRow_(catalog, statusCol, code);
    if (!repRow && master[code]) repRow = master[code].sheetRow;
    if (!repRow) throw new Error(code + " 대표 원재료가 없습니다.");
    catalogRow = repRow;
    official = name || (master[code] && master[code].name) || receiptName || code;
    if (!official) throw new Error("원재료명을 입력해 주세요.");
    catalog.getRange(catalogRow, 1, 1, 6).setValues([[
      official, code, spec, conversion, stockUnit, category
    ]]);
    catalog.getRange(catalogRow, statusCol + 1).setValue("대표");
    if (repCodeCol >= 0) catalog.getRange(catalogRow, repCodeCol + 1).setValue(""); // 대표코드 빈칸 유지
    saveStatus = "대표";
    master[code] = {
      name: official,
      conversion: conversion,
      category: category,
      aliases: (master[code] && master[code].aliases) || [],
      sheetRow: catalogRow,
      regStatus: "대표"
    };
  } else if (mode === "link") {
    code = extractCode_(code); // 사용자가 고른 마스터(대표) 코드
    if (!code) throw new Error("연결할 원재료코드를 입력해 주세요.");
    var info = master[code];
    if (!info) throw new Error(code + " 원재료가 없습니다.");
    official = info.name || code;
    category = info.category || category;
    conversion = info.conversion > 0 ? info.conversion : conversion;
    stockUnit = info.stockUnit || stockUnit;
    if (!spec) spec = info.spec || "";
    saveStatus = "별칭";
    if (catalogRow < 2) throw new Error("연결할 원재료관리 행이 없습니다.");
    var curName = name || text_(catalog.getRange(catalogRow, 1).getValue()) || receiptName || official;
    // 영수증별칭(G): 기존값·영수증명 보존 (원재료명으로 덮어쓰지 않음)
    var prevG = text_(catalog.getRange(catalogRow, 7).getValue());
    var aliasReceiptName = prevG || receiptName || "";
    if (!aliasReceiptName || normalizeUnregNameKey_(aliasReceiptName) === normalizeUnregNameKey_(curName)) {
      // G가 비었거나 A와 같으면, 입고에서 URL로 원본 영수증명 보강
      if (receiptUrl) {
        var stHit = findStagingReceiptNameByUrl_(receiptUrl, curName);
        if (stHit) aliasReceiptName = stHit;
      }
    }
    if (!aliasReceiptName) aliasReceiptName = curName;
    // B 비움 + 부모대표코드=FK + 등록구분=별칭
    catalog.getRange(catalogRow, 1, 1, 6).setValues([[
      curName, "", info.spec || spec, conversion, info.stockUnit || stockUnit, category
    ]]);
    catalog.getRange(catalogRow, 7).setValue(aliasReceiptName);
    catalog.getRange(catalogRow, statusCol + 1).setValue("별칭");
    catalog.getRange(catalogRow, repCodeCol + 1).setValue(code);
    official = curName;
    // 입고: 코드=부모대표코드, 공식명=대표 원재료명 (A·G·receiptName으로 매칭)
    linked = syncStagingAliasMappedCode_(
      aliasReceiptName,
      receiptUrl,
      code,
      curName,
      master,
      [curName, aliasReceiptName, receiptName, prevG]
    );
  } else {
    // create → 신규 대표
    official = name || receiptName;
    if (!official) throw new Error("원재료명을 입력해 주세요.");
    code = nextMaterialCode_(category, master);
    saveStatus = "대표";
    if (catalogRow >= 2) {
      catalog.getRange(catalogRow, 1, 1, 8).setValues([[
        official, code, spec, conversion, stockUnit, category, receiptName || official, registeredAt
      ]]);
      catalog.getRange(catalogRow, statusCol + 1).setValue("대표");
      if (repCodeCol >= 0) catalog.getRange(catalogRow, repCodeCol + 1).setValue("");
    } else {
      var newRow = [official, code, spec, conversion, stockUnit, category, receiptName || official, registeredAt];
      while (newRow.length <= Math.max(statusCol, repCodeCol)) newRow.push("");
      newRow[statusCol] = "대표";
      if (repCodeCol >= 0) newRow[repCodeCol] = "";
      catalog.appendRow(newRow);
      catalogRow = catalog.getLastRow();
    }
    master[code] = {
      name: official,
      conversion: conversion,
      category: category,
      aliases: receiptName ? [receiptName] : [],
      sheetRow: catalogRow,
      regStatus: "대표"
    };
    linked = syncStagingMappedCode_(receiptName || official, receiptUrl, code, official, master);
  }

  if (catalogRow >= 2) {
    if (receiptUrl) catalog.getRange(catalogRow, metaCols.urlCol + 1).setValue(receiptUrl);
    catalog.getRange(catalogRow, metaCols.uptimeCol + 1).setValue(receiptUptime);
    touchChangedAt_(catalog, catalogRow);
  }

  // rows 가 명시된 경우(하위호환) — create/link 에서 추가 동기화
  if ((mode === "create" || mode === "link") && rowNumbers && rowNumbers.length) {
    var staging = sheet_("원재료입고");
    var stValues = staging.getDataRange().getValues();
    var stHeaders = stValues.length ? stValues[0].map(function(h) { return text_(h); }) : [];
    var stCodeCol = findStagingMappedCodeCol_(stHeaders);
    var writeCode = code;
    var stagingOfficial = mode === "link"
      ? ((master[code] && master[code].name) || code)
      : ((master[code] && master[code].name) || official);
    var qtyParent = canonicalMaterialCode_(code);
    for (var i = 0; i < rowNumbers.length; i++) {
      var rowNumber = Math.floor(Number(rowNumbers[i]));
      if (rowNumber < 2 || rowNumber > stValues.length) continue;
      var row = stValues[rowNumber - 1];
      if (isIgnoredUnregisteredRow_(row)) continue;
      var existing = text_(row[stCodeCol]);
      if (existing && existing !== "IGNORE" && canonicalMaterialCode_(existing) !== qtyParent) continue;
      var finalQty = reflectedQuantity_(master, qtyParent, row[8], row[9]);
      if (finalQty === null) finalQty = num_(row[9]);
      staging.getRange(rowNumber, stCodeCol + 1).setValue(writeCode);
      staging.getRange(rowNumber, 14).setValue(stagingOfficial);
      staging.getRange(rowNumber, 15).setValue(finalQty);
      touchChangedAt_(staging, rowNumber);
      linked++;
    }
  }

  SpreadsheetApp.flush();
  var message;
  if (mode === "downgrade_unreg") {
    message = official + " 을 미등록으로 강등했습니다. 입고 매핑 해제 " + linked + "건";
  } else if (mode === "update") {
    message = code + " " + official + " 대표 정보를 수정 저장했습니다.";
  } else if (mode === "link") {
    message = official + " 을 " + code + " 별칭(부모대표코드)으로 연결했습니다.\n입고 매핑 " + linked + "건";
  } else {
    message = code + " " + official + " 을 대표로 등록했습니다. (등록일시 " + registeredAt + ")\n입고 매핑 " + linked + "건";
  }
  if (mode !== "update" && mode !== "downgrade_unreg") {
    message += "\n재고 수량은 실시간 재고 계산을 누를 때 합산됩니다.";
  }
  return {
    ok: true,
    message: message,
    linked: linked,
    code: code,
    category: category,
    regStatus: saveStatus,
    version: APP_VERSION
  };
}

/**
 * POS A열 표시 문자열. Date는 시각이 있으면 일시, 없으면 일자만.
 * (text_는 Date를 항상 yyyy-MM-dd로만 바꿔 구형 행을 신규로 오인함)
 */
function posCellAText_(displayRow, row) {
  if (displayRow && displayRow[0] != null && String(displayRow[0]).trim() !== "") {
    return String(displayRow[0]).trim();
  }
  var v = row && row[0];
  var d = asDate_(v);
  if (d) {
    var hasTime = d.getHours() || d.getMinutes() || d.getSeconds();
    return Utilities.formatDate(d, "Asia/Seoul", hasTime ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd");
  }
  return text_(v);
}

/** 판매시간 라벨(12시) → 시(0~23). 없으면 null */
function posHourFromText_(text) {
  var raw = String(text || "").trim();
  var m = raw.match(/^(\d{1,2})\s*시$/);
  if (m) return Number(m[1]);
  var m2 = raw.match(/(\d{1,2})\s*시/);
  if (m2) return Number(m2[1]);
  var m3 = raw.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (m3) return Number(m3[1]);
  return null;
}

/** 신규 스키마 행: A=YYYY-MM-DD, C=상품명, D=수량 (B=판매시간 또는 판매일시) */
function isPosNewSchemaRow_(row, aText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(aText || "").trim())) return false;
  if (!row || row.length < 4) return false;
  var name = text_(row[2]);
  if (!name) return false;
  var qtyText = text_(row[3]);
  // 구형: A일시·B상품·C수량·D빈칸 → C가 숫자인데 D가 비면 구형으로 본다
  if (qtyText === "" && /^-?\d+(\.\d+)?$/.test(String(name).replace(/,/g, ""))) return false;
  return true;
}

/**
 * POS 판매내역 한 행 파싱
 * 현재: A 판매일자 · B 판매시간(12시) · C 상품명 · D 수량
 * 구형: A 판매일시 · B 상품명 · C 수량  /  또는 B가 판매일시 문자열
 */
function parsePosSalesRow_(row, displayRow, colMap) {
  if (!row || !String(row.join("")).trim()) return null;
  var aRaw = posCellAText_(displayRow, row);
  var d0 = displayRow && displayRow[0] != null ? displayRow[0] : row[0];
  var d1 = displayRow && displayRow[1] != null ? displayRow[1] : row[1];
  var bDisp = displayRow && displayRow[1] != null ? String(displayRow[1]).trim() : String(row[1] != null ? row[1] : "").trim();
  // text_는 Date를 일자만으로 바꾸므로 판매시간 라벨은 표시값 우선
  if (!bDisp && row[1] != null) bDisp = String(row[1]).trim();
  var map = colMap || null;
  var day;
  var soldAt;
  var name;
  var qtyCell;
  var priceCell;
  if (isPosNewSchemaRow_(row, aRaw)) {
    day = dateText_(d0, row[0]) || aRaw.slice(0, 10);
    soldAt = bDisp || "";
    name = text_(row[2]);
    qtyCell = row[3];
    priceCell = row.length > 4 ? row[4] : "";
  } else if (map && (map.date >= 0 || map.soldAt >= 0) && !/^\d{4}-\d{2}-\d{2}[\sT]\d/.test(aRaw)) {
    var dateIdx = map.date >= 0 ? map.date : map.soldAt;
    var soldIdx = map.soldAt >= 0 ? map.soldAt : map.date;
    var nameIdx = map.name >= 0 ? map.name : -1;
    var qtyIdx = map.qty >= 0 ? map.qty : -1;
    var priceIdx = map.unitPrice >= 0 ? map.unitPrice : -1;
    day = dateText_(
      displayRow && displayRow[dateIdx] != null ? displayRow[dateIdx] : row[dateIdx],
      row[dateIdx]
    );
    soldAt =
      (displayRow && soldIdx >= 0 && displayRow[soldIdx] != null && String(displayRow[soldIdx]).trim()) ||
      String(row[soldIdx] != null ? row[soldIdx] : "").trim() ||
      day;
    name = nameIdx >= 0 ? text_(row[nameIdx]) : "";
    qtyCell = qtyIdx >= 0 ? row[qtyIdx] : "";
    priceCell = priceIdx >= 0 ? row[priceIdx] : "";
  } else {
    day = dateText_(d0, row[0]) || (aRaw ? aRaw.slice(0, 10) : "");
    soldAt = aRaw || day;
    name = text_(row[1]);
    qtyCell = row[2];
    priceCell = row.length > 3 ? row[3] : "";
  }
  if (!day && !soldAt && !name) return null;
  if (!day) day = dateText_(soldAt, soldAt) || "";
  if (!day) return null;
  var hour = posHourFromText_(soldAt);
  if (hour != null && !/^\d{1,2}\s*시$/.test(String(soldAt).trim())) {
    soldAt = hour + "시";
  }
  var qty = moneyOrNull_(qtyCell);
  if (qty === null && qtyCell !== "" && qtyCell !== null && qtyCell !== undefined) {
    qty = num_(qtyCell);
  }
  var unitPrice = moneyOrNull_(priceCell);
  if (unitPrice === null && priceCell !== "" && priceCell !== null && priceCell !== undefined) {
    unitPrice = num_(priceCell);
  }
  if (unitPrice === null || !isFinite(unitPrice)) unitPrice = null;
  return { date: day, soldAt: soldAt, name: name, qty: qty, unitPrice: unitPrice, hour: hour };
}

/** 헤더 행 → 컬럼 인덱스 맵 (없으면 -1) */
function posHeaderMap_(headerRow) {
  var map = { date: -1, soldAt: -1, name: -1, qty: -1, unitPrice: -1 };
  if (!headerRow || !headerRow.length) return map;
  for (var i = 0; i < headerRow.length; i++) {
    var h = String(headerRow[i] || "").replace(/\s/g, "");
    if (h === "판매일자" || h === "일자") map.date = i;
    else if (h === "판매시간" || h === "판매일시" || h === "일시" || h === "시간") map.soldAt = i;
    else if (h === "상품명" || h === "메뉴" || h === "품목") map.name = i;
    else if (h === "수량" || h === "판매수량") map.qty = i;
    else if (h === "단가" || h === "판매단가" || h === "가격") map.unitPrice = i;
  }
  return map;
}

function weatherHeaderMap_(headerRow) {
  var map = { date: -1, amWeather: -1, amTemp: -1, pmWeather: -1, pmTemp: -1 };
  if (!headerRow || !headerRow.length) return map;
  for (var i = 0; i < headerRow.length; i++) {
    var h = String(headerRow[i] || "").replace(/\s/g, "");
    if (h === "일자" || h === "날짜" || h === "판매일자") map.date = i;
    else if (h === "오전_날씨" || h === "오전날씨") map.amWeather = i;
    else if (h === "오전_기온" || h === "오전기온") map.amTemp = i;
    else if (h === "오후_날씨" || h === "오후날씨") map.pmWeather = i;
    else if (h === "오후_기온" || h === "오후기온") map.pmTemp = i;
  }
  return map;
}

function isoDaysAgo_(days) {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (Number(days) || 0));
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
}

function trySheet_(names) {
  var list = Array.isArray(names) ? names : [names];
  for (var i = 0; i < list.length; i++) {
    try {
      return sheet_(list[i]);
    } catch (e0) {}
  }
  return null;
}

/**
 * POS 판매내역 조회 (시트: pos판매내역)
 * 신규: A 판매일자 · B 판매일시 · C 상품명 · D 수량 · E 단가(선택)
 */
function getPosSalesData(pin, startDate, endDate, keyword) {
  assertPin_(pin);
  var start = text_(startDate);
  var end = text_(endDate);
  var kw = String(keyword || "").trim().toLowerCase();
  var sheet = trySheet_(["pos판매내역", "POS판매내역"]);
  if (!sheet) {
    return {
      ok: false,
      rows: [],
      count: 0,
      start: start,
      end: end,
      keyword: keyword || "",
      message: "pos판매내역 시트를 찾지 못했습니다.",
      version: APP_VERSION
    };
  }
  var values = sheet.getDataRange().getValues();
  var displays = sheet.getDataRange().getDisplayValues();
  if (!values || values.length <= 1) {
    return {
      ok: true,
      rows: [],
      count: 0,
      start: start,
      end: end,
      keyword: keyword || "",
      version: APP_VERSION
    };
  }
  var colMap = posHeaderMap_(values[0]);
  var useMap = colMap.name >= 0 || colMap.date >= 0 || colMap.soldAt >= 0;
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var parsed = parsePosSalesRow_(values[i], displays[i], useMap ? colMap : null);
    if (!parsed) continue;
    if (start && parsed.date < start) continue;
    if (end && parsed.date > end) continue;
    if (kw && String(parsed.name).toLowerCase().indexOf(kw) < 0) continue;
    rows.push({
      row: i + 1,
      soldAt: parsed.soldAt,
      hour: parsed.hour != null ? parsed.hour : posHourFromText_(parsed.soldAt),
      date: parsed.date,
      name: parsed.name,
      qty: parsed.qty,
      unitPrice: parsed.unitPrice
    });
  }
  rows.sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    var ha = a.hour != null ? a.hour : -1;
    var hb = b.hour != null ? b.hour : -1;
    if (ha !== hb) return ha < hb ? 1 : -1;
    if (a.soldAt !== b.soldAt) return a.soldAt < b.soldAt ? 1 : -1;
    return a.row - b.row;
  });
  return {
    ok: true,
    rows: rows,
    count: rows.length,
    start: start,
    end: end,
    keyword: keyword || "",
    version: APP_VERSION
  };
}

/**
 * 일별날씨 시트 → 객체 배열
 * 컬럼: 일자, 오전_날씨, 오전_기온, 오후_날씨, 오후_기온
 */
function getDailyWeatherRows_(startDate, endDate) {
  var start = text_(startDate);
  var end = text_(endDate);
  var sheet = trySheet_(["일별날씨", "날씨", "일별 날씨"]);
  if (!sheet) {
    return { ok: false, rows: [], message: "일별날씨 시트를 찾지 못했습니다." };
  }
  var range = sheet.getDataRange();
  var values = range.getValues();
  var displays = range.getDisplayValues();
  if (!values || values.length <= 1) {
    return { ok: true, rows: [], message: "" };
  }
  var map = weatherHeaderMap_(values[0]);
  var hasHeader = map.date >= 0;
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row || !String(row.join("")).trim()) continue;
    var dateIdx = hasHeader ? map.date : 0;
    var amW = hasHeader ? map.amWeather : 1;
    var amT = hasHeader ? map.amTemp : 2;
    var pmW = hasHeader ? map.pmWeather : 3;
    var pmT = hasHeader ? map.pmTemp : 4;
    var day = dateText_(
      displays[i] && displays[i][dateIdx] != null ? displays[i][dateIdx] : row[dateIdx],
      row[dateIdx]
    );
    if (!day) continue;
    if (start && day < start) continue;
    if (end && day > end) continue;
    var amTemp = amT >= 0 ? moneyOrNull_(row[amT]) : null;
    if (amTemp === null && amT >= 0 && row[amT] !== "" && row[amT] != null) amTemp = num_(row[amT]);
    var pmTemp = pmT >= 0 ? moneyOrNull_(row[pmT]) : null;
    if (pmTemp === null && pmT >= 0 && row[pmT] !== "" && row[pmT] != null) pmTemp = num_(row[pmT]);
    rows.push({
      row: i + 1,
      date: day,
      amWeather: amW >= 0 ? text_(row[amW]) : "",
      amTemp: amTemp,
      pmWeather: pmW >= 0 ? text_(row[pmW]) : "",
      pmTemp: pmTemp
    });
  }
  rows.sort(function(a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });
  return { ok: true, rows: rows, message: "" };
}

/**
 * POS 대시보드용 통합 조회
 * action: jobGetPosDashboardData
 * body: { days?: 30, startDate?, endDate? }
 * 응답: { posData, weatherData, start, end, ... }
 */
function jobGetPosDashboardData(pin, body) {
  assertPin_(pin);
  body = body || {};
  var days = Math.max(1, Math.min(366, Math.floor(Number(body.days != null ? body.days : 30) || 30)));
  var end = text_(body.endDate || body.end) || isoDaysAgo_(0);
  var start = text_(body.startDate || body.start) || isoDaysAgo_(days - 1);
  if (start > end) {
    var tmp = start;
    start = end;
    end = tmp;
  }

  var posSheetMissing = false;
  var weatherSheetMissing = false;
  var posData = [];
  var weatherData = [];
  var messages = [];

  var posRes = getPosSalesData(pin, start, end, body.keyword || "");
  if (posRes && posRes.ok === false && posRes.message) {
    posSheetMissing = true;
    messages.push(posRes.message);
  } else {
    var rawPos = (posRes && posRes.rows) || [];
    for (var p = 0; p < rawPos.length; p++) {
      var r = rawPos[p];
      if (!r || !r.date) continue;
      if (!r.name && (r.qty == null || r.qty === "")) continue;
      posData.push({
        saleDate: r.date,
        soldAt: r.soldAt || r.date,
        hour: r.hour != null ? r.hour : posHourFromText_(r.soldAt),
        name: r.name || "",
        qty: r.qty,
        unitPrice: r.unitPrice != null ? r.unitPrice : null,
        // 프론트 호환 별칭
        date: r.date,
        판매일자: r.date,
        판매시간: r.soldAt || "",
        판매일시: r.soldAt || r.date,
        상품명: r.name || "",
        수량: r.qty,
        단가: r.unitPrice != null ? r.unitPrice : null
      });
    }
  }

  var wxRes = getDailyWeatherRows_(start, end);
  if (wxRes && wxRes.ok === false) {
    weatherSheetMissing = true;
    if (wxRes.message) messages.push(wxRes.message);
  } else {
    var rawWx = (wxRes && wxRes.rows) || [];
    for (var w = 0; w < rawWx.length; w++) {
      var x = rawWx[w];
      if (!x || !x.date) continue;
      weatherData.push({
        date: x.date,
        amWeather: x.amWeather || "",
        amTemp: x.amTemp,
        pmWeather: x.pmWeather || "",
        pmTemp: x.pmTemp,
        일자: x.date,
        오전_날씨: x.amWeather || "",
        오전_기온: x.amTemp,
        오후_날씨: x.pmWeather || "",
        오후_기온: x.pmTemp
      });
    }
  }

  return {
    ok: true,
    posData: posData,
    weatherData: weatherData,
    start: start,
    end: end,
    days: days,
    posCount: posData.length,
    weatherCount: weatherData.length,
    posSheetMissing: posSheetMissing,
    weatherSheetMissing: weatherSheetMissing,
    message: messages.join(" / "),
    version: APP_VERSION
  };
}


