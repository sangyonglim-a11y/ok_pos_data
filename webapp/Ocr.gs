/**
 * 웹 영수증 OCR (PC/모바일 겸용)
 * - ScriptProperties 에 GEMINI_API_KEY 를 넣어 주세요.
 * - (선택) RECEIPT_DONE_FOLDER_ID : '처리완료' 드라이브 폴더 ID
 * - 저장 파일명: [거래일]_[거래처명]_[영수증합계금액].jpg
 */

// 1.5/2.0 은 종료됨. 새 키는 2.5 가 404 날 수 있어 3.x 를 먼저 시도.
var OCR_GEMINI_MODELS_ = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash"
];
/** OCR 디버그/버전 확인용. 배포 후 토스트·OCR디버그 시트에 표시 */
var OCR_BUILD = "2026-11-09-j91-ocr";

var OCR_IMAGE_EXT_ = {
  jpg: true, jpeg: true, png: true, webp: true, gif: true, heic: true, heif: true
};

/**
 * 여러 장 일괄 처리 (google.script.run.processReceiptsWithGemini)
 * @param {Array<string|Object>} base64Images - dataURL / pure base64 / {data,mimeType,name}
 */
function processReceiptsWithGemini(base64Images) {
  var list = base64Images || [];
  var results = [];
  var savedRows = 0;
  for (var i = 0; i < list.length; i++) {
    var one = processOneReceiptImage_(list[i], i + 1);
    results.push(one);
    savedRows += one.saved || 0;
  }
  return {
    ok: true,
    count: list.length,
    savedRows: savedRows,
    results: results,
    message: "영수증 " + list.length + "장 분석, 입고 " + savedRows + "줄 등록",
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : ""
  };
}

/** 한 장씩 처리 (진행률 표시용) */
function processOneReceiptWithGemini(imagePayload) {
  return processOneReceiptImage_(imagePayload, 1);
}

function processOneReceiptImage_(payload, index) {
  var parsed = normalizeImagePayload_(payload);
  var extracted = callGeminiReceipt_(parsed.base64, parsed.mimeType);
  var fileUrl = saveReceiptImageToDrive_(parsed.base64, parsed.mimeType, extracted, index);
  var savedInfo = appendReceiptToSheet_(extracted, fileUrl);
  var saved = typeof savedInfo === "object" ? savedInfo.count : savedInfo;
  var debug = typeof savedInfo === "object" ? savedInfo.debug : null;
  try {
    logOcrDebugToSheet_(extracted, debug || {}, fileUrl);
  } catch (eDbg) {}
  var receiptNo = text_((extracted && extracted.receiptNo) || "");
  var serialSeq = text_((extracted && extracted.serialSeq) || "");
  var uid = debug && debug.uniqueId ? debug.uniqueId : "";
  return {
    ok: true,
    index: index,
    supplier: extracted.supplier || "",
    date: extracted.date || "",
    receiptNo: receiptNo,
    serialSeq: serialSeq,
    uniqueId: uid,
    items: (extracted.items || []).length,
    saved: saved,
    fileUrl: fileUrl || "",
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : OCR_BUILD,
    ocrBuild: OCR_BUILD,
    message:
      OCR_BUILD + " | " +
      (extracted.supplier || "거래처") + " / " + (extracted.date || "") +
      " / receiptNo=" + (receiptNo || "(없음)") +
      " / seq=" + (serialSeq || "(없음)") +
      " / ID=" + (uid || "(없음)") +
      " / " + saved + "줄"
  };
}

function normalizeImagePayload_(payload) {
  var raw = "";
  var mime = "image/jpeg";
  var name = "";
  if (typeof payload === "string") {
    raw = payload;
  } else if (payload && typeof payload === "object") {
    raw = String(payload.data || payload.base64 || payload.dataUrl || "");
    mime = String(payload.mimeType || payload.mime || "image/jpeg");
    name = String(payload.name || "");
  } else {
    throw new Error("이미지 데이터가 없습니다.");
  }
  var m = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    mime = m[1] || mime;
    raw = m[2];
  }
  raw = String(raw).replace(/\s/g, "");
  if (!raw) throw new Error("빈 이미지입니다.");
  return { base64: raw, mimeType: mime || "image/jpeg", name: name };
}

function geminiApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  return String(key || "").trim();
}

/** PC sheet_jobs.normalize_item_name 과 동일 */
function normalizeItemName_(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

/** PC sheet_jobs.alias_index 과 동일 */
function aliasIndex_(master) {
  var index = {};
  Object.keys(master || {}).forEach(function(code) {
    var info = master[code] || {};
    var names = [info.name].concat(info.aliases || []);
    for (var i = 0; i < names.length; i++) {
      var key = normalizeItemName_(names[i]);
      if (key && !index[key]) index[key] = code;
    }
  });
  return index;
}

/** PC sheet_jobs.apply_known_mapping 과 동일 */
function applyKnownMapping_(item, master) {
  if (!item || !master) return;
  var code = aliasIndex_(master)[normalizeItemName_(item.name || item.originalName)];
  if (!code) return;
  item.mappedCode = code;
  item.mappedName = (master[code] && master[code].name) || code;
}

/** PC sheet_jobs.mapping_db_text 과 동일 (레시피배합표 포함) */
function mappingDbText_(master) {
  var lines = [];
  var seen = {};
  Object.keys(master || {}).forEach(function(code) {
    var info = master[code] || {};
    var alias = (info.aliases || []).join(", ");
    lines.push("- 코드: " + code + ", 공식품목명: " + (info.name || code) + ", 별칭: " + alias);
    seen[code] = true;
  });
  try {
    var recipe = sheet_("레시피배합표").getDataRange().getValues();
    for (var r = 1; r < recipe.length; r++) {
      var row = recipe[r];
      if (!row || row.length < 5) continue;
      var code = text_(row[4]);
      var name = text_(row[3]);
      if (code && name && !seen[code]) {
        seen[code] = true;
        lines.push("- 코드: " + code + ", 공식품목명: " + name + ", 별칭: ");
      }
    }
  } catch (e) {}
  return lines.join("\n");
}

/** PC sheet_jobs.ask_gemini 프롬프트 (원재료 DB + 매핑/당월누적/최종수량 규칙) */
function ocrGeminiPrompt_(dbText) {
  return (
    "너는 식당 ERP 재고관리 AI야. 첨부된 거래명세서를 분석해서 JSON 배열로 반환해.\n" +
    "반드시 마크다운이나 추가 설명 없이 순수 JSON 형태만 출력해야 해.\n\n" +
    "[우리 식당 원재료 DB]\n" +
    dbText + "\n\n" +
    "[분석 및 매핑 규칙]\n" +
    "1. 영수증에 적힌 모든 품목을 추출해.\n" +
    "2. 영수증 품목명과 가장 유사한 것을 [우리 식당 원재료 DB]에서 찾아 'mappedCode'와 'mappedName'에 넣어. 별칭이 같으면 그 코드를 쓰고, 확실치 않으면 null\n" +
    "3. 고기류처럼 명세서에 단위가 Box이고 실제 중량(kg)이 적혀있다면, 'finalQty'는 반드시 실제 중량(kg) 숫자로 산출해.\n" +
    "4. 일반 공산품은 영수증의 기본 수량을 'finalQty'로 해.\n" +
    "5. 단가(unitPrice)와 품목금액(totalPrice)은 부가세가 포함된 금액으로 넣어.\n" +
    "   - 품목 금액에 이미 부가세가 들어 있으면 적힌 금액을 그대로 써.\n" +
    "   - 공급가액과 세액이 따로 있고 품목 금액이 공급가액이면, 그 줄 공급가액에 세액 몫을 더한 값을 totalPrice로 넣어. unitPrice는 그 totalPrice를 수량으로 나눈 값.\n" +
    "   - supplyAmount는 명세서 공급가액 합계, 없으면 null.\n" +
    "   - taxAmount는 따로 적힌 세액. 품목 금액에 부가세가 이미 포함되어 있으면 null.\n" +
    "   - pricesIncludeTax는 품목 금액이 부가세 포함이면 true, 공급가액이면 false.\n" +
    "6. 이 영수증 한 장의 합계와 누적 외상 대금을 모든 품목에 같은 숫자로 넣어. 콤마는 빼. 같은 날 다른 영수증 금액은 더하지 마.\n" +
    "   - dailyAmount: 이번 납품(당일) 품목 합계. 금일판매, 금일합계, 매출합계, 표 안 부분합(= 69— 등), 공급가액+세액.\n" +
    "   - accumulatedAmount (숫자|null): 명세서 하단·총괄 요약의 **최종 누적 외상 대금**. 시트 '명세서누적금액'에 들어간다.\n" +
    "     거래처마다 용어가 다르다. 다음 키워드를 찾아 숫자만 넣어라:\n" +
    "     '미수금', '잔액', '채권잔액', '당월누계', '당월누적', '월누계', '외상매출금', '공급대가총액'(머리칸 큰 누적액).\n" +
    "     주의: '전미수', '전일채권', '전잔', '이월채권' 등 **과거 잔액이 아니다.**\n" +
    "     금번 거래가 반영된 **최종** 미수금·잔액·채권잔액만 accumulatedAmount 에 넣는다.\n" +
    "     예: 공급대가총액 ₩121,500 → accumulatedAmount=121500. 이것을 dailyAmount로 넣지 마.\n" +
    "     주류 정산의 '채권잔액'도 반드시 accumulatedAmount 에 넣는다 (별도 creditBalance 만 두지 마).\n" +
    "   - monthTotal: accumulatedAmount 와 동일한 값(하위호환). 둘 다 채우되 숫자가 다르면 accumulatedAmount 를 우선.\n" +
    "   - 표 중간에 '= 69—'처럼 품목 바로 아래 부분합만 dailyAmount다. (상추+깻잎+… 합)\n" +
    "   - '전미수'·'전일채권'·짧은 '미수'(과거분) 금액은 previousCredit(또는 outstandingReceivable)에 넣고 items에 넣지 마.\n" +
    "     관계식 예: dailyAmount 69000 + 전미수 52500 = 공급대가총액(accumulatedAmount) 121500.\n" +
    "   - 공급대가총액이 품목 합과 정확히 같고 미수/부분합이 없으면 그때만 dailyAmount=accumulatedAmount 로 같아도 됨.\n" +
    "   - paymentAmount: 금일수금, 입금, 결제액, 현금수금. 없으면 null.\n" +
    "   금액을 못 찾으면 null.\n" +
    "6-0. [(주)동의보감농수산 양식 — 사업자 211-86-29450] 아래를 반드시 지켜라.\n" +
    "   - 품목 표에 '금액'(공급가)과 '세액'이 줄마다 있다. totalPrice = 그 줄 금액(또는 단가×수량) + 그 줄 세액.\n" +
    "     unitPrice는 부가세 포함 단가(totalPrice÷수량). 줄세액은 taxAmount에 넣고 pricesIncludeTax=false로 시작해 계산에 반영되게 해.\n" +
    "   - 하단 미수금 칸에 '266,750(전)' / '442,750(현)' 처럼 (전)·(현)이 같이 있으면:\n" +
    "     previousCredit = (전) 숫자, accumulatedAmount·monthTotal = (현) 숫자.\n" +
    "     (전)을 당월누적/accumulatedAmount에 넣지 마. (현)만 최종 누적이다.\n" +
    "   - dailyAmount = 모든 품목 totalPrice(세액 포함) 합 = 명세서 합계(공급가액+세액).\n" +
    "6-1. [손글씨 금액 줄임] 숫자 뒤에 가로줄(—, -, ～)만 그은 표기는 천 원 단위다.\n" +
    "   예: 14— → 14000, 32— → 32000, 3— → 3000, 69— → 69000. unitPrice/totalPrice/dailyAmount에 풀린 숫자를 넣어.\n" +
    "   '미역줄기'처럼 실제 품목이 아닌 미수·합계 줄을 품목으로 만들지 마.\n" +
    "7. businessNumber: 거래처(공급자, 명세서를 발행한 쪽)의 사업자등록번호. 하이픈 유지(예: 630-54-00916).\n" +
    "   - 칸 이름이 '사업자등록번호'뿐 아니라 공급자 상자에서 상호 바로 위의 '번호' 칸도 사업자번호다.\n" +
    "   - 주강 에프앤비 양식: 공급자 오른쪽 위 '번호' = 630-54-00916 → businessNumber 에 넣기.\n" +
    "   - 공급받는자(우리 식당) 번호는 넣지 마. 없으면 null.\n" +
    "   모든 품목에 같은 값을 넣어.\n" +
    "8. unit(단위/규격)에는 중량이 있으면 '1 Box / 11.96kg'처럼 kg 를 포함해. originalQty는 개수(보통 1).\n" +
    "   unitPrice는 단가, totalPrice는 줄 합계. 서로 바꾸지 마.\n" +
    "   [주류판매계산서] 수량 칸이 '2 / 0' 또는 '2/0' 형태면 앞의 숫자만 originalQty(박스 수).\n" +
    "   뒷숫자(낱개)·매출합계·용기보증금 금액을 수량으로 넣지 마. '카스 500'의 500은 용량(이름/규격)이지 수량이 아님.\n" +
    "   예: 참이슬 후레쉬 수량 2/0 → originalQty=2, unit='병/박스' 또는 영수증 규격.\n" +
    "9. receiptNo / serialSeq (필수에 가깝게 찾을 것):\n" +
    "   - 위치: 오른쪽 공급자 상자 맨 위, '사업자등록번호' 칸의 바로 위(일련번호).\n" +
    "   - 델리앤 양식 예: '2026/10/15 -1' 또는 '2026/10/15-1' (날짜와 회차가 한 칸).\n" +
    "   - receiptNo: 그 칸 전체 문자열. 날짜만 넣고 회차(-1)를 빼면 안 됨.\n" +
    "   - serialSeq: 회차 숫자만 문자열로. 위 예면 \"1\". 없으면 null.\n" +
    "   모든 품목에 같은 값을 넣어.\n" +
    "10. [주류 영수증 특화] 정산 칸에 전일채권·채권잔액·회수(공병반환 등)가 보이면 일반 합계와 별도로 추출해.\n" +
    "   - previousCredit(전일채권): 전일채권, 전잔, 이월채권. 숫자만. 없으면 null.\n" +
    "   - recoveryTotal(회수합계): 회수합계, 공병반환, 용기보증금 회수 등 회수성 합계. 없으면 null.\n" +
    "   - accumulatedAmount: 채권잔액·미수잔액(주류 정산 **최종** 결과). creditBalance 필드 대신 여기로 통일.\n" +
    "   - dailyAmount는 매출합계(당일 판매/납품 합계). paymentAmount는 현금수금만(회수합계와 합치지 마).\n" +
    "   주류 정산이 없으면 previousCredit·recoveryTotal·accumulatedAmount 는 모두 null.\n" +
    "11. [쿠폰·할인·에누리·포인트 — 필수] 영수증 하단이나 품목 사이에 있는 '쿠폰할인', '이벤트할인', '포인트사용', '에누리', '할인' 등 마이너스(-) 금액 항목도 절대로 누락하지 말고 items 배열에 독립적인 하나의 품목으로 포함시켜라.\n" +
    "   - originalName(itemName): 영수증에 적힌 그대로. 예: '[쿠폰](식자재)10만원 구매시...'\n" +
    "   - unitPrice(단가)·totalPrice(매입금액): 반드시 마이너스 부호(-)를 포함한 숫자. 예: -7000. 절대 양수나 절대값만 넣지 마.\n" +
    "   - originalQty(quantity): 재고에 영향 없도록 무조건 0.\n" +
    "   - unit(규격/단위): 무조건 '할인'.\n" +
    "   - finalQty: 0. mappedCode·mappedName: null (원재료 매핑 금지).\n" +
    "   - dailyAmount는 할인 반영 후 최종 납품 합계(품목 양수 합 + 할인 음수 합). 예: 159490 + (-7000) = 152490.\n\n" +
    "[출력 JSON 포맷 예시]\n" +
    "[\n" +
    "  {\n" +
    '    "receiptDate": "2026-10-15",\n' +
    '    "vendor": "(주)델리앤",\n' +
    '    "receiptNo": "2026/10/15 -1",\n' +
    '    "serialSeq": "1",\n' +
    '    "originalName": "스테이크 돼지갈비 4.2kg (수입산)",\n' +
    '    "unit": "1 Box / 11.96kg",\n' +
    '    "originalQty": 1,\n' +
    '    "unitPrice": 233220,\n' +
    '    "totalPrice": 233220,\n' +
    '    "mappedCode": "M0015",\n' +
    '    "mappedName": "이베리코 목살",\n' +
    '    "finalQty": 11.96,\n' +
    '    "dailyAmount": 1053360,\n' +
    '    "accumulatedAmount": 3576528,\n' +
    '    "monthTotal": 3576528,\n' +
    '    "paymentAmount": null,\n' +
    '    "previousCredit": null,\n' +
    '    "outstandingReceivable": null,\n' +
    '    "recoveryTotal": null,\n' +
    '    "businessNumber": "475-81-00732"\n' +
    "  }\n" +
    "]"
  );
}

/**
 * 명세서누적금액(G열)용 최종 누적액.
 * 우선순위: accumulatedAmount → creditBalance(구 주류) → monthTotal(하위호환)
 */
function resolveAccumulatedAmount_(data) {
  data = data || {};
  var acc = moneyOrNull_(data.accumulatedAmount);
  if (acc === null) acc = moneyOrNull_(data.creditBalance);
  if (acc === null) acc = moneyOrNull_(data.monthTotal);
  return acc;
}

function callGeminiReceipt_(base64, mimeType) {
  var key = geminiApiKey_();
  if (!key) {
    throw new Error("ScriptProperties 에 GEMINI_API_KEY 가 없습니다. Apps Script > 프로젝트 설정 > 스크립트 속성에 추가하세요.");
  }
  var master = {};
  try {
    master = materialMaster_();
  } catch (e0) {
    master = {};
  }
  var prompt = ocrGeminiPrompt_(mappingDbText_(master) || "(원재료 DB 없음)");

  var body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || "image/jpeg", data: base64 } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  var lastError = "";
  for (var i = 0; i < OCR_GEMINI_MODELS_.length; i++) {
    var model = OCR_GEMINI_MODELS_[i];
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      model + ":generateContent?key=" + encodeURIComponent(key);
    try {
      var res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var text = res.getContentText();
      if (code < 200 || code >= 300) {
        lastError = model + " HTTP " + code + ": " + text.slice(0, 240);
        continue;
      }
      var json = JSON.parse(text);
      var partText = (((json.candidates || [])[0] || {}).content || {}).parts;
      var raw = "";
      if (partText && partText.length) {
        for (var p = 0; p < partText.length; p++) {
          if (partText[p].text) raw += partText[p].text;
        }
      }
      var extracted = parseReceiptJson_(raw);
      extracted = enrichReceiptNo_(extracted, raw);
      extracted = enrichBusinessNumber_(extracted, raw);
      // PC: apply_known_mapping 후처리
      (extracted.items || []).forEach(function(it) {
        applyKnownMapping_(it, master);
      });
      return extracted;
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
    }
  }
  throw new Error("Gemini 분석 실패: " + lastError);
}

function parseReceiptJson_(raw) {
  var text = String(raw || "").trim();
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  var data;
  try {
    data = JSON.parse(text);
  } catch (e1) {
    var arr = text.match(/\[[\s\S]*\]/);
    var obj = text.match(/\{[\s\S]*\}/);
    if (arr) data = JSON.parse(arr[0]);
    else if (obj) data = JSON.parse(obj[0]);
    else throw new Error("Gemini 응답 JSON 파싱 실패");
  }
  if (Array.isArray(data)) {
    // PC sheet_jobs 배열 포맷
    var first = data[0] || {};
    data = {
      supplier: first.vendor || first.supplier || "",
      date: first.receiptDate || first.date || "",
      biz: first.businessNumber || first.biz || "",
      receiptNo: first.receiptNo || first.receiptNumber || first.serialNumber ||
        first.slipNo || first.slipNumber || first.documentNo || first.orderNumber || "",
      serialSeq: first.serialSeq != null ? first.serialSeq : (first.seq != null ? first.seq : ""),
      dailyAmount: first.dailyAmount != null ? first.dailyAmount : null,
      accumulatedAmount: first.accumulatedAmount != null ? first.accumulatedAmount
        : (first.creditBalance != null ? first.creditBalance
          : (first.monthTotal != null ? first.monthTotal : null)),
      monthTotal: first.monthTotal != null ? first.monthTotal
        : (first.accumulatedAmount != null ? first.accumulatedAmount
          : (first.creditBalance != null ? first.creditBalance : null)),
      paymentAmount: first.paymentAmount != null ? first.paymentAmount : null,
      previousCredit: first.previousCredit != null ? first.previousCredit : (first.outstandingReceivable != null ? first.outstandingReceivable : null),
      outstandingReceivable: first.outstandingReceivable != null ? first.outstandingReceivable : null,
      recoveryTotal: first.recoveryTotal != null ? first.recoveryTotal : null,
      creditBalance: first.creditBalance != null ? first.creditBalance : null,
      items: data.map(function(it) {
        return {
          name: it.originalName || it.name || it.mappedName || "",
          spec: it.unit || it.spec || "",
          qty: it.originalQty != null ? it.originalQty : it.qty,
          unitPrice: it.unitPrice,
          totalPrice: it.totalPrice,
          taxAmount: it.taxAmount,
          supplyAmount: it.supplyAmount,
          pricesIncludeTax: it.pricesIncludeTax,
          mappedCode: it.mappedCode == null ? "" : it.mappedCode,
          mappedName: it.mappedName == null ? "" : it.mappedName,
          finalQty: it.finalQty,
          accumulatedAmount: it.accumulatedAmount,
          monthTotal: it.monthTotal,
          paymentAmount: it.paymentAmount,
          previousCredit: it.previousCredit,
          outstandingReceivable: it.outstandingReceivable,
          currentReceivable: it.currentReceivable,
          outstandingCurrent: it.outstandingCurrent,
          previousReceivable: it.previousReceivable,
          outstandingPrevious: it.outstandingPrevious,
          recoveryTotal: it.recoveryTotal,
          creditBalance: it.creditBalance,
          receiptNo: it.receiptNo || it.receiptNumber || it.serialNumber ||
            it.slipNo || it.slipNumber || it.documentNo || it.orderNumber,
          serialSeq: it.serialSeq != null ? it.serialSeq : it.seq,
          biz: it.businessNumber || it.biz,
          vendor: it.vendor || it.supplier || ""
        };
      }),
      supplyAmount: first.supplyAmount != null ? first.supplyAmount : null,
      taxAmount: first.taxAmount != null ? first.taxAmount : null,
      currentReceivable: first.currentReceivable != null ? first.currentReceivable
        : (first.outstandingCurrent != null ? first.outstandingCurrent : null),
      previousReceivable: first.previousReceivable != null ? first.previousReceivable
        : (first.outstandingPrevious != null ? first.outstandingPrevious : null)
    };
  }
  if (!data.items) data.items = [];
  data.items = (data.items || []).map(function(it) {
    return normalizeOcrItem_(it);
  });
  data = scrubHandwrittenReceipt_(data);
  data = applyDonguibogamOcrRules_(data);
  data.receiptNo = text_(
    data.receiptNo || data.receiptNumber || data.serialNumber ||
    data.slipNo || data.slipNumber || data.documentNo || data.orderNumber || ""
  );
  data.serialSeq = text_(data.serialSeq != null ? data.serialSeq : (data.seq != null ? data.seq : ""));
  if (!data.serialSeq) {
    for (var sq = 0; sq < data.items.length; sq++) {
      var seqVal = text_(data.items[sq].serialSeq || "");
      if (seqVal) {
        data.serialSeq = seqVal;
        break;
      }
    }
  }
  data.previousCredit = moneyOrNull_(data.previousCredit);
  if (data.previousCredit === null) {
    data.previousCredit = moneyOrNull_(data.outstandingReceivable);
  }
  data.recoveryTotal = moneyOrNull_(data.recoveryTotal);
  data.creditBalance = moneyOrNull_(data.creditBalance);
  data.accumulatedAmount = moneyOrNull_(data.accumulatedAmount);
  // 품목 행에만 누적액이 온 경우 헤더로 끌어올림
  if (data.accumulatedAmount === null) {
    for (var ai = 0; ai < data.items.length; ai++) {
      var accItem = moneyOrNull_(data.items[ai].accumulatedAmount);
      if (accItem === null) accItem = moneyOrNull_(data.items[ai].creditBalance);
      if (accItem === null) accItem = moneyOrNull_(data.items[ai].monthTotal);
      if (accItem !== null) {
        data.accumulatedAmount = accItem;
        break;
      }
    }
  }
  // PC receipt_amounts: 품목에서 당월누적/수금/사업자/주류·전표필드 보강
  if (data.monthTotal == null || data.monthTotal === "") {
    for (var i = 0; i < data.items.length; i++) {
      var mt = moneyOrNull_(data.items[i].monthTotal);
      if (mt === null) mt = moneyOrNull_(data.items[i].accumulatedAmount);
      if (mt !== null) {
        data.monthTotal = mt;
        break;
      }
    }
  }
  if (data.paymentAmount == null || data.paymentAmount === "") {
    for (var p = 0; p < data.items.length; p++) {
      var pay = moneyOrNull_(data.items[p].paymentAmount);
      if (pay !== null && pay > 0) {
        data.paymentAmount = pay;
        break;
      }
    }
  }
  if (!data.biz) {
    for (var b = 0; b < data.items.length; b++) {
      var biz = text_(data.items[b].biz || data.items[b].businessNumber || "");
      if (biz) {
        data.biz = biz;
        break;
      }
    }
  }
  if (!data.receiptNo) {
    for (var rn = 0; rn < data.items.length; rn++) {
      var receiptNo = text_(data.items[rn].receiptNo || "");
      if (receiptNo) {
        data.receiptNo = receiptNo;
        break;
      }
    }
  }
  if (data.previousCredit === null) {
    for (var pc = 0; pc < data.items.length; pc++) {
      var prev = moneyOrNull_(data.items[pc].previousCredit);
      if (prev !== null) {
        data.previousCredit = prev;
        break;
      }
    }
  }
  if (data.recoveryTotal === null) {
    for (var rt = 0; rt < data.items.length; rt++) {
      var rec = moneyOrNull_(data.items[rt].recoveryTotal);
      if (rec !== null) {
        data.recoveryTotal = rec;
        break;
      }
    }
  }
  if (data.creditBalance === null) {
    for (var cb = 0; cb < data.items.length; cb++) {
      var bal = moneyOrNull_(data.items[cb].creditBalance);
      if (bal !== null) {
        data.creditBalance = bal;
        break;
      }
    }
  }
  // 최종 누적액 통합: accumulatedAmount ← creditBalance ← monthTotal
  data.accumulatedAmount = resolveAccumulatedAmount_(data);
  if (data.accumulatedAmount !== null) {
    data.monthTotal = data.accumulatedAmount; // 하위호환(검증·시트 G열)
  }
  // 동의보감: 세액포함 총매입·미수금(현) 최종 보정 (누적 통합 이후 한 번 더)
  data = applyDonguibogamOcrRules_(data);
  data.accumulatedAmount = resolveAccumulatedAmount_(data);
  if (data.accumulatedAmount !== null) {
    data.monthTotal = data.accumulatedAmount;
  }
  return data;
}

function ocrBizDigits_(value) {
  return String(value || "").replace(/\D/g, "");
}

/** (주)동의보감농수산 거래명세서 여부 */
function isDonguibogamReceipt_(data) {
  data = data || {};
  if (ocrBizDigits_(data.biz) === "2118629450") return true;
  var blob = text_(data.supplier || "") + " " + text_(data.vendor || "");
  var items = data.items || [];
  for (var i = 0; i < items.length; i++) {
    blob += " " + text_(items[i].vendor || "");
    blob += " " + text_(items[i].biz || items[i].businessNumber || "");
    blob += " " + text_(items[i].name || "");
  }
  if (/동의보감/.test(blob)) return true;
  return ocrBizDigits_(blob).indexOf("2118629450") >= 0;
}

/**
 * 동의보감 양식 보정:
 * - 총매입금액(totalPrice) = (단가×수량 또는 금액) + 줄세액
 * - 당월누적 = 미수금 (현), previousCredit = 미수금 (전)
 */
function applyDonguibogamOcrRules_(data) {
  data = data || {};
  if (!isDonguibogamReceipt_(data)) return data;
  var items = data.items || [];
  var sum = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    if (isDiscountOcrItem_(it.name, it.spec, it.qty, it.totalPrice)) {
      sum += num_(it.totalPrice);
      continue;
    }
    var tax = moneyOrNull_(it.taxAmount);
    var qty = moneyOrNull_(it.qty != null ? it.qty : it.originalQty);
    if (qty === null || !(qty > 0)) qty = 1;
    var unit = moneyOrNull_(it.unitPrice);
    var tot = moneyOrNull_(it.totalPrice);
    var base = null;
    if (unit !== null) base = tidy_(unit * qty);
    if (tot !== null) base = tot;
    if (base === null) continue;
    if (tax !== null && Math.abs(tax) > 0) {
      // 이미 세액 포함이면 재가산하지 않음
      var unitBase = unit !== null ? tidy_(unit * qty) : null;
      var alreadyIncl =
        unitBase !== null &&
        tot !== null &&
        Math.abs(tot - tidy_(unitBase + tax)) <= 1;
      if (!alreadyIncl) {
        // 단가(또는 금액) + 세액
        var supply = unitBase !== null ? unitBase : base;
        if (tot !== null && unitBase !== null && Math.abs(tot - unitBase) > 1) {
          supply = tot; // 금액 열이 단가×수량과 다르면 금액 우선
        }
        it.totalPrice = tidy_(supply + tax);
        it.unitPrice = tidy_(num_(it.totalPrice) / qty);
        it.pricesIncludeTax = true;
      }
    }
    sum += num_(it.totalPrice);
  }
  sum = tidy_(sum);
  if (sum > 0) data.dailyAmount = sum;

  var cur = moneyOrNull_(data.currentReceivable);
  if (cur === null) cur = moneyOrNull_(data.outstandingCurrent);
  var prevMarked = moneyOrNull_(data.previousReceivable);
  if (prevMarked === null) prevMarked = moneyOrNull_(data.outstandingPrevious);
  if (prevMarked !== null) data.previousCredit = prevMarked;
  if (cur !== null) {
    data.accumulatedAmount = cur;
    data.monthTotal = cur;
  } else {
    // (현)을 못 읽었고 (전)+당일합으로 추정 가능할 때
    var prev = moneyOrNull_(data.previousCredit);
    var acc = moneyOrNull_(data.accumulatedAmount);
    var daily = moneyOrNull_(data.dailyAmount);
    if (prev !== null && daily !== null && daily > 0) {
      var expect = tidy_(prev + daily);
      // 누적이 (전)과 같거나 비어 있으면 (현)=전+당일로 보정 (예: 266750+176000=442750)
      if (acc === null || Math.abs(acc - prev) < 1) {
        data.accumulatedAmount = expect;
        data.monthTotal = expect;
      }
    }
  }
  return data;
}

/**
 * 쿠폰·에누리·이벤트할인 등 마이너스 금액 품목.
 * (거래처매입누적에는 반영, 원재료_실시간재고 수량에는 미반영)
 */
function isDiscountOcrItem_(name, spec, qty, totalPrice) {
  var n = text_(name);
  var s = text_(spec);
  if (/쿠폰|에누리|포인트\s*사용|이벤트\s*할인|프로모션|할인/.test(n)) return true;
  if (s === "할인" || /^할인/.test(s)) return true;
  var tp = moneyOrNull_(totalPrice);
  if (tp !== null && tp < 0) return true;
  var q = moneyOrNull_(qty);
  if (q === 0 && tp !== null && tp < 0) return true;
  return false;
}

/** 미수/합계/부분합 등 비품목 줄 (할인·쿠폰은 품목으로 유지) */
function isNonProductOcrLine_(name) {
  var n = text_(name);
  if (!n) return true;
  if (/쿠폰|에누리|할인|포인트\s*사용|이벤트/.test(n)) return false;
  if (/^(미수|미수금|부분합|소계|합계|공급대가|공급대가총액|잔액|채권잔액|전잔|이월)/.test(n)) return true;
  if (/미수|부분합|일\s*계|소\s*계|합\s*계|공급대가/.test(n)) return true;
  return false;
}

/**
 * 손글씨 영수증 후처리:
 * - 미수/합계 줄을 품목에서 제거
 * - 14— 류는 moneyOrNull_ 에서 처리
 * - Gemini가 14만 숫자로 준 경우(전부 <1000) 천 단위 복원
 * - daily=부분합, monthTotal=공급대가총액, previousCredit=미수
 */
function scrubHandwrittenReceipt_(data) {
  data = data || {};
  var items = data.items || [];
  var kept = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var nm = text_(it.name);
    if (isNonProductOcrLine_(nm)) {
      var amt = moneyOrNull_(it.totalPrice != null ? it.totalPrice : it.unitPrice);
      if (amt !== null) {
        // 과거 잔액 → previousCredit / 최종 누적 → accumulatedAmount
        if (/전미수|전일채권|전잔|이월채권|전일미수|이월/.test(nm)) {
          if (moneyOrNull_(data.previousCredit) === null) data.previousCredit = amt;
        } else if (/채권잔액|당월누계|당월누적|월누계|외상매출|공급대가총액|미수금|^잔액$/.test(nm)) {
          if (moneyOrNull_(data.accumulatedAmount) === null) data.accumulatedAmount = amt;
        } else if (/미수|잔액|채권/.test(nm)) {
          // 손글씨 짧은 '미수' 는 과거분인 경우가 많음
          if (moneyOrNull_(data.previousCredit) === null) data.previousCredit = amt;
        }
      }
      continue;
    }
    kept.push(it);
  }
  data.items = kept;

  // 줄임 숫자를 Gemini가 14 로만 준 경우: 전 품목 금액이 1~999 이고 합계·월누적이 크면 ×1000
  if (kept.length) {
    var allTiny = true;
    var sumTiny = 0;
    for (var t = 0; t < kept.length; t++) {
      var tp = moneyOrNull_(kept[t].totalPrice);
      if (tp === null || tp <= 0 || tp >= 1000) {
        allTiny = false;
        break;
      }
      sumTiny += tp;
    }
    var month0 = moneyOrNull_(data.monthTotal);
    var daily0 = moneyOrNull_(data.dailyAmount);
    var anchor = daily0 !== null ? daily0 : month0;
    if (allTiny && anchor !== null && anchor >= 1000 &&
        (Math.abs(anchor - sumTiny * 1000) / anchor < 0.15 ||
          (month0 !== null && Math.abs(month0 - sumTiny * 1000) / month0 < 0.15))) {
      for (var u = 0; u < kept.length; u++) {
        kept[u].totalPrice = tidy_(num_(kept[u].totalPrice) * 1000);
        var up = moneyOrNull_(kept[u].unitPrice);
        if (up !== null && up > 0 && up < 1000) kept[u].unitPrice = tidy_(up * 1000);
      }
      if (daily0 !== null && daily0 < 1000) data.dailyAmount = tidy_(daily0 * 1000);
    }
  }

  var sum = 0;
  for (var s = 0; s < kept.length; s++) sum += num_(kept[s].totalPrice);
  sum = tidy_(sum);

  var daily = moneyOrNull_(data.dailyAmount);
  var month = moneyOrNull_(data.monthTotal);
  var prev = moneyOrNull_(data.previousCredit);

  // daily 가 monthTotal 과 같고 품목합이 더 작으면 → 품목합을 daily, 차액을 미수
  if (kept.length && sum > 0 && month !== null && daily !== null &&
      Math.abs(daily - month) < 1 && Math.abs(sum - month) > 1) {
    data.dailyAmount = sum;
    daily = sum;
    var implied = tidy_(month - sum);
    if (implied > 0 && prev === null) {
      data.previousCredit = implied;
      prev = implied;
    }
  }

  if ((daily === null || daily === "") && kept.length && sum > 0) {
    data.dailyAmount = sum;
    daily = sum;
  }

  // month - 미수 ≈ daily 이면 daily 보정
  if (month !== null && prev !== null && prev > 0) {
    var expectDaily = tidy_(month - prev);
    if (expectDaily > 0 && (daily === null || Math.abs(daily - expectDaily) / Math.max(expectDaily, 1) < 0.05)) {
      data.dailyAmount = expectDaily;
    } else if (daily === null && sum > 0 && Math.abs(sum - expectDaily) / Math.max(expectDaily, 1) < 0.05) {
      data.dailyAmount = sum;
    }
  }

  data.dailyAmount = moneyOrNull_(data.dailyAmount);
  data.monthTotal = moneyOrNull_(data.monthTotal);
  data.previousCredit = moneyOrNull_(data.previousCredit);
  data.accumulatedAmount = moneyOrNull_(data.accumulatedAmount);
  if (data.accumulatedAmount === null && data.monthTotal !== null) {
    data.accumulatedAmount = data.monthTotal;
  }
  if (data.monthTotal === null && data.accumulatedAmount !== null) {
    data.monthTotal = data.accumulatedAmount;
  }
  return data;
}

/** Gemini 가 수량/단가/금액을 밀어서 줄 때 바로잡음 */
function normalizeOcrItem_(it) {
  it = it || {};
  var name = text_(it.name || it.originalName || it.mappedName || "");
  var spec = text_(it.spec || it.unit || "");
  var qty = moneyOrNull_(it.qty != null ? it.qty : it.originalQty);
  var unitPrice = moneyOrNull_(it.unitPrice);
  var totalPrice = moneyOrNull_(it.totalPrice);
  var finalQty = moneyOrNull_(it.finalQty);
  var mappedCode = it.mappedCode == null || it.mappedCode === "" ? "" : text_(it.mappedCode);
  var mappedName = it.mappedName == null || it.mappedName === "" ? "" : text_(it.mappedName);
  var monthTotal = moneyOrNull_(it.monthTotal);
  var paymentAmount = moneyOrNull_(it.paymentAmount);
  var taxAmount = moneyOrNull_(it.taxAmount);
  var supplyAmount = moneyOrNull_(it.supplyAmount);
  var businessNumber = text_(it.businessNumber || it.biz || "");

  var specNum = null;
  if (spec) {
    var weightMatch = String(spec).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (weightMatch) {
      var sn = Number(weightMatch[0]);
      if (!isNaN(sn)) specNum = tidy_(sn);
    }
  }

  // 밀림 패턴: spec=무게(또는 수량), qty=단가, unitPrice=줄합계, totalPrice 비어 있음
  // 예: I=18.37, J=24500, K=450055
  if (
    qty !== null &&
    unitPrice !== null &&
    qty >= 1000 &&
    unitPrice >= qty &&
    (totalPrice === null || Math.abs(unitPrice - totalPrice) < 1)
  ) {
    totalPrice = unitPrice;
    unitPrice = qty;
    qty = 1;
  }

  // total 은 있는데 qty 가 단가처럼 큰 경우 (spec 무게 × qty ≈ total)
  if (
    totalPrice !== null &&
    qty !== null &&
    qty >= 1000 &&
    specNum !== null &&
    specNum > 0 &&
    specNum < 1000
  ) {
    var errAsPrice = Math.abs(specNum * qty - totalPrice) / Math.max(Math.abs(totalPrice), 1);
    var errAsQty = unitPrice !== null
      ? Math.abs(specNum * unitPrice - totalPrice) / Math.max(Math.abs(totalPrice), 1)
      : 999;
    if (errAsPrice < 0.08 && errAsPrice <= errAsQty) {
      unitPrice = qty;
      qty = 1;
    }
  }

  // 줄합계가 없으면 단가×수량으로 채움 (고기는 무게×단가). 할인(음수)은 곱하지 않음.
  if (totalPrice === null && unitPrice !== null && !(unitPrice < 0)) {
    var mul = qty;
    if (specNum !== null && specNum > 0 && specNum < 1000 && (qty === null || qty === 1)) {
      mul = specNum;
    }
    if (mul !== null) totalPrice = tidy_(mul * unitPrice);
  }

  var isDiscount = isDiscountOcrItem_(name, spec, qty, totalPrice);
  if (isDiscount) {
    qty = 0;
    spec = "할인";
    finalQty = 0;
    mappedCode = "";
    mappedName = "";
    if (totalPrice !== null && totalPrice > 0) totalPrice = tidy_(-Math.abs(totalPrice));
    if (unitPrice !== null && unitPrice > 0) unitPrice = tidy_(-Math.abs(unitPrice));
    if (totalPrice === null && unitPrice !== null) totalPrice = unitPrice;
  } else if (qty === null) {
    qty = 1;
  }

  return {
    name: name,
    spec: spec,
    qty: qty,
    unitPrice: unitPrice,
    totalPrice: totalPrice,
    taxAmount: taxAmount,
    supplyAmount: supplyAmount,
    pricesIncludeTax: it.pricesIncludeTax,
    finalQty: finalQty,
    mappedCode: mappedCode,
    mappedName: mappedName,
    monthTotal: monthTotal,
    paymentAmount: paymentAmount,
    previousCredit: moneyOrNull_(it.previousCredit),
    recoveryTotal: moneyOrNull_(it.recoveryTotal),
    creditBalance: moneyOrNull_(it.creditBalance),
    currentReceivable: moneyOrNull_(it.currentReceivable || it.outstandingCurrent),
    previousReceivable: moneyOrNull_(it.previousReceivable || it.outstandingPrevious),
    receiptNo: text_(
      it.receiptNo || it.receiptNumber || it.serialNumber ||
      it.slipNo || it.slipNumber || it.documentNo || it.orderNumber || ""
    ),
    serialSeq: text_(it.serialSeq != null ? it.serialSeq : (it.seq != null ? it.seq : "")),
    businessNumber: businessNumber,
    biz: businessNumber,
    vendor: text_(it.vendor || it.supplier || "")
  };
}

/**
 * OCR 직후 추출값을 'OCR디버그' 시트 맨 아래 행에 기록.
 * 일련번호/로직/고유ID 문제를 바로 확인할 수 있다.
 */
function logOcrDebugToSheet_(extracted, debug, fileUrl) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName("OCR디버그");
  if (!sheet) {
    sheet = ss.insertSheet("OCR디버그");
  }
  var headers = [
    "시각", "OCR빌드", "APP버전", "거래처", "거래일", "receiptNo", "serialSeq",
    "고유id로직", "purifiedCombined", "명세서고유ID", "총매입", "품목수",
    "useFallbackId", "파일URL", "비고"
  ];
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    var first = text_(sheet.getRange(1, 1).getValue());
    if (first !== "시각") {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  extracted = extracted || {};
  debug = debug || {};
  var appVer = "";
  try {
    appVer = typeof APP_VERSION !== "undefined" ? String(APP_VERSION) : "";
  } catch (e) {}
  sheet.appendRow([
    nowText_(),
    OCR_BUILD,
    appVer,
    text_(extracted.supplier || debug.vendor || ""),
    text_(extracted.date || debug.date || ""),
    text_(extracted.receiptNo || ""),
    text_(extracted.serialSeq || ""),
    text_(debug.idLogic || ""),
    text_(debug.purifiedCombined || ""),
    text_(debug.uniqueId || ""),
    debug.daily == null ? "" : debug.daily,
    debug.itemCount == null ? ((extracted.items || []).length) : debug.itemCount,
    debug.useFallbackId ? "Y" : "N",
    fileUrl || "",
    text_(debug.note || "")
  ]);
  SpreadsheetApp.flush();
}

/**
 * receiptNo/serialSeq 보강.
 * - serialSeq 만 있으면 거래일+회차로 receiptNo 합성
 * - Gemini 가 필드를 빼먹어도 응답 원문에서 '2026/10/15-1' 패턴 회수
 */
function enrichReceiptNo_(extracted, rawText) {
  extracted = extracted || {};
  var date = text_(extracted.date) || "";
  var receiptNo = text_(extracted.receiptNo || "");
  var serialSeq = text_(extracted.serialSeq || "");

  function applyFound_(found) {
    var parts = purifyReceiptNoParts_(found, date);
    if (!parts.suffix) return false;
    extracted.receiptNo = text_(found);
    extracted.serialSeq = parts.suffix;
    return true;
  }

  // 1) serialSeq 만 있는 경우
  if (!purifyReceiptNoParts_(receiptNo, date).suffix && serialSeq) {
    var seqNum = String(serialSeq).replace(/[^\d]/g, "");
    if (seqNum) {
      extracted.receiptNo = date
        ? date.replace(/-/g, "/") + " -" + seqNum
        : "-" + seqNum;
      extracted.serialSeq = seqNum;
      receiptNo = extracted.receiptNo;
    }
  }

  // 2) 이미 회차가 있으면 종료
  if (purifyReceiptNoParts_(extracted.receiptNo || receiptNo, date).suffix) {
    return extracted;
  }

  // 3) Gemini 원문 JSON/텍스트에서 날짜-회차 패턴 회수
  var blob = String(rawText || "");
  var patterns = [
    /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*-\s*(\d{1,4})/g,
    /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})-(\d{1,4})/g
  ];
  for (var p = 0; p < patterns.length; p++) {
    var re = patterns[p];
    var m;
    while ((m = re.exec(blob)) !== null) {
      var candidate = m[0];
      // 순수 날짜(회차 없는 2026-10-15)는 purify 가 걸러냄
      if (applyFound_(candidate)) return extracted;
    }
  }

  // 4) "일련번호" 근처 토큰
  var near = blob.match(/일련번호[^0-9]{0,12}(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}\s*-?\s*\d{1,4})/);
  if (near && applyFound_(near[1])) return extracted;

  return extracted;
}

/** 거래처관리 A=이름, B=사업자번호 */
function getVendorBizMap_() {
  var map = {};
  try {
    var values = sheet_("거래처관리").getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      var name = text_(values[i][0]);
      if (!name) continue;
      var biz = text_(values[i][1] || "");
      if (!biz) continue;
      map[name] = biz;
      map[normalizeVendor_(name)] = biz;
    }
  } catch (e) {}
  return map;
}

function looksLikeBizNumber_(value) {
  return /^\d{3}-\d{2}-\d{5}$/.test(text_(value));
}

/**
 * businessNumber(사업자번호) 보강.
 * - 프롬프트가 '번호'(상호 위)를 빠뜨린 경우 원문/거래처관리에서 회수
 */
function enrichBusinessNumber_(extracted, rawText) {
  extracted = extracted || {};
  var biz = text_(extracted.biz || extracted.businessNumber || "");
  if (looksLikeBizNumber_(biz)) {
    extracted.biz = biz;
    extracted.businessNumber = biz;
    return extracted;
  }

  // 1) 거래처관리 B열
  try {
    var vmap = getVendorBizMap_();
    var vendor = text_(extracted.supplier || "");
    var fromMaster = vmap[vendor] || vmap[normalizeVendor_(vendor)] || "";
    if (looksLikeBizNumber_(fromMaster)) {
      extracted.biz = fromMaster;
      extracted.businessNumber = fromMaster;
      return extracted;
    }
  } catch (e1) {}

  // 2) Gemini 원문에서 '번호' / 사업자 패턴
  var blob = String(rawText || "");
  var labeled = blob.match(/(?:사업자등록번호|사업자번호|["']번호["']|\b번호\b)[^\d]{0,16}(\d{3}-\d{2}-\d{5})/);
  if (labeled && looksLikeBizNumber_(labeled[1])) {
    extracted.biz = labeled[1];
    extracted.businessNumber = labeled[1];
    return extracted;
  }
  var any = blob.match(/(\d{3}-\d{2}-\d{5})/);
  if (any && looksLikeBizNumber_(any[1])) {
    extracted.biz = any[1];
    extracted.businessNumber = any[1];
    return extracted;
  }

  // 3) receiptNo 에 사업자번호가 잘못 들어간 경우
  var rn = text_(extracted.receiptNo || "");
  if (looksLikeBizNumber_(rn)) {
    extracted.biz = rn;
    extracted.businessNumber = rn;
  }
  return extracted;
}

/** 001.중계_재고관리 상위 폴더 */
function stockRootFolder_() {
  var folders = DriveApp.getFoldersByName("001.중계_재고관리");
  if (folders.hasNext()) return folders.next();
  return null;
}

/** 구글 드라이브 '입고대기' 폴더 (G:\내 드라이브\001.중계_재고관리\입고대기) */
function receiptInboxFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = String(props.getProperty("RECEIPT_INBOX_FOLDER_ID") || "").trim();
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {}
  }
  var root = stockRootFolder_();
  if (root) {
    var kids = root.getFoldersByName("입고대기");
    if (kids.hasNext()) {
      var inbox = kids.next();
      props.setProperty("RECEIPT_INBOX_FOLDER_ID", inbox.getId());
      return inbox;
    }
  }
  var any = DriveApp.getFoldersByName("입고대기");
  if (any.hasNext()) {
    var found = any.next();
    props.setProperty("RECEIPT_INBOX_FOLDER_ID", found.getId());
    return found;
  }
  throw new Error("드라이브에서 '입고대기' 폴더를 찾지 못했습니다. (001.중계_재고관리/입고대기)");
}

/** 구글 드라이브 '처리완료' 폴더 (없으면 입고대기 옆에 생성) */
function receiptDoneFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = String(props.getProperty("RECEIPT_DONE_FOLDER_ID") || "").trim();
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {}
  }
  var root = stockRootFolder_();
  if (root) {
    var kids = root.getFoldersByName("처리완료");
    if (kids.hasNext()) {
      var sibling = kids.next();
      props.setProperty("RECEIPT_DONE_FOLDER_ID", sibling.getId());
      return sibling;
    }
    var createdUnder = root.createFolder("처리완료");
    props.setProperty("RECEIPT_DONE_FOLDER_ID", createdUnder.getId());
    return createdUnder;
  }
  var folders = DriveApp.getFoldersByName("처리완료");
  if (folders.hasNext()) {
    var found = folders.next();
    props.setProperty("RECEIPT_DONE_FOLDER_ID", found.getId());
    return found;
  }
  var created = DriveApp.createFolder("처리완료");
  props.setProperty("RECEIPT_DONE_FOLDER_ID", created.getId());
  return created;
}

function isOcrImageFileName_(name) {
  var m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return !!(m && OCR_IMAGE_EXT_[m[1]]);
}

/**
 * 원재료입고 데이터만 비움 (1행 헤더 유지).
 * 틀고정(헤더 고정) 시트에서 deleteRows 로 비고정 행을 전부 지우면
 * "고정되지 않은 행을 모두 삭제할 수는 없습니다." 오류가 나므로 clearContent 사용.
 */
function clearRawMaterialReceipts_() {
  var sheet = sheet_("원재료입고");
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), 22);
  if (lastRow >= 2) {
    var range = sheet.getRange(2, 1, lastRow, lastCol);
    try {
      range.clearDataValidations();
    } catch (e1) {}
    range.clearContent();
    try {
      range.clearNote();
    } catch (e2) {}
  }
  SpreadsheetApp.flush();
  return {
    ok: true,
    message: "원재료입고 자료를 모두 지웠습니다.",
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : OCR_BUILD
  };
}

function listInboxReceiptFiles_() {
  var folder = receiptInboxFolder_();
  var files = folder.getFiles();
  var list = [];
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (!isOcrImageFileName_(name)) continue;
    list.push({
      id: file.getId(),
      name: name,
      mimeType: file.getMimeType() || "image/jpeg",
      size: file.getSize()
    });
  }
  list.sort(function(a, b) {
    return String(a.name).localeCompare(String(b.name), "ko");
  });
  return list;
}

function moveInboxFileToDone_(file) {
  var done = receiptDoneFolder_();
  var parents = file.getParents();
  while (parents.hasNext()) {
    try {
      parents.next().removeFile(file);
    } catch (e) {}
  }
  done.addFile(file);
}

/** 처리완료용 파일명: [거래일]_[거래처명]_[영수증합계].확장자 */
function buildDoneReceiptFileName_(extracted, originalName) {
  var date = text_((extracted && extracted.date) || "") ||
    Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  var supplier = safeReceiptFilePart_((extracted && extracted.supplier) || "", "거래처미상");
  var daily = moneyOrNull_(extracted && extracted.dailyAmount);
  if (daily === null && extracted && extracted.items && extracted.items.length) {
    var sum = 0;
    for (var s = 0; s < extracted.items.length; s++) sum += num_(extracted.items[s].totalPrice);
    daily = tidy_(sum);
  }
  var amountPart = daily === null ? "0" : String(daily);
  var extMatch = String(originalName || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  var ext = extMatch ? ("." + extMatch[1]) : ".jpg";
  return date + "_" + supplier + "_" + amountPart + ext;
}

/** 파일명 변경 후 처리완료 폴더로 이동 */
function renameAndMoveInboxFileToDone_(file, extracted) {
  var newName = buildDoneReceiptFileName_(extracted, file.getName());
  try {
    if (newName && newName !== file.getName()) file.setName(newName);
  } catch (eRename) {}
  moveInboxFileToDone_(file);
  return newName;
}

/**
 * 입고대기 Drive 파일 1장 OCR → 원재료입고 저장(동일 명세서는 교체) → 파일명 변경 → 처리완료 이동
 * 시트 전체는 지우지 않음.
 */
function processOneDriveReceiptWithGemini(fileId) {
  if (!fileId) throw new Error("fileId 가 없습니다.");
  var file = DriveApp.getFileById(String(fileId));
  var name = file.getName();
  if (!isOcrImageFileName_(name)) {
    throw new Error("이미지 파일이 아닙니다: " + name);
  }
  var blob = file.getBlob();
  var bytes = blob.getBytes();
  var b64 = Utilities.base64Encode(bytes);
  var mime = blob.getContentType() || "image/jpeg";
  var extracted = callGeminiReceipt_(b64, mime);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (eShare) {}
  var fileUrl = "https://drive.google.com/uc?export=view&id=" + file.getId();
  var savedInfo = appendReceiptToSheet_(extracted, fileUrl);
  var saved = typeof savedInfo === "object" ? savedInfo.count : savedInfo;
  var debug = typeof savedInfo === "object" ? savedInfo.debug : null;
  try {
    logOcrDebugToSheet_(extracted, debug || {}, fileUrl);
  } catch (eDbg) {}
  var renamed = name;
  try {
    renamed = renameAndMoveInboxFileToDone_(file, extracted) || name;
  } catch (eMove) {
    // 저장은 됐으므로 이동 실패만 메시지에 남김
  }
  var receiptNo = text_((extracted && extracted.receiptNo) || "");
  var serialSeq = text_((extracted && extracted.serialSeq) || "");
  var uid = debug && debug.uniqueId ? debug.uniqueId : "";
  return {
    ok: true,
    fileId: String(fileId),
    fileName: name,
    renamed: renamed,
    supplier: extracted.supplier || "",
    date: extracted.date || "",
    receiptNo: receiptNo,
    serialSeq: serialSeq,
    uniqueId: uid,
    items: (extracted.items || []).length,
    saved: saved,
    fileUrl: fileUrl,
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : OCR_BUILD,
    ocrBuild: OCR_BUILD,
    message:
      OCR_BUILD + " | " + name + " → " + renamed + " / " +
      (extracted.supplier || "거래처") + " / " + (extracted.date || "") +
      " / receiptNo=" + (receiptNo || "(없음)") +
      " / ID=" + (uid || "(없음)") +
      " / " + saved + "줄"
  };
}

/** API: 원재료입고 비우기 */
function jobClearRawMaterialReceipts(pin) {
  assertPin_(pin);
  return clearRawMaterialReceipts_();
}

/** API: 입고대기 목록 */
function jobListInboxReceipts(pin) {
  assertPin_(pin);
  var files = listInboxReceiptFiles_();
  return {
    ok: true,
    count: files.length,
    files: files,
    folder: "001.중계_재고관리/입고대기",
    message: "입고대기 이미지 " + files.length + "장",
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : OCR_BUILD,
    ocrBuild: OCR_BUILD
  };
}

/**
 * API: 입고대기 대량OCR (타임아웃 방지용 소량 배치)
 * 시트 전체는 지우지 않음. 동일 명세서는 append 시 교체.
 * body: { limit?: number }  (clearFirst 는 무시)
 */
function jobBatchOcrFromInbox(pin, options) {
  assertPin_(pin);
  options = options || {};
  var limit = Math.floor(Number(options.limit) || 5);
  if (limit < 1) limit = 1;
  if (limit > 10) limit = 10;
  var files = listInboxReceiptFiles_();
  var total = files.length;
  var results = [];
  var errors = [];
  var savedRows = 0;
  var n = Math.min(limit, total);
  for (var i = 0; i < n; i++) {
    try {
      var one = processOneDriveReceiptWithGemini(files[i].id);
      results.push(one);
      savedRows += one.saved || 0;
    } catch (err) {
      errors.push({
        name: files[i].name,
        id: files[i].id,
        error: String(err && err.message ? err.message : err)
      });
    }
  }
  var remain = listInboxReceiptFiles_().length;
  return {
    ok: errors.length === 0,
    cleared: false,
    processed: results.length,
    failed: errors.length,
    savedRows: savedRows,
    remain: remain,
    totalBefore: total,
    results: results,
    errors: errors,
    message:
      "대량OCR " + results.length + "장 처리, 입고 " + savedRows + "줄, 실패 " + errors.length +
      ", 입고대기 남음 " + remain + "장",
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : OCR_BUILD,
    ocrBuild: OCR_BUILD
  };
}

function safeReceiptFilePart_(value, fallback) {
  var text = String(value == null || value === "" ? fallback : value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "")
    .slice(0, 40);
  return text || fallback;
}

/** 파일명: [거래일]_[거래처명]_[영수증합계금액].jpg */
function saveReceiptImageToDrive_(base64, mimeType, extracted, index) {
  try {
    var folder = receiptDoneFolder_();
    var bytes = Utilities.base64Decode(base64);
    var blob = Utilities.newBlob(bytes, mimeType || "image/jpeg", "");
    var date = text_((extracted && extracted.date) || "") ||
      Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
    var supplier = safeReceiptFilePart_((extracted && extracted.supplier) || "", "거래처미상");
    var daily = moneyOrNull_(extracted && extracted.dailyAmount);
    if (daily === null && extracted && extracted.items && extracted.items.length) {
      var sum = 0;
      for (var s = 0; s < extracted.items.length; s++) sum += num_(extracted.items[s].totalPrice);
      daily = tidy_(sum);
    }
    var amountPart = daily === null ? "0" : String(daily);
    var baseName = date + "_" + supplier + "_" + amountPart + ".jpg";
    // 동일 이름 충돌 시 접미사
    var name = baseName;
    if (index && Number(index) > 1) {
      name = date + "_" + supplier + "_" + amountPart + "_" + index + ".jpg";
    }
    blob.setName(name);
    var file = folder.createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e2) {}
    // 웹에서 <img> 로 쓰기 쉬운 URL
    return "https://drive.google.com/uc?export=view&id=" + file.getId();
  } catch (err) {
    return "";
  }
}

/**
 * 거래처관리 시트 → { 거래처명: 고유id로직(D열) }
 * 예: "(주)델리앤" -> "일련번호 + 거래처명 + 품목순서번호 + 총매입금액"
 */
function getVendorIdLogic_() {
  var map = {};
  try {
    var values = sheet_("거래처관리").getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      var name = text_(values[i][0]);
      if (!name) continue;
      var logic = text_(values[i][3] || "");
      map[name] = logic;
      map[normalizeVendor_(name)] = logic;
    }
  } catch (e) {}
  return map;
}

/**
 * 델리앤형 receiptNo "2026/10/15 -1" → suffix "1", combined "2026-10-15-1"
 * 날짜만 온 경우(회차 없음)는 suffix 빈 값으로 돌려 호출측에서 구분한다.
 */
function purifyReceiptNoParts_(receiptNo, date) {
  var dateText = text_(date);
  var empty = { suffix: "", combined: "" };
  var raw = text_(receiptNo);
  if (!raw) return empty;

  raw = raw
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/[–—－]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  function pad2_(n) {
    return ("0" + Number(n)).slice(-2);
  }
  function combine_(useDate, num) {
    var d = text_(useDate) || dateText;
    var n = String(num).replace(/^0+(\d)/, "$1");
    if (!n) return empty;
    return { suffix: n, combined: d ? d + "-" + n : n };
  }

  var compact = raw.replace(/\s/g, "");

  // 날짜만이면 회차 없음 (2026-10-15 의 -15 를 회차로 오인하지 않음)
  if (/^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/.test(compact)) return empty;

  // 2026/10/15 -1 | 2026-10-15-1 | 2026.10.15 - 1
  var m = raw.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*-\s*(\d{1,4})\b/);
  if (!m) m = raw.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})-(\d{1,4})\b/);
  if (!m) m = raw.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,3})\b/);
  if (m) {
    var inferred = m[1] + "-" + pad2_(m[2]) + "-" + pad2_(m[3]);
    return combine_(dateText || inferred, m[4]);
  }

  // 회차만: -1 / 1 ~ 999 (연·날짜 오인 방지)
  var onlyNeg = raw.match(/^-\s*(\d{1,3})$/);
  if (onlyNeg) return combine_(dateText, onlyNeg[1]);
  var only = raw.match(/^(\d{1,3})$/);
  if (only) return combine_(dateText, only[1]);

  // "No.-1", "일련 1" 등 끝 회차 (날짜 패턴이 아닐 때만)
  if (!/\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(raw)) {
    var trail = raw.match(/-(\d{1,3})\s*$/);
    if (trail) return combine_(dateText, trail[1]);
  }

  var cleaned = compact;
  if (!cleaned || cleaned === dateText || cleaned === String(dateText).replace(/-/g, "/")) {
    return empty;
  }
  // 사업자번호(630-54-00916)가 receiptNo 로 오면 일련번호로 쓰지 않음
  if (/^\d{3}-\d{2}-\d{5}$/.test(cleaned) || /^\d{3}-\d{2}-\d{5}$/.test(raw)) {
    return empty;
  }
  return { suffix: cleaned, combined: dateText ? dateText + "-" + cleaned : cleaned };
}

function logicNeedsSerial_(logic) {
  return /(전표No|전표번호|일련번호|접수번호|주문번호)/.test(String(logic || ""));
}

function logicHasItemIndex_(logic) {
  return /(품목순서번호|품목순번|순번)/.test(String(logic || "").replace(/\s+/g, ""));
}

/** 기본 고유ID: 거래일_거래처명_총매입금액_품목순서번호 */
function buildFallbackReceiptId_(date, vendor, daily, itemIndex) {
  return [
    text_(date) || "날짜미상",
    text_(vendor) || "거래처미상",
    daily === null || daily === undefined || daily === "" ? "0" : String(daily),
    String(itemIndex)
  ].join("_");
}

/**
 * 고유id로직 키워드 → _ 연결.
 * 예: 일련번호+거래처명+품목순서번호+총매입금액
 *  → 2026-10-15-1_(주)델리앤_1053360_0
 */
function buildReceiptKeyByLogic_(logicText, parts) {
  var logic = text_(logicText)
    .replace(/＋/g, "+")
    .replace(/·/g, "+")
    .replace(/,/g, "+");
  if (!logic) return "";
  var purified = purifyReceiptNoParts_(parts.receiptNo, parts.date);
  var dateText = text_(parts.date) || "날짜미상";
  // 회차 없으면 일단 날짜만이라도 쓰되, serial 슬롯은 date-0 이 아니라 combined 우선
  var serialCombined = purified.combined || "";
  var serialSuffix = purified.suffix || "";

  var tokens = logic.split("+").map(function(t) {
    return String(t || "").replace(/\s+/g, "");
  }).filter(function(t) { return !!t; });

  var chunks = [];
  var usedSerial = false;
  var usedIndex = false;

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    var next = tokens[i + 1] || "";
    var isSerial = (
      token === "전표No" || token === "전표번호" ||
      token === "일련번호" || token === "접수번호" || token === "주문번호"
    );
    var nextIsSerial = (
      next === "전표No" || next === "전표번호" ||
      next === "일련번호" || next === "접수번호" || next === "주문번호"
    );

    if (token === "거래일" && nextIsSerial) {
      chunks.push(serialCombined || dateText);
      usedSerial = true;
      i += 1;
      continue;
    }
    if (token === "거래일") {
      // 뒤에 일련번호가 따로 없고, serialCombined 가 있으면 날짜-회차로 대체
      if (!tokens.some(function(t) {
        return t === "전표No" || t === "전표번호" || t === "일련번호" ||
          t === "접수번호" || t === "주문번호";
      }) && serialCombined) {
        chunks.push(serialCombined);
        usedSerial = true;
      } else {
        chunks.push(dateText);
      }
      continue;
    }
    if (isSerial) {
      var hasDateToken = tokens.indexOf("거래일") >= 0;
      if (hasDateToken) {
        // 거래일이 이미 들어갔으면 회차만 (없으면 스킵하지 말고 combined 전체)
        if (serialSuffix) chunks.push(serialSuffix);
        else if (serialCombined) chunks.push(serialCombined);
      } else {
        chunks.push(serialCombined || dateText);
      }
      usedSerial = true;
      continue;
    }
    if (token === "거래처명" || token === "거래처") {
      chunks.push(text_(parts.vendor) || "거래처미상");
      continue;
    }
    if (token === "사업자번호" || token === "사업자등록번호" || token === "번호") {
      var bizVal = text_(parts.biz || "");
      if (!bizVal && looksLikeBizNumber_(parts.receiptNo)) bizVal = text_(parts.receiptNo);
      chunks.push(bizVal || "사업자미상");
      continue;
    }
    if (token === "총매입금액" || token === "영수증합계") {
      chunks.push(
        parts.daily === null || parts.daily === undefined || parts.daily === ""
          ? "0"
          : String(parts.daily)
      );
      continue;
    }
    if (token === "품목순서번호" || token === "품목순번" || token === "순번") {
      chunks.push(String(parts.itemIndex));
      usedIndex = true;
      continue;
    }
    chunks.push(token);
  }

  // 로직에 일련번호가 있는데 회차를 못 넣었고 combined 가 있으면 맨 앞을 교체
  if (logicNeedsSerial_(logic) && !usedSerial && serialCombined) {
    chunks.unshift(serialCombined);
  }
  // 로직에 품목순서번호가 없어도 행 구분용으로 항상 붙임
  if (!usedIndex && parts.itemIndex !== null && parts.itemIndex !== undefined && parts.itemIndex !== "") {
    chunks.push(String(parts.itemIndex));
  }

  return chunks
    .map(function(c) { return String(c).replace(/\s+/g, ""); })
    .filter(function(c) { return !!c; })
    .join("_");
}

/** 동일 명세서 행 삭제(시트 전체는 유지). 고유ID·전표베이스·날짜+거래처+합계 */
function deleteSameReceiptRows_(sheet, receiptKey, date, vendor, daily) {
  var values = sheet.getDataRange().getValues();
  var toDelete = [];
  var key = text_(receiptKey);
  var dateKey = text_(date);
  var vendorKey = text_(vendor);
  var keyBase = "";
  if (typeof slipBaseId_ === "function" && key) {
    keyBase = slipBaseId_(key, vendorKey) || key;
  }
  for (var i = values.length - 1; i >= 1; i--) {
    var row = values[i];
    if (!row || !String(row.join("")).trim()) continue;
    var uniqueId = text_(row[1]);
    var rowVendor = text_(row[3]);
    if (key && (uniqueId === key || (uniqueId && uniqueId.indexOf(key) === 0))) {
      toDelete.push(i + 1);
      continue;
    }
    if (keyBase && typeof slipBaseId_ === "function") {
      var rowBase = slipBaseId_(uniqueId, rowVendor);
      if (rowBase && rowBase === keyBase) {
        toDelete.push(i + 1);
        continue;
      }
    }
    if (!dateKey || !vendorKey || daily === null) continue;
    var rowDate = text_(row[2]);
    var rowDaily = moneyOrNull_(row[5]);
    if (rowDate === dateKey && rowVendor === vendorKey && rowDaily !== null && Math.abs(rowDaily - daily) < 1) {
      toDelete.push(i + 1);
    }
  }
  for (var d = 0; d < toDelete.length; d++) {
    sheet.deleteRow(toDelete[d]);
  }
  return toDelete.length;
}

function appendReceiptToSheet_(extracted, fileUrl) {
  var sheet = sheet_("원재료입고");
  var items = extracted.items || [];
  if (!items.length) {
    throw new Error("추출된 품목이 없습니다. (" + (extracted.supplier || "") + ")");
  }
  var stamp = nowText_();
  // 캐시 버스팅용 통일 타임스탬프 (영수증UPTIME)
  var receiptUptime = typeof receiptUptimeNow_ === "function"
    ? receiptUptimeNow_()
    : Utilities.formatDate(new Date(), "Asia/Seoul", "yyyyMMdd_HHmmss");
  // T열=영수증위치, 우측=영수증UPTIME 헤더 보장 (위치 변동에 indexOf 로 대응)
  var metaCols = typeof ensureReceiptMetaCols_ === "function"
    ? ensureReceiptMetaCols_(sheet, 19, 22)
    : { urlCol: 19, uptimeCol: 22 };
  var urlCol = metaCols.urlCol;
  var uptimeCol = metaCols.uptimeCol;
  var date = text_(extracted.date) || Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  var vendor = text_(extracted.supplier) || "거래처미상";
  // 사업자번호 최종 보강 (상호 위 '번호' / 거래처관리 B열)
  extracted = enrichBusinessNumber_(extracted, "");
  var biz = text_(extracted.biz || extracted.businessNumber || "");
  var receiptNo = text_(extracted.receiptNo || "");
  var serialSeq = text_(extracted.serialSeq || "");
  // serialSeq 만 있어도 일련번호 합성 (델리앤 등)
  if (!purifyReceiptNoParts_(receiptNo, date).suffix && serialSeq) {
    var seqOnly = String(serialSeq).replace(/[^\d]/g, "");
    if (seqOnly) {
      receiptNo = date.replace(/-/g, "/") + " -" + seqOnly;
      extracted.receiptNo = receiptNo;
    }
  }
  // 사업자번호가 receiptNo 로 오인된 경우 정리
  if (looksLikeBizNumber_(receiptNo) && (!biz || biz === receiptNo)) {
    biz = receiptNo;
    extracted.biz = biz;
  }
  var daily = moneyOrNull_(extracted.dailyAmount);
  // G열 명세서누적금액 = accumulatedAmount (없으면 creditBalance·monthTotal, 최종 null → 빈칸)
  var accumulatedAmount = resolveAccumulatedAmount_(extracted);
  var monthTotal = accumulatedAmount; // 하위호환 변수명
  var recoveryTotal = moneyOrNull_(extracted.recoveryTotal);
  var previousCredit = moneyOrNull_(extracted.previousCredit);
  // 원재료입고 중간결제(S열)는 사용하지 않음. 주류 회수/보증금은 V(회수합계)만 저장.
  // 거래처매입누적 중간결제는 웹앱에서 사용자가 입력.
  if (daily === null) {
    var sum = 0;
    for (var s = 0; s < items.length; s++) sum += num_(items[s].totalPrice);
    daily = tidy_(sum);
  }

  var vendorLogicMap = getVendorIdLogic_();
  var idLogic = text_(
    vendorLogicMap[vendor] ||
    vendorLogicMap[normalizeVendor_(vendor)] ||
    ""
  );
  var mapKeys = Object.keys(vendorLogicMap || {});
  var purifiedEarly = purifyReceiptNoParts_(receiptNo, date);
  // 로직이 있을 때는 가급적 로직으로 조합. 회차 없으면 아래에서 날짜만이라도 넣고 index 부여.
  var useFallbackId = !idLogic;
  var note = "";
  if (!idLogic) {
    note = "고유id로직 없음(거래처관리 D열 매칭실패). mapKeys=" + mapKeys.length;
  } else if (!purifiedEarly.suffix) {
    note = "일련번호 회차 추출실패. receiptNo=[" + receiptNo + "]";
  }

  // 재삭제용 전표 키(품목순서 제외) — 회차 포함 시 같은 전표 재삭제에 사용
  var receiptKey;
  if (useFallbackId) {
    receiptKey = purifiedEarly.combined
      ? [purifiedEarly.combined, vendor, daily === null ? "0" : String(daily)].join("_")
      : [date, vendor, daily === null ? "0" : String(daily)].join("_");
  } else {
    receiptKey = buildReceiptKeyByLogic_(
      String(idLogic).replace(/품목순서번호|품목순번|순번/g, ""),
      { receiptNo: receiptNo, date: date, vendor: vendor, daily: daily, itemIndex: "", biz: biz }
    );
  }
  if (!receiptKey) {
    receiptKey = [date, vendor, daily === null ? "0" : String(daily)].join("_");
  }

  var master = {};
  try {
    master = materialMaster_();
  } catch (e) {
    master = {};
  }

  var rows = [];
  var itemIndex = 0;
  var firstUniqueId = "";
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    applyKnownMapping_(it, master); // PC: 별칭으로 코드/공식명 재확인
    var name = text_(it.name);
    if (!name) continue;
    var qty = moneyOrNull_(it.qty);
    if (qty === null) qty = num_(it.qty);
    var unitPrice = moneyOrNull_(it.unitPrice);
    var totalPrice = moneyOrNull_(it.totalPrice);
    var spec = text_(it.spec);
    var code = text_(it.mappedCode || "");
    var official = text_(it.mappedName || "");
    if (code && master[code] && !official) official = text_(master[code].name);
    // 할인·쿠폰: 금액(음수)만 저장, 재고 수량·원재료코드 영향 없음
    var discountLine = isDiscountOcrItem_(name, spec, qty, totalPrice);
    if (discountLine) {
      qty = 0;
      spec = "할인";
      code = "";
      official = "";
      if (totalPrice !== null && totalPrice > 0) totalPrice = tidy_(-Math.abs(totalPrice));
      if (unitPrice !== null && unitPrice > 0) unitPrice = tidy_(-Math.abs(unitPrice));
    }
    // PC: reflected_quantity 우선, 없으면 Gemini finalQty, 마지막에 영수증 수량
    var finalQty = null;
    if (discountLine) {
      finalQty = 0;
    } else {
      try {
        finalQty = reflectedQuantity_(master, code, spec, qty);
      } catch (e2) {}
      if (finalQty === null) finalQty = moneyOrNull_(it.finalQty);
      if (finalQty === null) finalQty = qty;
    }

    // 품목행 전용 명세서 고유ID
    // 목표 예: 2026-10-15-1_(주)델리앤_1053360_0
    var uniqueId;
    if (useFallbackId) {
      if (purifiedEarly.combined) {
        uniqueId = [
          purifiedEarly.combined,
          vendor,
          daily === null ? "0" : String(daily),
          String(itemIndex)
        ].join("_");
      } else {
        uniqueId = buildFallbackReceiptId_(date, vendor, daily, itemIndex);
      }
    } else {
      uniqueId = buildReceiptKeyByLogic_(idLogic, {
        receiptNo: receiptNo,
        date: date,
        vendor: vendor,
        daily: daily,
        itemIndex: itemIndex,
        biz: biz
      });
      if (!uniqueId) {
        uniqueId = purifiedEarly.combined
          ? [purifiedEarly.combined, vendor, daily === null ? "0" : String(daily), String(itemIndex)].join("_")
          : buildFallbackReceiptId_(date, vendor, daily, itemIndex);
      }
    }
    if (!firstUniqueId) firstUniqueId = uniqueId;
    itemIndex += 1;

    // A~T + U전일채권 + V회수합계(보증금) + 영수증위치/영수증UPTIME
    // G열(index 6): 명세서누적금액 ← accumulatedAmount (null이면 "")
    // S열(index 18, 구 중간결제/입금): 항상 빈칸 — 아무 로직도 이 열을 쓰지 않음
    var line = [
      stamp,
      uniqueId,
      date,
      vendor,
      biz,
      daily === null ? "" : daily,
      accumulatedAmount === null ? "" : accumulatedAmount,
      name,
      spec,
      qty === null ? "" : qty,
      unitPrice === null ? "" : unitPrice,
      totalPrice === null ? "" : totalPrice,
      code,
      official,
      finalQty === null ? "" : finalQty,
      false,
      "검수대기",
      "",
      "",
      fileUrl || "",
      previousCredit === null ? "" : previousCredit,
      recoveryTotal === null ? "" : recoveryTotal
    ];
    var needWidth = Math.max(line.length, urlCol + 1, uptimeCol + 1);
    while (line.length < needWidth) line.push("");
    line[urlCol] = fileUrl || "";
    line[uptimeCol] = receiptUptime;
    rows.push(line);
  }
  if (!rows.length) throw new Error("저장할 품목 행이 없습니다.");

  // 같은 명세서 고유ID 기존 행 삭제 후 재적재 (PC OCR과 동일)
  deleteSameReceiptRows_(sheet, receiptKey, date, vendor, daily);

  var start = sheet.getLastRow() + 1;
  var end = start + rows.length - 1;
  var width = rows[0].length;
  sheet.getRange(start, 1, rows.length, width).setValues(rows);

  // M열(원재료코드) 체크박스 잔여 제거. 체크박스는 P(실물 검수)만.
  try {
    sheet.getRange(start, 13, rows.length, 1).clearDataValidations();
    sheet.getRange("P" + start + ":P" + end).insertCheckboxes();
  } catch (e3) {}
  SpreadsheetApp.flush();

  // 거래처매입누적에 같은 전표가 있으면 영수증위치·영수증UPTIME 동기화 (Drive 조회 없음)
  try {
    if (typeof upsertBalanceReceiptImage_ === "function" && fileUrl) {
      upsertBalanceReceiptImage_(vendor, date, daily, fileUrl, receiptUptime);
    }
  } catch (eImg) {}

  return {
    count: rows.length,
    debug: {
      vendor: vendor,
      date: date,
      idLogic: idLogic,
      purifiedCombined: purifiedEarly.combined || "",
      uniqueId: firstUniqueId,
      daily: daily,
      itemCount: rows.length,
      useFallbackId: useFallbackId,
      note: note
    }
  };
}

