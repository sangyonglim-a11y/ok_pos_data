/* =========================================================
   중계고기파티 재고 SPA
   ========================================================= */

// 주의: 예전 hardcode URL 은 옛 배포였음.
// Apps Script 안에서는 google.script.run 을 우선 사용 (지금 연 배포=서버).
const API_URL = ""; // fetch 백업용. 비우면 script.run 만 사용
const USE_MOCK_WHEN_EMPTY = false;
// 개발 중 로그인 생략 (완료 후 false 로 바꾸세요)
const SKIP_LOGIN = true;
const DEV_PIN = "9338892";
const UI_VERSION = "2026-11-14-j138"; // 화면 표시용. 서버 APP_VERSION 과 맞추세요.
const MONTH_STORAGE_KEY = "stockOpenMonth";

/** 헤더용 축약 버전 (예: 2026-11-03-j23 → v0023) */
function uiVersionShort_() {
  const m = String(UI_VERSION || "").match(/j(\d+)\s*$/i);
  const n = m ? Number(m[1]) : 0;
  return "v" + String(Math.max(0, Math.min(9999, n))).padStart(4, "0");
}

const MENUS = [
  { id: "inspect", label: "입고검수", icon: "fa-clipboard-check", badge: "count" },
  { id: "balance", label: "거래처 금액 검증", icon: "fa-scale-balanced", badge: "warn" },
  { id: "stock", label: "재고관리", icon: "fa-boxes-stacked", badge: "low" },
  { id: "order", label: "발주관리", icon: "fa-cart-shopping", badge: "low" },
  { id: "price", label: "단가 추이", icon: "fa-chart-line", badge: null },
  { id: "pos", label: "POS 판매내역", icon: "fa-cash-register", badge: null },
];

// 원재료 코드 관리 = 조회/편집 도구 (배치작업 위). OCR·환산·재고계산은 해당 화면으로 이관
const QUICK_TOOLS = [
  { id: "register", no: "1", title: "원재료 코드 관리", desc: "원재료관리 코드를 조회·수정하고, 미등록 품목을 등록합니다.", kind: "web", action: "register", tag: "조회" },
];
const JOB_CARDS = [
  { id: "inboxOcr", no: "1", title: "입고대기 대량OCR", desc: "Drive 입고대기 폴더 명세서를 OCR 등록합니다. 동일 명세서는 시트에서 교체하고, 파일은 처리완료로 이동합니다.", kind: "inboxOcr" },
  { id: "close", no: "2", title: "월마감 진행", desc: "이번 달 행은 남기고 남은 재고를 다음 달 기초재고로 추가합니다.", kind: "web", action: "jobMonthlyClose", confirm: "이번 달 기록은 그대로 두고, 남은 재고를 다음 달 기초재고로 추가할까요?", danger: true },
];
function allActionCards_() {
  return QUICK_TOOLS.concat(JOB_CARDS);
}
const STOCK_CATEGORIES = ["고기", "주류", "하이볼", "식사", "사이드", "음료", "야채", "공산품", "기타"];

function readStoredMonth_() {
  try {
    const m = sessionStorage.getItem(MONTH_STORAGE_KEY) || "";
    return /^\d{4}-\d{2}$/.test(m) ? m : "";
  } catch (e) {
    return "";
  }
}

function storeSelectedMonth_(month) {
  try {
    if (month) sessionStorage.setItem(MONTH_STORAGE_KEY, month);
    else sessionStorage.removeItem(MONTH_STORAGE_KEY);
  } catch (e) {}
}

/** 선택월 1일~말일 → POS 기간 */
function applyPosRangeForMonth_(month) {
  const m = String(month || "");
  if (!/^\d{4}-\d{2}$/.test(m)) return;
  const parts = m.split("-");
  const y = Number(parts[0]);
  const mo = Number(parts[1]);
  const last = new Date(y, mo, 0);
  const dd = String(last.getDate()).padStart(2, "0");
  state.posStart = m + "-01";
  state.posEnd = m + "-" + dd;
}

function isSelectedMonthLatest_() {
  if (!state.selectedMonth) return true;
  if (!state.latestMonth) return true;
  return state.selectedMonth === state.latestMonth;
}

function isSelectedMonthHasInventory_() {
  if (state.hasInventoryMonth != null) return !!state.hasInventoryMonth;
  const list = state.inventoryMonths || [];
  return list.indexOf(state.selectedMonth) >= 0;
}

function applyMonthMeta_(data) {
  if (!data || typeof data !== "object") return;
  const list = Array.isArray(data.months)
    ? data.months
    : Array.isArray(data.monthsList)
      ? data.monthsList
      : null;
  if (list && list.length) state.monthOptions = list.slice();
  if (Array.isArray(data.inventoryMonths)) state.inventoryMonths = data.inventoryMonths.slice();
  if (data.hasInventoryMonth != null) state.hasInventoryMonth = !!data.hasInventoryMonth;
  if (data.latestMonth) state.latestMonth = data.latestMonth;
  if (data.month) {
    state.selectedMonth = data.month;
    state.month = data.month;
    state.stockMonth = data.month;
    storeSelectedMonth_(data.month);
  }
  state.isLatestMonth = data.isLatest != null
    ? !!data.isLatest
    : isSelectedMonthLatest_();
  if (data.hasInventoryMonth == null && state.selectedMonth) {
    state.hasInventoryMonth = (state.inventoryMonths || []).indexOf(state.selectedMonth) >= 0;
  }
  if (data.closeNag != null) state.closeNag = !!data.closeNag;
  if (data.closeNagMessage != null) state.closeNagMessage = String(data.closeNagMessage || "");
  if (data.calendarMonth) state.calendarMonth = String(data.calendarMonth);
}

function monthPayload_() {
  return state.selectedMonth ? { month: state.selectedMonth } : {};
}

function monthSelectHtml_(id) {
  const opts = state.monthOptions && state.monthOptions.length
    ? state.monthOptions
    : (state.selectedMonth ? [state.selectedMonth] : []);
  const cur = state.selectedMonth || "";
  const latest = state.latestMonth || "";
  if (!opts.length) {
    return `<span class="text-[11px] text-black/40 shrink-0">—</span>`;
  }
  return `<select id="${id}" class="compact-control rounded-lg border border-paper-line bg-white px-2 text-xs min-w-[7.5rem] shrink-0">
      ${opts.map((m) => `<option value="${esc(m)}" ${m === cur ? "selected" : ""}>${esc(m)}${m === latest ? " (현재)" : ""}</option>`).join("")}
    </select>`;
}

function lastDayOfMonthYmd_(ym) {
  const m = String(ym || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(y, mo, 0);
  const dd = String(last.getDate()).padStart(2, "0");
  return m[1] + "-" + m[2] + "-" + dd;
}

function clampStockUsageDay_(day, monthYm) {
  const ym = String(monthYm || state.selectedMonth || "").slice(0, 7);
  const last = lastDayOfMonthYmd_(ym);
  let d = String(day || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}$/.test(ym) || !last) return d;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d.slice(0, 7) !== ym) {
    const today = todayYmdLocal_();
    return today.slice(0, 7) === ym ? today : last;
  }
  if (d > last) return last;
  if (d < ym + "-01") return ym + "-01";
  return d;
}

function ensureStockUsageDay_() {
  state.stockUsageDay = clampStockUsageDay_(state.stockUsageDay, state.selectedMonth);
  return state.stockUsageDay;
}

/** 재고 기준월 옆 — 당일사용량 조회일 */
function stockUsageDayInputHtml_() {
  const ym = String(state.selectedMonth || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) return "";
  const day = ensureStockUsageDay_();
  const last = lastDayOfMonthYmd_(ym);
  return `<input type="date" id="stockUsageDay" value="${esc(day)}" min="${esc(ym)}-01" max="${esc(last)}"
    class="compact-control rounded-lg border border-paper-line bg-white px-1.5 text-xs min-w-[8.5rem] shrink-0"
    title="당일사용량 기준일" />`;
}

/** 화면제목 + w-30 공백 + 기준월 콤보 (+ 우측 요약). 월 스코프 화면 공통. */
function screenTitleRowHtml_(opts) {
  const title = opts.title || "";
  const mobileTitle = opts.mobileTitle != null ? opts.mobileTitle : title;
  const selectId = opts.selectId || "";
  const select = selectId ? monthSelectHtml_(selectId) : "";
  const afterSelect = opts.afterSelectHtml || "";
  const h2 = opts.h2Class || "text-xl font-bold tracking-tight";
  const h2m = opts.mobileH2Class || "text-[16px] font-bold tracking-tight";
  const right = opts.rightHtml || "";
  const rightMobile = opts.rightMobileHtml;
  const titleWithSelect_ = (h2Class, t) => `
    <div class="flex items-center min-w-0 gap-1.5">
      <h2 class="${h2Class} shrink-0">${esc(t)}</h2>
      <span class="w-3 lg:w-[7.5rem] shrink-0" aria-hidden="true"></span>
      ${select}
      ${afterSelect}
    </div>`;
  if (opts.splitMobile) {
    return `
      <div class="desktop-only flex items-center justify-between gap-3">
        ${titleWithSelect_(h2, title)}
        ${right ? `<div class="text-right text-sm text-black/50">${right}</div>` : ""}
      </div>
      <div class="mobile-only flex items-center justify-between gap-2">
        ${titleWithSelect_(h2m, mobileTitle)}
        ${rightMobile != null ? rightMobile : ""}
      </div>`;
  }
  return `
    <div class="flex items-center justify-between gap-3">
      ${titleWithSelect_(h2, title)}
      ${right ? `<div class="desktop-only text-right text-sm text-black/50">${right}</div>` : ""}
    </div>`;
}

function pastMonthBannerHtml_() {
  const parts = [];
  if (!isSelectedMonthLatest_()) {
    parts.push("재고 열린달(" + (state.latestMonth || "—") + ")이 아닙니다. 발주는 열린달에서만 가능합니다.");
  }
  if (!isSelectedMonthHasInventory_()) {
    parts.push("재고 시트에 이 달 행이 없습니다. 월마감 전이면 입고검수·입고반영만 하세요. 재고계산은 할 수 없습니다.");
  } else if (!isSelectedMonthLatest_()) {
    parts.push("재고계산·입고반영은 선택월에 적용됩니다.");
  }
  if (!parts.length) return "";
  return `<div class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900">${esc(parts.join(" "))}</div>`;
}

/** 매월 5일~ 전월 미마감 독촉 (차단 아님) */
function closeNagBannerHtml_() {
  if (!state.closeNag || !state.closeNagMessage) return "";
  return `<div class="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-[11px] text-red-800 font-medium"><i class="fa-solid fa-bell mr-1"></i>${esc(state.closeNagMessage)}</div>`;
}

function todayYmdLocal_() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function addCalendarDaysYmd_(ymd, days) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date();
  d.setDate(d.getDate() + (Number(days) || 0));
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + mo + "-" + day;
}

function normalizeDeliveryMethodFront_(raw) {
  const t = String(raw || "").trim();
  if (t === "마트구매" || t === "거래처배송" || t === "택배") return t;
  if (/마트/.test(t)) return "마트구매";
  if (/택배|퀵|우편/.test(t)) return "택배";
  if (/배송|거래처/.test(t)) return "거래처배송";
  return "거래처배송";
}

function defaultExpectedDateFront_(deliveryMethod) {
  const method = normalizeDeliveryMethodFront_(deliveryMethod);
  return addCalendarDaysYmd_(todayYmdLocal_(), method === "택배" ? 2 : 1);
}

function nextMonthTextFront_(yyyyMm) {
  const m = String(yyyyMm || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return "";
  let y = Number(m[1]);
  let mo = Number(m[2]) + 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  return y + "-" + String(mo).padStart(2, "0");
}

async function onSelectedMonthChange_(month) {
  const next = String(month || "").trim();
  if (!next || next === state.selectedMonth) return;
  state.selectedMonth = next;
  storeSelectedMonth_(next);
  state.stockUsageDay = clampStockUsageDay_("", next);
  applyPosRangeForMonth_(next);
  if (state.menu === "inspect") await loadInspection();
  else if (state.menu === "stock" || state.menu === "order") await loadStock();
  else if (state.menu === "balance") await loadBalance();
  else if (state.menu === "price") await loadPrices();
  else if (state.menu === "pos" && window.PosSales) await window.PosSales.load();
  else render();
}

function bindMonthSelect_(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    onSelectedMonthChange_(el.value);
  });
}

async function withMonthRetry_(loader) {
  try {
    await loader(false);
  } catch (err) {
    const msg = (err && err.message) || "";
    if (/기준월/.test(msg) && state.selectedMonth) {
      state.selectedMonth = "";
      storeSelectedMonth_("");
      toast(msg + " → 현재월로 다시 불러옵니다");
      await loader(true);
      return;
    }
    throw err;
  }
}

const state = {
  pin: SKIP_LOGIN ? DEV_PIN : (sessionStorage.getItem("stockPin") || ""),
  menu: "inspect",
  query: "",
  searchText: "", // 입력 중 값(Enter/돋보기 전까지 query 에 반영 안 함)
  filterDate: "전체",
  filterVendor: "전체",
  filterInspect: "pending", // pending=미검수만, all=전체
  selectedMonth: readStoredMonth_(),
  latestMonth: "",
  monthOptions: [],
  inventoryMonths: [],
  hasInventoryMonth: true,
  isLatestMonth: true,
  closeNag: false,
  closeNagMessage: "",
  calendarMonth: "",
  month: "",
  rows: [],
  pendingOrders: [], // 발주내역 상태=대기 [{sheetRow,code,name,vendor,qtyBox,expectedDate,deliveryMethod,memo,...}]
  adjustedOrders: [], // 발주내역 상태=조정완료 (뱃지·적용 가드)
  pendingOrderDrafts: {}, // sheetRow → { adjust, memo }
  pendingOrderSaveBusy: false,
  vendorOptions: [], // 거래처관리 이름 목록 (전표 헤더 콤보)
  draft: {}, // rowNumber -> boolean (화면 체크 상태)
  selectedId: null,
  loading: false,
  applying: false,
  error: "",
  toast: "",
  warnCount: 0,
  apiVersion: "",
  balanceRows: [],
  balanceWarnOnly: true,
  balanceRebuildAt: "",
  balanceLoading: false,
  balanceError: "",
  balanceQuery: "",
  balanceSearchText: "", // 입력 중 값(Enter/돋보기 전까지 balanceQuery 에 반영 안 함)
  balanceSelectedRow: null, // 우측 영수증 패널용 시트 행번호
  balanceScrollTop: 0, // 호환용(captureViewScroll_ 이 맵으로 통합)
  /** 화면별 스크롤 위치 복원: scrollAreaId → scrollTop */
  scrollRestoreMap: {},
  /** 저장 후 포커스 복원 { type:'stock'|'pay'|..., ... } */
  focusRestore: null,
  stockMonth: "",
  stockRows: [],
  stockCategory: "전체",
  stockLowOnly: false,
  stockAdjustMode: false, // true면 조정입고·조정로스 열 표시
  stockUsageDay: "", // 당일사용량 조회일 yyyy-MM-dd (기준월 안)
  orderCategory: "전체",
  orderQuery: "",
  orderLowOnly: false, // 발주관리 기본: 전체 표시
  orderVendorEditKey: "", // 주문처변경 중인 업체키
  stockQuery: "",
  stockLoading: false,
  stockError: "",
  stockLowCount: 0,
  stockCalcBusy: false, // 재고 화면 [실시간 재고 계산] 중복 클릭 방지
  /** 발주 대상 체크·발주수량(Box) 초안: code|row → { checked, orderQty, orderQtyEdited } */
  stockOrderDrafts: {},
  stockOrderModalOpen: false,
  stockOrderModalText: "",
  stockOrderModalItems: [], // 모달 확정용 [{code,name,vendor,qtyBox}]
  stockOrderSaveBusy: false,
  priceMonths: 0, // 0=선택월 당월, 1/3/6/12=비교 기간
  priceRows: [],
  priceSelectedKey: null,
  priceListScrollTop: 0,
  priceCategory: "전체",
  priceQuery: "",
  priceSearchText: "", // Enter/돋보기 전까지 priceQuery 에 반영 안 함
  priceLoading: false,
  priceError: "",
  priceStart: "",
  priceEnd: "",
  jobBusy: false,
  jobMessage: "",
  unregGroups: [],
  unregMaterials: [],
  unregDrafts: {}, // key -> { checked, name, mode, code, category }
  unregSelectedKey: null, // 우측 영수증 패널에 표시할 미등록 품목
  unregScrollTop: 0, // 좌측 미등록 리스트 스크롤 복원용 (전체 render fallback)
  /** 우측 영수증 줌 유지: key -> { src, scale, x, y } */
  unregReceiptZoomByKey: {},
  unregFilter: "전체", // 전체 | 대표 | 별칭 | 미등록 | 등록제외
  unregOpen: false,
  ocrOpen: false,
  ocrItems: [], // { id, name, preview, base64, mimeType }
  ocrBusy: false,
  ocrStatus: "",
  ocrDone: 0,
  lastScrollTop: 0, // 실물 검수 리스트 스크롤 복원용
  ocrTotal: 0,
  mobileFiltersOpen: false, // 모바일: 날짜·거래처·보기 필터 접힘
  posStart: "",
  posEnd: "",
  posKeyword: "",
  posSearchText: "",
  posRows: [],
  posLoading: false,
  posError: "",
};

const root = document.getElementById("root");

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(value) {
  const text = String(value ?? "").trim();
  const iso = text.match(/(\d{4})[-/.](\d{2})[-/.](\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const eng = text.match(/(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
  if (eng) {
    const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
    const mm = months[eng[2]] || "01";
    const dd = String(eng[3]).padStart(2, "0");
    return `${eng[4]}-${mm}-${dd}`;
  }
  return text;
}

function toast(message) {
  state.toast = message;
  render();
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    state.toast = "";
    render();
  }, 2200);
}

function moneyText(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = moneyNum(value);
  if (n == null) return String(value);
  if (Math.abs(n - Math.round(n)) < 1e-9) return Math.round(n).toLocaleString("ko-KR");
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
}

/** 단가 추이 전용: 환산단가 반올림 정수 표시 */
function moneyTextInt(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = moneyNum(value);
  if (n == null) return String(value);
  return Math.round(n).toLocaleString("ko-KR");
}

/** 마이너스 금액 강조 클래스 (할인·쿠폰) */
function moneyNegClass(value) {
  const n = moneyNum(value);
  return n != null && n < 0 ? "text-[#b42318]" : "";
}

function balanceVisible() {
  const q = state.balanceQuery.trim().toLowerCase();
  return (state.balanceRows || []).filter((r) => {
    if (state.balanceWarnOnly && r.status === "OK") return false;
    if (!q) return true;
    return `${r.vendor} ${r.date} ${r.status}`.toLowerCase().includes(q);
  });
}

/**
 * 불일치 차액.
 *  - 명세 누적 있음(일반): 명세서누적 − 당월누적계산
 *  - 누적 미제공/당일만: 명세서금액 − 결제/조정 (결제/조정에 명세서금액 입력 시 0)
 */
function balanceMismatchDiff_(row) {
  if (!row) return null;
  const month = moneyNum(row.month);
  const check = moneyNum(row.checkTotal);
  const daily = moneyNum(row.daily);
  const pay = moneyNum(row.payment);
  const p = pay == null ? 0 : pay;
  // 누적 없거나, 누적=당일인데 당월누적계산이 더 큰 경우(이월 포함) → 당일 결제 검증
  const noCumulative =
    month == null ||
    (daily != null && check != null && Math.abs(month - daily) < 0.5 && check > month + 0.5);
  if (noCumulative) {
    if (daily == null) return null;
    const diff = tidyMoneyDiff_(daily - p);
    return diff === 0 ? null : diff;
  }
  if (month != null && check != null) {
    const diff = tidyMoneyDiff_(month - check);
    return diff === 0 ? null : diff;
  }
  return null;
}

function tidyMoneyDiff_(n) {
  if (!Number.isFinite(n)) return 0;
  const t = Math.round(n * 100) / 100;
  return Math.abs(t) < 1e-9 ? 0 : t;
}

/** 검증 상태 뱃지. 금액 불일치·입금/수금 재확인 시 차액 함께 표시 */
function balanceStatusBadge(status, row) {
  const s = String(status || "").trim() || "금액 불일치";
  let cls = "bg-[#fee2e2] text-[#b91c1c]"; // 금액 불일치 · 기타
  if (s === "OK") cls = "bg-[#e7f6ee] text-[#1f7a4c]";
  else if (s === "미수금 이월") cls = "bg-[#e8e8e8] text-[#555555]";
  else if (s === "수금 재확인" || s === "입금 재확인") cls = "bg-[#ffedd5] text-[#c2410c]";
  else if (s === "확인요망") cls = "bg-[#ffedd5] text-[#c2410c]";
  let label = s;
  let tip = s;
  const month = moneyNum(row && row.month);
  const daily = moneyNum(row && row.daily);
  const check = moneyNum(row && row.checkTotal);
  const dailyPayMode =
    month == null ||
    (daily != null && check != null && Math.abs(month - daily) < 0.5 && check > month + 0.5);
  const showDiff = s === "금액 불일치" || s === "입금 재확인" || s === "수금 재확인";
  if (showDiff) {
    const diff = balanceMismatchDiff_(row);
    if (diff != null) {
      const signed = (diff > 0 ? "+" : "") + moneyText(diff);
      label = `${s} ${signed}`;
      if (s === "입금 재확인" || s === "수금 재확인") {
        tip = `명세서누적 − 당월누적계산 = ${signed} (잔액이 줄었는데 결제/조정이 비어 있음 · 입금 확인 후 차액 입력)`;
      } else {
        tip = dailyPayMode
          ? `명세서금액 − 결제/조정 = ${signed} (중간결제: 결제/조정에 명세서금액을 입력 → OK)`
          : `명세서누적 − 당월누적계산 = ${signed}`;
      }
    } else if (s === "금액 불일치" && dailyPayMode) {
      tip = "누적 없는 전표 · 결제/조정에 명세서금액을 입력한 뒤 검증 계산하세요";
    } else if (s === "입금 재확인" || s === "수금 재확인") {
      tip = "잔액이 줄었는데 결제/조정이 비어 있습니다. 입금 여부를 확인하세요.";
    }
  }
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] sm:text-[11px] max-[1023px]:text-[12px] font-bold whitespace-nowrap ${cls}" title="${esc(tip)}">${esc(label)}</span>`;
}

function balanceRebuildAtHtml_() {
  const t = String(state.balanceRebuildAt || "").trim();
  if (!t) {
    return `<span class="text-[10px] text-black/40 self-center whitespace-nowrap">마지막 검증 —</span>`;
  }
  return `<span class="text-[10px] text-black/45 self-center whitespace-nowrap" title="검증 계산 마지막 수행 시각">마지막 ${esc(t)}</span>`;
}

/** 명세서금액 옆 회수금(보증금/V열) 뱃지 */
function balanceRecoveryBadge(recovery) {
  if (recovery == null || recovery === "" || !Number.isFinite(Number(recovery)) || Number(recovery) === 0) {
    return "";
  }
  return `<span class="ml-1 inline-flex items-center rounded-full bg-[#eef2ff] text-[#3730a3] px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap">회수 ${esc(moneyText(recovery))}</span>`;
}

function selectedBalanceRow() {
  const n = Number(state.balanceSelectedRow);
  if (!n) return null;
  return (state.balanceRows || []).find((r) => r.row === n) || null;
}

/** 좌측 표/카드의 is-selected 만 갱신 (전체 render 없음) */
function markBalanceRowSelected_(rowNumber) {
  document.querySelectorAll("[data-balance-select].is-selected").forEach((el) => {
    el.classList.remove("is-selected");
  });
  document.querySelectorAll(`[data-balance-select="${rowNumber}"]`).forEach((el) => {
    el.classList.add("is-selected");
  });
}

/**
 * 공통 명세서 이미지 뷰어 (휠 줌 + 드래그 팬 + 더블클릭 리셋)
 * 실물검수 · 금액검증 · 미등록 등 우측 패널에서 재사용
 * @param {HTMLElement} containerElement overflow-hidden 컨테이너
 * @param {HTMLElement} imageElement <img>
 * @returns {{ reset: Function }|null}
 */
function initImageViewer(containerElement, imageElement) {
  const frame = containerElement;
  const img = imageElement;
  if (!frame || !img) return null;
  if (frame.dataset.viewerBound === "1") return frame.__imageViewer || null;

  const MIN_SCALE = 0.5;
  const MAX_SCALE = 5;
  const STEP = 0.1;

  frame.dataset.viewerBound = "1";
  frame.classList.add("image-viewer", "panel-zoom-frame");
  img.classList.add("image-viewer-img", "panel-zoom-img");
  img.setAttribute("draggable", "false");
  img.setAttribute("data-panel-zoom", "1");

  // 미등록 영수증: 상태변경·리렌더 후에도 줌 유지
  const isUnregPreview = img.id === "unregReceiptPreview";
  const zoomKey = isUnregPreview ? String(state.unregSelectedKey || "") : "";
  const savedZoom =
    isUnregPreview && zoomKey && state.unregReceiptZoomByKey
      ? state.unregReceiptZoomByKey[zoomKey]
      : null;
  const sameSrc =
    savedZoom &&
    savedZoom.src &&
    String(img.getAttribute("src") || "").split("?")[0] === String(savedZoom.src || "").split("?")[0];

  let scale = sameSrc && savedZoom.scale ? Number(savedZoom.scale) || 1 : 1;
  let tx = sameSrc && savedZoom.x != null ? Number(savedZoom.x) || 0 : 0;
  let ty = sameSrc && savedZoom.y != null ? Number(savedZoom.y) || 0 : 0;
  let isDown = false;
  let lastX = 0;
  let lastY = 0;

  const apply = (s, x, y) => {
    img.style.transform = "translate(" + x + "px, " + y + "px) scale(" + s + ")";
    img.dataset.zoomScale = String(s);
    img.dataset.panX = String(x);
    img.dataset.panY = String(y);
    const moved = Math.abs(s - 1) > 0.01 || Math.abs(x) > 0.5 || Math.abs(y) > 0.5;
    img.title = moved
      ? "드래그로 이동 · 휠 확대·축소 · 더블클릭 초기화"
      : "휠로 확대·축소 · 드래그로 이동 · 더블클릭 초기화";
  };

  const persistUnregZoom_ = () => {
    if (!isUnregPreview || !zoomKey) return;
    if (!state.unregReceiptZoomByKey) state.unregReceiptZoomByKey = {};
    state.unregReceiptZoomByKey[zoomKey] = {
      src: img.getAttribute("src") || "",
      scale,
      x: tx,
      y: ty
    };
  };

  const commit = (nextScale, nextTx, nextTy, dragging) => {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    tx = nextTx;
    ty = nextTy;
    if (dragging) {
      img.classList.add("is-dragging");
      frame.classList.add("is-panning");
    } else {
      img.classList.remove("is-dragging");
      frame.classList.remove("is-panning");
    }
    apply(scale, tx, ty);
    persistUnregZoom_();
  };

  apply(scale, tx, ty);

  frame.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY < 0 ? 1 : -1;
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + dir * STEP));
      if (clamped === scale) return;
      const rect = frame.getBoundingClientRect();
      const mx = e.clientX - (rect.left + rect.width / 2);
      const my = e.clientY - (rect.top + rect.height / 2);
      const ratio = clamped / scale;
      commit(clamped, mx - (mx - tx) * ratio, my - (my - ty) * ratio, false);
    },
    { passive: false }
  );

  frame.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    frame.classList.add("is-panning");
    img.classList.add("is-dragging");
    e.preventDefault();
  });

  frame.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    e.preventDefault();
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    commit(scale, tx + dx, ty + dy, true);
  });

  const endPan = () => {
    if (!isDown) return;
    isDown = false;
    frame.classList.remove("is-panning");
    img.classList.remove("is-dragging");
  };

  frame.addEventListener("mouseup", endPan);
  frame.addEventListener("mouseleave", endPan);

  frame.addEventListener("dblclick", (e) => {
    e.preventDefault();
    commit(1, 0, 0, false);
  });

  img.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  const api = {
    reset: () => commit(1, 0, 0, false)
  };
  frame.__imageViewer = api;
  return api;
}

/** 우측 명세서 프레임들에 initImageViewer 일괄 바인딩 */
function bindPanelReceiptViewers_(root) {
  const scope = root || document;
  scope.querySelectorAll(".panel-zoom-frame, .image-viewer").forEach((frame) => {
    const img =
      frame.querySelector("img[data-panel-zoom]") ||
      frame.querySelector("img.panel-zoom-img") ||
      frame.querySelector("img.image-viewer-img") ||
      frame.querySelector("img");
    if (img) initImageViewer(frame, img);
  });
}

/** @deprecated bindPanelReceiptViewers_ 사용 */
function bindPanelReceiptZoom_(root) {
  bindPanelReceiptViewers_(root);
}

/** 명세서 뷰어 프레임 HTML (공통 마크업) */
function receiptViewerFrameHtml_(imgUrl, opts) {
  const o = opts || {};
  const idAttr = o.id ? ` id="${esc(o.id)}"` : "";
  const minH = o.minH || "280px";
  const tip = o.tip || "휠 확대·축소 · 드래그 이동 · 더블클릭 초기화";
  return `<div class="receipt-frame panel-zoom-frame image-viewer flex-1 overflow-hidden rounded-2xl border border-paper-line bg-[#f7f4ef]" style="min-height:${esc(minH)}">
      <img${idAttr} data-panel-zoom="1" draggable="false"
        src="${esc(imgUrl)}" alt="명세서"
        class="panel-zoom-img image-viewer-img" title="휠로 확대·축소 · 드래그로 이동 · 더블클릭 초기화" />
    </div>
    <p class="text-[10px] text-black/40 mt-1 shrink-0">${esc(tip)}</p>`;
}

/** 우측 영수증 패널만 DOM 교체 + 인플레이스 줌 바인딩 */
function updateBalanceReceiptPanel_() {
  const panel = document.getElementById("balanceReceiptPanel");
  if (!panel) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = balanceReceiptPanelHtml().trim();
  const next = wrap.firstElementChild;
  if (!next) return;
  panel.replaceWith(next);
  bindPanelReceiptViewers_(next);
}

/**
 * 행 클릭 시 전체 render() 하지 않음 → 스크롤 점프 방지
 * (이전: state 변경 후 render() → 좌측 테이블 innerHTML 재생성 → scrollTop=0)
 */
function selectBalanceRow_(rowNumber, opts) {
  const n = Number(rowNumber);
  const focusPay = opts && opts.focusPay;
  if (!n) return;
  if (state.balanceSelectedRow === n) {
    if (focusPay) {
      requestAnimationFrame(() => {
        const el = document.querySelector(`input[data-pay="${n}"]`);
        if (el) el.focus();
      });
    }
    return;
  }
  state.balanceSelectedRow = n;
  // 요구사항1·2: 우측 패널 + 선택 하이라이트만 부분 업데이트
  markBalanceRowSelected_(n);
  updateBalanceReceiptPanel_();
  if (focusPay) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`input[data-pay="${n}"]`);
      if (el) el.focus();
    });
  }
}

async function loadBalance() {
  state.balanceLoading = true;
  state.balanceError = "";
  render();
  try {
    await withMonthRetry_(async () => {
      const data = await api("balanceList", monthPayload_());
      applyMonthMeta_(data);
      if (data.balanceRebuildAt != null) state.balanceRebuildAt = String(data.balanceRebuildAt || "");
      state.balanceRows = data.rows || [];
      state.warnCount = data.warnCount || state.balanceRows.filter((r) => r.status !== "OK").length;
      if (data.version) state.apiVersion = data.version;
      if (state.balanceWarnOnly && state.warnCount === 0 && state.balanceRows.length) {
        state.balanceWarnOnly = false;
      }
      const visible = balanceVisible();
      if (!visible.some((r) => r.row === state.balanceSelectedRow)) {
        state.balanceSelectedRow = visible[0] ? visible[0].row : null;
      }
    });
  } catch (err) {
    state.balanceError = err.message || "불러오지 못했습니다.";
  } finally {
    state.balanceLoading = false;
    render();
  }
}

async function savePayment(rowNumber, raw) {
  try {
    const result = await api("saveBalancePayment", { row: rowNumber, payment: raw });
    const row = state.balanceRows.find((r) => r.row === rowNumber);
    if (row) row.payment = result.payment;
    toast(result.message || "결제/조정 저장");
    markFocusRestore_({ type: "pay", row: rowNumber });
    render();
  } catch (err) {
    toast(err.message || "저장 실패");
  }
}

function isLowStock(item) {
  const short = stockShortageQty(item);
  if (short != null && short > 0) return true;
  return item.safety !== null && item.safety !== "" && Number(item.stock) <= Number(item.safety);
}

/** 부족수량: 시트 L열 값 우선. 0 이하·빈값 → null(화면 빈칸) */
function stockShortageQty(item) {
  if (item && item.shortage != null && item.shortage !== "") {
    const n = Number(item.shortage);
    if (!isNaN(n) && n > 0) return n;
    return null;
  }
  if (!item || item.safety === null || item.safety === "") return null;
  const short = Number(item.safety) - Number(item.stock);
  return short > 0 ? short : null;
}

function stockShortage(item) {
  return stockShortageQty(item);
}

function stockShortageCellHtml_(item) {
  const short = stockShortageQty(item);
  if (short == null) return "";
  return `<span class="text-red-500 font-bold tabular-nums">${esc(moneyText(short))}</span>`;
}

function stockOrderKey_(r) {
  return String((r && (r.code || r.row)) || "");
}

function defaultStockOrderDraft_(r, recommend) {
  const delivery = normalizeDeliveryMethodFront_(r && r.defaultDeliveryMethod);
  return {
    checked: false,
    orderQty: recommend,
    orderQtyEdited: false,
    vendorMode: "v1",
    vendorCustom: "",
    deliveryMethod: delivery,
    expectedDate: defaultExpectedDateFront_(delivery),
    expectedEdited: false
  };
}

/** 발주 초안. 추천발주(Box)·거래처·배송·예정일 기본값 유지 */
function ensureStockOrderDraft_(r) {
  const key = stockOrderKey_(r);
  if (!key) {
    return defaultStockOrderDraft_(r, "");
  }
  if (!state.stockOrderDrafts) state.stockOrderDrafts = {};
  let d = state.stockOrderDrafts[key];
  const recommend =
    r.recommendOrderBox === "" || r.recommendOrderBox == null ? "" : String(r.recommendOrderBox);
  if (!d) {
    d = defaultStockOrderDraft_(r, recommend);
    state.stockOrderDrafts[key] = d;
  } else {
    if (!d.orderQtyEdited) d.orderQty = recommend;
    if (!d.vendorMode) d.vendorMode = "v1";
    if (d.vendorCustom == null) d.vendorCustom = "";
    if (!d.deliveryMethod) {
      d.deliveryMethod = normalizeDeliveryMethodFront_(r.defaultDeliveryMethod);
    }
    if (!d.expectedEdited) {
      d.expectedDate = defaultExpectedDateFront_(d.deliveryMethod);
    }
  }
  return d;
}

function syncStockOrderDraftsFromRows_() {
  const prev = state.stockOrderDrafts || {};
  const next = {};
  (state.stockRows || []).forEach((r) => {
    const key = stockOrderKey_(r);
    if (!key) return;
    const recommend =
      r.recommendOrderBox === "" || r.recommendOrderBox == null ? "" : String(r.recommendOrderBox);
    const old = prev[key];
    const delivery = old && old.deliveryMethod
      ? normalizeDeliveryMethodFront_(old.deliveryMethod)
      : normalizeDeliveryMethodFront_(r.defaultDeliveryMethod);
    next[key] = {
      checked: !!(old && old.checked),
      orderQty: old && old.orderQtyEdited ? String(old.orderQty ?? "") : recommend,
      orderQtyEdited: !!(old && old.orderQtyEdited),
      vendorMode: (old && old.vendorMode) || "v1",
      vendorCustom: old && old.vendorCustom != null ? String(old.vendorCustom) : "",
      deliveryMethod: delivery,
      expectedDate:
        old && old.expectedEdited && old.expectedDate
          ? String(old.expectedDate)
          : defaultExpectedDateFront_(delivery),
      expectedEdited: !!(old && old.expectedEdited)
    };
  });
  state.stockOrderDrafts = next;
}

function resolveStockOrderVendor_(r, d) {
  const mode = (d && d.vendorMode) || "v1";
  if (mode === "v2") {
    return String(r.vendor2 || "").trim() || String(r.vendor1 || r.primaryVendor || "").trim();
  }
  if (mode === "custom") {
    return String((d && d.vendorCustom) || "").trim();
  }
  return String(r.vendor1 || r.primaryVendor || "").trim();
}

function orderUnitSpecLabel_(r) {
  // 발주·재고 표시: 입고단위/규격만 (재고단위 제외)
  const spec = String((r && r.spec) || "").trim();
  return spec || "—";
}

function stockOrderVendorSelectHtml_(r, draft, orderKey) {
  const v1 = String(r.vendor1 || r.primaryVendor || "").trim();
  const v2 = String(r.vendor2 || "").trim();
  const mode = draft.vendorMode || "v1";
  // 표시는 이름만 (거래처1/2 접두어 없음). value로 v1/v2/custom 구분
  const opts = [
    `<option value="v1" ${mode === "v1" ? "selected" : ""}>${esc(v1 || "(미지정)")}</option>`
  ];
  if (v2 && v2 !== v1) {
    opts.push(`<option value="v2" ${mode === "v2" ? "selected" : ""}>${esc(v2)}</option>`);
  }
  opts.push(`<option value="custom" ${mode === "custom" ? "selected" : ""}>직접입력</option>`);
  return `<div class="flex items-center gap-0.5 min-w-[4.5rem] max-w-[8rem]">
    <select data-stock-order-vendor-mode="${esc(orderKey)}" class="compact-control w-full rounded border border-paper-line bg-white px-0.5 text-[10px] leading-tight" title="거래처">
      ${opts.join("")}
    </select>
    <input data-stock-order-vendor-custom="${esc(orderKey)}" type="text"
      value="${esc(draft.vendorCustom || "")}"
      placeholder="거래처명"
      class="compact-control w-[4.5rem] rounded border border-paper-line bg-white px-0.5 text-[10px] ${mode === "custom" ? "" : "hidden"}" />
  </div>`;
}

/** 체크된 발주 행 수집 (수량>0) */
function collectStockOrderItems_() {
  const items = [];
  (state.stockRows || []).forEach((r) => {
    const key = stockOrderKey_(r);
    const d = state.stockOrderDrafts && state.stockOrderDrafts[key];
    if (!d || !d.checked) return;
    const qtyN = moneyNum(d.orderQty);
    if (qtyN == null || !(qtyN > 0)) return;
    const vendor = resolveStockOrderVendor_(r, d) || "거래처 미지정";
    const delivery = normalizeDeliveryMethodFront_(
      d.deliveryMethod || r.defaultDeliveryMethod
    );
    const expected =
      d.expectedEdited && /^\d{4}-\d{2}-\d{2}$/.test(String(d.expectedDate || ""))
        ? String(d.expectedDate)
        : defaultExpectedDateFront_(delivery);
    items.push({
      code: String(r.code || "").trim(),
      name: String(r.name || r.code || "").trim() || "(품목명 없음)",
      vendor: vendor,
      qtyBox: Math.round(qtyN),
      deliveryMethod: delivery,
      expectedDate: expected,
      orderKey: key
    });
  });
  return items;
}

/** 발주 품목 배열 → 거래처별 카톡 텍스트 */
function buildStockOrderKakaoTextFromItems_(items) {
  const list = items || [];
  if (!list.length) return "";
  const groups = {};
  const orderKeys = [];
  list.forEach((it) => {
    const vendor = String(it.vendor || "").trim() || "거래처 미지정";
    if (!groups[vendor]) {
      groups[vendor] = [];
      orderKeys.push(vendor);
    }
    groups[vendor].push(it);
  });
  return orderKeys
    .map((vendor) => {
      const lines = groups[vendor].map((it) => {
        const extra =
          (it.deliveryMethod ? " · " + it.deliveryMethod : "") +
          (it.expectedDate ? " · 예정 " + it.expectedDate : "");
        return "- " + it.name + " : " + it.qtyBox + "박스" + extra;
      });
      return "==== [" + vendor + "] 발주 요청 ====\n" + lines.join("\n");
    })
    .join("\n\n");
}

function refreshStockOrderModalFromItems_() {
  const items = Array.isArray(state.stockOrderModalItems) ? state.stockOrderModalItems : [];
  state.stockOrderModalText = buildStockOrderKakaoTextFromItems_(items);
}

function openStockOrderKakaoModal_() {
  if (!isSelectedMonthLatest_()) {
    toast("현재 기준월에서만 발주할 수 있습니다");
    return;
  }
  const items = collectStockOrderItems_();
  if (!items.length) {
    toast("체크된 발주 품목과 발주수량(Box)을 확인해 주세요");
    return;
  }
  state.stockOrderModalItems = items;
  state.stockOrderModalText = buildStockOrderKakaoTextFromItems_(items);
  state.stockOrderModalOpen = true;
  state.stockOrderSaveBusy = false;
  render();
}

function closeStockOrderKakaoModal_() {
  if (state.stockOrderSaveBusy) return;
  state.stockOrderModalOpen = false;
  state.stockOrderModalItems = [];
  render();
}

function clearStockOrderChecks_() {
  Object.keys(state.stockOrderDrafts || {}).forEach((key) => {
    const d = state.stockOrderDrafts[key];
    if (d) d.checked = false;
  });
}

async function confirmSaveStockOrderList_() {
  if (state.stockOrderSaveBusy) return;
  const items = Array.isArray(state.stockOrderModalItems) ? state.stockOrderModalItems.slice() : [];
  if (!items.length) {
    toast("저장할 발주 품목이 없습니다");
    return;
  }
  const okConfirm = window.confirm(
    "발주 " + items.length + "건을 발주내역(대기)에 저장할까요?\n저장 후 체크는 모두 해제됩니다."
  );
  if (!okConfirm) return;
  state.stockOrderSaveBusy = true;
  render();
  try {
    const result = await api("jobSaveOrderList", { orderItems: items });
    if (result && result.version) state.apiVersion = result.version;
    clearStockOrderChecks_();
    state.stockOrderModalOpen = false;
    state.stockOrderModalItems = [];
    state.stockOrderModalText = "";
    toast(result.message || "발주 내역이 성공적으로 저장되었습니다.");
  } catch (err) {
    toast((err && err.message) || "발주 저장에 실패했습니다.");
  } finally {
    state.stockOrderSaveBusy = false;
    render();
  }
}

async function copyStockOrderKakaoText_() {
  const text = String(state.stockOrderModalText || "");
  if (!text) {
    toast("복사할 내용이 없습니다");
    return;
  }
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e0) {
    ok = false;
  }
  if (!ok) {
    try {
      const ta = document.getElementById("stockOrderKakaoText");
      if (ta) {
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
      }
    } catch (e1) {
      ok = false;
    }
  }
  if (!ok) {
    toast("복사에 실패했습니다. 텍스트를 직접 선택해 복사해 주세요");
    return;
  }
  state.stockOrderModalOpen = false;
  toast("복사되었습니다. 카톡에 붙여넣기 하세요.");
  render();
}

function stockOrderKakaoModalHtml() {
  if (!state.stockOrderModalOpen) return "";
  const busy = !!state.stockOrderSaveBusy;
  const items = state.stockOrderModalItems || [];
  const itemCount = items.length;
  const deliveryOpts = ["마트구매", "거래처배송", "택배"];
  const editRows = items
    .map((it, idx) => {
      const method = normalizeDeliveryMethodFront_(it.deliveryMethod);
      return `<tr class="border-t border-paper-line">
        <td class="px-1.5 py-1 text-[11px] max-w-[7rem] truncate" title="${esc(it.name)}">${esc(it.name)}</td>
        <td class="px-1.5 py-1 text-[11px] max-w-[5.5rem] truncate" title="${esc(it.vendor)}">${esc(it.vendor)}</td>
        <td class="px-1 py-1">
          <select data-order-modal-delivery="${idx}" class="compact-control w-full rounded border border-paper-line bg-white px-1 text-[10px]" ${busy ? "disabled" : ""}>
            ${deliveryOpts
              .map(
                (m) =>
                  `<option value="${esc(m)}" ${m === method ? "selected" : ""}>${esc(m)}</option>`
              )
              .join("")}
          </select>
        </td>
        <td class="px-1 py-1">
          <input type="date" data-order-modal-expected="${idx}" value="${esc(it.expectedDate || "")}"
            class="compact-control w-full rounded border border-paper-line bg-white px-1 text-[10px]" ${busy ? "disabled" : ""} />
        </td>
      </tr>`;
    })
    .join("");
  return `
    <div id="stockOrderKakaoBackdrop" class="fixed inset-0 z-[85] bg-black/45 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div id="stockOrderKakaoPanel" class="w-full sm:max-w-2xl max-h-[92vh] overflow-hidden rounded-t-2xl sm:rounded-2xl bg-paper-card shadow-panel flex flex-col">
        <div class="px-4 py-3 border-b border-paper-line flex items-center justify-between gap-2 shrink-0">
          <div>
            <h3 class="font-bold text-lg">발주 카톡 · 확정</h3>
            <p class="text-[11px] text-black/45">거래처별로 묶었습니다. 배송·입고예정일(달력일 기본, 수정 가능) 확인 후 복사·저장하세요.</p>
          </div>
          <button type="button" id="btnStockOrderKakaoCloseTop" class="compact-control rounded-lg border border-paper-line bg-white px-3 text-xs" ${busy ? "disabled" : ""}>닫기</button>
        </div>
        <div class="px-4 pt-3 shrink-0 max-h-40 overflow-auto scroll-thin">
          <table class="w-full text-[11px]">
            <thead class="text-black/50">
              <tr>
                <th class="px-1.5 py-1 text-left font-medium">품목</th>
                <th class="px-1.5 py-1 text-left font-medium">거래처</th>
                <th class="px-1 py-1 text-left font-medium">배송</th>
                <th class="px-1 py-1 text-left font-medium">입고예정일</th>
              </tr>
            </thead>
            <tbody>${editRows}</tbody>
          </table>
        </div>
        <div class="p-4 flex-1 min-h-0 overflow-hidden flex flex-col">
          <textarea id="stockOrderKakaoText" readonly
            class="w-full h-48 sm:h-56 flex-1 min-h-[12rem] rounded-xl border border-paper-line bg-white px-3 py-2.5 text-[13px] leading-relaxed text-[#1a1a1a] font-mono whitespace-pre resize-y focus:outline-none focus:ring-2 focus:ring-[#facc15]/80">${esc(state.stockOrderModalText || "")}</textarea>
        </div>
        <div class="px-4 py-3 border-t border-paper-line flex flex-wrap gap-2 justify-end shrink-0 bg-[#f7f4ef]">
          <button type="button" id="btnStockOrderKakaoClose" class="compact-control rounded-lg border border-paper-line bg-white px-4 text-xs" ${busy ? "disabled" : ""}>닫기</button>
          <button type="button" id="btnStockOrderKakaoCopy" class="compact-control rounded-lg bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-bold px-4 text-xs" ${busy ? "disabled" : ""}>클립보드 복사</button>
          <button type="button" id="btnStockOrderKakaoConfirm"
            class="compact-control rounded-lg bg-[#1d4ed8] hover:bg-[#1e40af] text-white font-bold px-4 text-xs disabled:opacity-60 disabled:cursor-not-allowed"
            ${busy || !itemCount ? "disabled" : ""}
            title="발주내역 시트에 대기 상태로 저장">
            ${busy
              ? '<i class="fa-solid fa-spinner fa-spin mr-1"></i>저장 중…'
              : '<i class="fa-solid fa-floppy-disk mr-1"></i>발주 확정 및 DB 저장'}
          </button>
        </div>
      </div>
    </div>`;
}

function stockCategories() {
  const present = new Set(state.stockRows.map((r) => r.category || "").filter(Boolean));
  const ordered = STOCK_CATEGORIES.filter((c) => present.has(c));
  const extras = Array.from(present).filter((c) => !ordered.includes(c)).sort((a, b) => a.localeCompare(b, "ko"));
  return ["전체", ...ordered, ...extras];
}

function stockCategoryRank_(category) {
  const i = STOCK_CATEGORIES.indexOf(String(category || ""));
  return i >= 0 ? i : STOCK_CATEGORIES.length + 1;
}

function stockVendorName_(r) {
  return String(r.vendor1 || r.primaryVendor || r.vendor || "").trim();
}

/** 거래처 → 원재료코드 */
function compareStockRows_(a, b) {
  const va = stockVendorName_(a);
  const vb = stockVendorName_(b);
  if (!va && vb) return 1;
  if (va && !vb) return -1;
  const vcmp = va.localeCompare(vb, "ko");
  if (vcmp) return vcmp;
  return String(a.code || "").localeCompare(String(b.code || ""), "ko", { numeric: true });
}

/** 구분+거래처 섹션 그룹. 그룹 정렬: 거래처 → 구분, 품목: 원재료코드 */
function stockSectionGroups_(rows) {
  const map = {};
  const keys = [];
  (rows || []).forEach((r) => {
    const category = r.category || "기타";
    const vendor = stockVendorName_(r) || "거래처 미지정";
    const key = category + "\t" + vendor;
    if (!map[key]) {
      map[key] = { key, category, vendor, items: [] };
      keys.push(key);
    }
    map[key].items.push(r);
  });
  keys.sort((ka, kb) => {
    const a = map[ka];
    const b = map[kb];
    const vcmp = a.vendor.localeCompare(b.vendor, "ko");
    if (vcmp) return vcmp;
    const ca = stockCategoryRank_(a.category);
    const cb = stockCategoryRank_(b.category);
    if (ca !== cb) return ca - cb;
    return a.category.localeCompare(b.category, "ko");
  });
  return keys.map((k) => {
    const g = map[k];
    g.items.sort((a, b) =>
      String(a.code || "").localeCompare(String(b.code || ""), "ko", { numeric: true })
    );
    return g;
  });
}

function stockCurrentShortageLabel_(r) {
  const qty = (v) => (v === null || v === undefined || v === "" ? "—" : moneyText(v));
  const short = stockShortageQty(r);
  if (short == null) {
    return `<span class="tabular-nums font-semibold">${esc(qty(r.stock))}</span>`;
  }
  return `<span class="tabular-nums font-semibold">${esc(qty(r.stock))}</span><span class="text-red-500 font-bold tabular-nums"> (${esc(moneyText(short))})</span>`;
}

function stockVisible() {
  const q = state.stockQuery.trim().toLowerCase();
  return state.stockRows
    .filter((r) => {
      if (state.stockCategory !== "전체" && (r.category || "") !== state.stockCategory) return false;
      if (state.stockLowOnly && !isLowStock(r)) return false;
      if (!q) return true;
      return `${r.name} ${r.code} ${r.category} ${stockVendorName_(r)}`.toLowerCase().includes(q);
    })
    .sort(compareStockRows_);
}

function orderRowVendor_(r) {
  const d = ensureStockOrderDraft_(r);
  return resolveStockOrderVendor_(r, d) || stockVendorName_(r) || "거래처 미지정";
}

/** 발주: 업체 → 원재료코드 */
function compareOrderRows_(a, b) {
  const va = orderRowVendor_(a);
  const vb = orderRowVendor_(b);
  const vcmp = va.localeCompare(vb, "ko");
  if (vcmp) return vcmp;
  return String(a.code || "").localeCompare(String(b.code || ""), "ko", { numeric: true });
}

function orderVisible() {
  const q = state.orderQuery.trim().toLowerCase();
  return state.stockRows
    .filter((r) => {
      if (state.orderCategory !== "전체" && (r.category || "") !== state.orderCategory) return false;
      if (state.orderLowOnly && !isLowStock(r)) return false;
      if (!q) return true;
      return `${r.name} ${r.code} ${r.category} ${orderRowVendor_(r)}`.toLowerCase().includes(q);
    })
    .sort(compareOrderRows_);
}

function orderVendorKey_(vendor) {
  return String(vendor || "거래처 미지정");
}

/** 업체별 그룹 [{ vendor, key, items, allChecked }] */
function orderVendorGroups_(rows) {
  const map = {};
  const order = [];
  (rows || []).forEach((r) => {
    const vendor = orderRowVendor_(r);
    const key = orderVendorKey_(vendor);
    if (!map[key]) {
      map[key] = { vendor, key, items: [] };
      order.push(key);
    }
    map[key].items.push(r);
  });
  return order.map((k) => {
    const g = map[k];
    g.items.sort((a, b) =>
      String(a.code || "").localeCompare(String(b.code || ""), "ko", { numeric: true })
    );
    g.allChecked = g.items.length > 0 && g.items.every((r) => !!ensureStockOrderDraft_(r).checked);
    return g;
  });
}

/**
 * 업체 정렬 순서를 유지한 채 왼쪽 단부터 아래로 채우고 다음 단으로 이동.
 * 행수(업체헤더+품목) 기준으로 단 높이를 비슷하게 맞춤.
 */
function splitOrderGroupsCols_(groups, colCount) {
  const list = groups || [];
  const nCols = Math.max(1, Number(colCount) || 1);
  const cols = Array.from({ length: nCols }, () => []);
  if (!list.length) return cols;

  const weights = list.map((g) => (g.items && g.items.length ? g.items.length : 0) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const target = total / nCols;

  let col = 0;
  let filled = 0;
  for (let i = 0; i < list.length; i++) {
    cols[col].push(list[i]);
    filled += weights[i];
    // 마지막 단이 아니고, 목표 높이에 도달했으며 다음 그룹이 있으면 다음 단으로
    if (col < nCols - 1 && filled >= target * (col + 1)) {
      col += 1;
    }
  }
  return cols;
}

function orderVendorOptions_() {
  const set = {};
  (state.stockRows || []).forEach((r) => {
    const v1 = String(r.vendor1 || r.primaryVendor || r.vendor || "").trim();
    const v2 = String(r.vendor2 || "").trim();
    if (v1) set[v1] = true;
    if (v2) set[v2] = true;
  });
  return Object.keys(set).sort((a, b) => a.localeCompare(b, "ko"));
}

function applyOrderVendorChange_(vendorKey, newVendor) {
  const name = String(newVendor || "").trim();
  if (!name) {
    toast("주문처 이름을 입력하세요");
    return;
  }
  const groups = orderVendorGroups_(orderVisible());
  const g = groups.find((x) => x.key === vendorKey);
  if (!g) return;
  g.items.forEach((r) => {
    const d = ensureStockOrderDraft_(r);
    d.vendorMode = "custom";
    d.vendorCustom = name;
  });
  state.orderVendorEditKey = "";
  render();
  toast("주문처를 " + name + " (으)로 변경했습니다");
}

async function loadStockOrOrder_() {
  await loadStock();
}

async function loadStock() {
  state.stockLoading = true;
  state.stockError = "";
  render();
  try {
    await withMonthRetry_(async () => {
      const day = ensureStockUsageDay_();
      const data = await api("stockList", { ...monthPayload_(), day });
      applyMonthMeta_(data);
      state.stockMonth = data.month || state.selectedMonth || "";
      if (data.day) state.stockUsageDay = clampStockUsageDay_(data.day, state.stockMonth || state.selectedMonth);
      state.stockRows = data.rows || [];
      syncStockOrderDraftsFromRows_();
      state.stockLowCount = data.lowCount != null
        ? data.lowCount
        : state.stockRows.filter(isLowStock).length;
      if (data.version) state.apiVersion = data.version;
      const cats = stockCategories();
      if (!cats.includes(state.stockCategory)) state.stockCategory = "전체";
      if (!cats.includes(state.orderCategory)) state.orderCategory = "전체";
    });
  } catch (err) {
    state.stockError = err.message || "불러오지 못했습니다.";
  } finally {
    state.stockLoading = false;
    render();
  }
}

/** 재고·발주 화면 [실시간 재고 계산] — 선택월(D11 A). 재고행 없는 달은 불가 */
async function runStockCalculate_() {
  if (state.stockCalcBusy || state.jobBusy) return;
  if (!isSelectedMonthHasInventory_()) {
    toast("재고 시트에 이 달 행이 없습니다. 월마감 전 다음달은 입고검수만 하세요");
    return;
  }
  state.stockCalcBusy = true;
  state.stockError = "";
  render();
  try {
    const result = await api("jobCalculateInventory", monthPayload_());
    if (result.version) state.apiVersion = result.version;
    applyMonthMeta_(result);
    toast("재고 계산이 완료되었습니다");
    state.jobMessage = result.message || "재고 계산이 완료되었습니다.";
    await loadStock();
  } catch (err) {
    state.stockError = err.message || "재고 계산에 실패했습니다.";
    toast(state.stockError);
    render();
  } finally {
    state.stockCalcBusy = false;
    render();
  }
}

async function saveStockField(rowNumber, code, kind, raw) {
  try {
    const result = await api("saveStock", { row: rowNumber, code, kind, value: raw });
    const row = state.stockRows.find((r) => r.row === rowNumber);
    if (row) {
      if (result.adjustmentIn != null) row.adjustmentIn = result.adjustmentIn;
      row.adjustment = result.adjustment;
      row.stock = result.stock;
      row.safety = result.safety;
      row.display = result.display;
      row.shortage = result.shortage != null ? result.shortage : stockShortageQty(row);
      const conv = Number(row.conversion) > 0 ? Number(row.conversion) : 1;
      const shortN = stockShortageQty(row);
      row.recommendOrderBox =
        shortN != null && shortN > 0 ? Math.ceil(shortN / conv) : "";
      const draft = ensureStockOrderDraft_(row);
      if (!draft.orderQtyEdited) {
        draft.orderQty =
          row.recommendOrderBox === "" || row.recommendOrderBox == null
            ? ""
            : String(row.recommendOrderBox);
      }
    }
    state.stockLowCount = state.stockRows.filter(isLowStock).length;
    toast(result.message || "저장했습니다.");
    markFocusRestore_({ type: "stock", row: rowNumber, kind: kind });
    render();
  } catch (err) {
    toast(err.message || "저장 실패");
  }
}

function priceCategories() {
  const present = new Set(state.priceRows.map((r) => r.category || "").filter(Boolean));
  const ordered = STOCK_CATEGORIES.filter((c) => present.has(c));
  const extras = Array.from(present).filter((c) => !ordered.includes(c)).sort((a, b) => a.localeCompare(b, "ko"));
  return ["전체", ...ordered, ...extras];
}

function priceVisible() {
  const q = state.priceQuery.trim().toLowerCase();
  return state.priceRows.filter((r) => {
    if (state.priceCategory !== "전체" && (r.category || "") !== state.priceCategory) return false;
    if (!q) return true;
    return `${r.name} ${r.code} ${r.category}`.toLowerCase().includes(q);
  });
}

function selectedPriceItem() {
  const visible = priceVisible();
  if (!visible.length) return null;
  return visible.find((r) => r.key === state.priceSelectedKey) || visible[0];
}

function syncPriceQueryFromInput_() {
  state.priceQuery = String(state.priceSearchText || "");
}

function applyPriceSearch() {
  syncPriceQueryFromInput_();
  const visible = priceVisible();
  if (!visible.some((r) => r.key === state.priceSelectedKey)) {
    state.priceSelectedKey = visible[0] ? visible[0].key : null;
  }
  render();
}

function priceChartSvg(points, stockUnit) {
  if (!points || points.length < 2) {
    return `<div class="h-44 grid place-items-center text-sm text-black/40 rounded-2xl border border-dashed border-paper-line bg-white">단가 기록이 2건 이상이면 추이가 그려집니다.</div>`;
  }
  const unitLabel = stockUnit ? `원/${stockUnit}` : "원";
  const vals = points.map((p) => Math.round(Number(p.price)));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = max === min ? Math.max(max * 0.05, 1) : (max - min) * 0.1;
  const lo = min - pad;
  const hi = max + pad;
  const w = 720;
  const h = 176;
  const coords = points.map((p, i) => {
    const x = points.length === 1 ? w / 2 : (i / (points.length - 1)) * (w - 24) + 12;
    const y = h - 12 - ((Math.round(Number(p.price)) - lo) / (hi - lo)) * (h - 24);
    return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), p };
  });
  const dots = coords.map((c, i) => {
    const tip = `${c.p.date} · 환산 ${moneyTextInt(c.p.price)}${unitLabel}`;
    return `<circle class="price-dot" data-tip="${esc(tip)}" data-idx="${i}" cx="${c.x}" cy="${c.y}" r="4" fill="#163028" style="cursor:pointer">
      <title>${esc(tip)}</title>
    </circle>`;
  }).join("");
  return `
    <div class="price-chart-wrap">
      <svg viewBox="0 0 ${w} ${h}" class="w-full h-44 rounded-2xl border border-paper-line bg-white shadow-sm" preserveAspectRatio="xMidYMid meet">
        <polyline fill="none" stroke="#1f7a4c" stroke-width="2.5" points="${coords.map((c) => c.x + "," + c.y).join(" ")}" />
        ${dots}
        <text x="12" y="16" font-size="11" fill="#6b7280">${esc(moneyTextInt(max))}${esc(unitLabel)}</text>
        <text x="12" y="${h - 6}" font-size="11" fill="#6b7280">${esc(moneyTextInt(min))}${esc(unitLabel)}</text>
      </svg>
      <div id="priceChartTip" class="price-chart-tip is-hidden"></div>
    </div>`;
}

function priceDetailInnerHtml_() {
  const item = selectedPriceItem();
  if (!item) {
    return `<div class="p-4 text-sm text-black/50">품목을 선택하세요.</div>`;
  }
  const unitLabel = item.stockUnit ? `원 / ${item.stockUnit}` : "원";
  const detailHead = `
      <div class="shrink-0">
        <h3 class="text-lg font-bold leading-tight">${esc(item.name)}</h3>
        <p class="text-[12px] text-black/55 mt-0.5">
          환산평균 ${esc(moneyTextInt(item.average))}${esc(unitLabel)} · 최저 ${esc(moneyTextInt(item.low))} · 최고 ${esc(moneyTextInt(item.high))} · 최근 ${esc(moneyTextInt(item.latest))}
          · ${item.count}건${item.mixedUnits ? " · 입고단위 혼재" : ""}
        </p>
      </div>`;
  const detailChart = `<div class="shrink-0 mt-2">${priceChartSvg(item.points || [], item.stockUnit)}</div>`;
  const detailTable = `
      <div class="flex-1 min-h-0 mt-2 overflow-y-auto scroll-thin rounded-2xl border border-paper-line bg-white">
        <table class="app-table min-w-full text-[13px]">
          <thead class="bg-[#f3f6f3] text-black/55">
            <tr>
              <th class="px-2.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">거래일</th>
              <th class="px-2.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">거래처</th>
              <th class="px-2.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">입고규격</th>
              <th class="px-2.5 py-1.5 font-medium num sticky top-0 z-10 bg-[#f3f6f3]">수량</th>
              <th class="px-2.5 py-1.5 font-medium num sticky top-0 z-10 bg-[#f3f6f3]">환산단가</th>
              <th class="px-2.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">재고단위</th>
            </tr>
          </thead>
          <tbody>
            ${(item.points || []).slice().reverse().map((p) => `
              <tr class="border-t border-paper-line">
                <td class="px-2.5 py-1.5 whitespace-nowrap">${esc(formatDate(p.date))}</td>
                <td class="px-2.5 py-1.5 truncate max-w-[120px]">${esc(p.vendor)}</td>
                <td class="px-2.5 py-1.5 text-black/60 truncate">${esc(p.unit)}</td>
                <td class="px-2.5 py-1.5 num">${esc(moneyText(p.qty))}</td>
                <td class="px-2.5 py-1.5 num font-semibold">${esc(moneyTextInt(p.price))}</td>
                <td class="px-2.5 py-1.5 text-black/55">${esc(p.stockUnit ? `원 / ${p.stockUnit}` : unitLabel)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  return detailHead + detailChart + detailTable;
}

function bindPriceChartTip_() {
  const wrap = document.querySelector(".price-chart-wrap");
  const tip = document.getElementById("priceChartTip");
  if (!wrap || !tip) return;
  wrap.querySelectorAll("circle.price-dot").forEach((dot) => {
    dot.addEventListener("mouseenter", () => {
      tip.textContent = dot.getAttribute("data-tip") || "";
      tip.classList.remove("is-hidden");
      const svg = wrap.querySelector("svg");
      if (!svg) return;
      const cx = Number(dot.getAttribute("cx") || 0);
      const cy = Number(dot.getAttribute("cy") || 0);
      const vb = (svg.viewBox && svg.viewBox.baseVal) || { width: 720, height: 176 };
      const rect = svg.getBoundingClientRect();
      const left = (cx / (vb.width || 720)) * rect.width;
      const top = (cy / (vb.height || 176)) * rect.height;
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    });
    dot.addEventListener("mouseleave", () => tip.classList.add("is-hidden"));
  });
}

function selectPriceItem_(key) {
  const listEl = document.getElementById("priceListScroll");
  if (listEl) state.priceListScrollTop = listEl.scrollTop;
  state.priceSelectedKey = key;
  document.querySelectorAll("[data-price-key]").forEach((btn) => {
    const on = btn.getAttribute("data-price-key") === key;
    btn.classList.toggle("bg-[#eef6f1]", on);
    btn.classList.toggle("font-bold", on);
    btn.classList.toggle("border-brand/40", on);
    if (btn.classList.contains("rounded-lg")) {
      btn.classList.toggle("bg-white", !on);
      btn.classList.toggle("border-paper-line", !on);
    }
  });
  const panel = document.getElementById("priceDetailPanel");
  if (panel) {
    panel.innerHTML = priceDetailInnerHtml_();
    bindPriceChartTip_();
  }
  if (listEl) {
    listEl.scrollTop = state.priceListScrollTop || 0;
    requestAnimationFrame(() => {
      if (listEl) listEl.scrollTop = state.priceListScrollTop || 0;
    });
  }
}

function openOcrModal() {
  state.ocrOpen = true;
  state.ocrStatus = "카메라 촬영 또는 사진첩에서 영수증을 추가하세요.";
  state.ocrDone = 0;
  state.ocrTotal = 0;
  render();
}

function driveImgSrc(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const idMatch = raw.match(/\/d\/([^/]+)/) || raw.match(/[?&]id=([^&]+)/);
  // GAS HtmlService: URL 의 // 도 주석으로 잘라냄 → "https:/" + "/host..." 로 분리
  if (idMatch) {
    return "https:/" + "/drive.google.com/thumbnail?id=" + encodeURIComponent(idMatch[1]) + "&sz=w1600";
  }
  return raw;
}

/** 영수증위치 + 영수증UPTIME 으로 브라우저 캐시 키 분리 (?v= / &v=) */
function withImageVer(url, ver) {
  const base = driveImgSrc(url);
  if (!base) return "";
  const v = encodeURIComponent(String(ver || "0"));
  return base + (base.includes("?") ? "&" : "?") + "v=" + v;
}

function slipImageUrl(row) {
  if (!row) return "";
  if (row.receiptUrl) return row.receiptUrl;
  if (row.imageUrl) return row.imageUrl;
  const key = slipKey(row);
  const hit = state.rows.find((r) => slipKey(r) === key && (r.receiptUrl || r.imageUrl));
  return hit ? (hit.receiptUrl || hit.imageUrl) : "";
}

function slipImageVer(row) {
  if (!row) return "0";
  if (row.receiptUptime) return String(row.receiptUptime);
  if (row.imageVer) return String(row.imageVer);
  const key = slipKey(row);
  const hit = state.rows.find((r) => slipKey(r) === key && (r.receiptUptime || r.imageVer));
  return hit ? String(hit.receiptUptime || hit.imageVer) : "0";
}

function slipImageMeta(rowOrItems) {
  const row = Array.isArray(rowOrItems) ? rowOrItems[0] : rowOrItems;
  return { url: slipImageUrl(row), ver: slipImageVer(row) };
}

// ---------------------------------------------------------------------------
// 명세서 이미지 로컬 캐시 (IndexedDB 메타 + Cache API 본문 + ?v= 네이티브 캐시)
// - 서버 imageVer 와 로컬 저장 ver 가 같으면 네트워크 없이 즉시 표시
// - 다르면 Drive URL(?v=새버전)로 다시 받아 캐시 갱신
// - GAS 주의: 템플릿 리터럴 안에 // 또는 /* 금지
// ---------------------------------------------------------------------------
const RECEIPT_IDB_NAME = "gg-receipt-cache";
const RECEIPT_IDB_STORE = "receipts";
const RECEIPT_CACHE_NAME = "gg-receipt-images-v1";

function receiptCacheKey(url, ver) {
  return String(driveImgSrc(url) || url) + "::" + String(ver || "0");
}

function openReceiptIdb_() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(RECEIPT_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECEIPT_IDB_STORE)) {
        db.createObjectStore(RECEIPT_IDB_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IDB open failed"));
  });
}

async function idbGetReceipt_(key) {
  try {
    const db = await openReceiptIdb_();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RECEIPT_IDB_STORE, "readonly");
      const q = tx.objectStore(RECEIPT_IDB_STORE).get(key);
      q.onsuccess = () => resolve(q.result || null);
      q.onerror = () => reject(q.error);
    });
  } catch (e) {
    return null;
  }
}

async function idbPutReceipt_(record) {
  try {
    const db = await openReceiptIdb_();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(RECEIPT_IDB_STORE, "readwrite");
      tx.objectStore(RECEIPT_IDB_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // 캐시 실패해도 화면 표시는 계속
  }
}

/**
 * 버전 검증 후 표시용 이미지 URL(또는 blob:)을 반환.
 * 1) IndexedDB 에 같은 ver 의 blob 이 있으면 즉시 objectURL
 * 2) Cache API 히트 시 blob URL
 * 3) 아니면 버전 쿼리가 붙은 Drive URL (브라우저 HTTP 캐시 유도) + 백그라운드 저장
 */
async function resolveReceiptImageSrc(rawUrl, ver) {
  const versioned = withImageVer(rawUrl, ver);
  if (!versioned) return "";
  const key = receiptCacheKey(rawUrl, ver);

  // (A) IndexedDB: ver 일치 + blob 존재 → 0.1초 이내 표시
  const cached = await idbGetReceipt_(key);
  if (cached && cached.ver === String(ver || "0") && cached.blob instanceof Blob) {
    return URL.createObjectURL(cached.blob);
  }

  // (B) Cache API: 동일 버전 URL 매칭
  if (window.caches) {
    try {
      const cache = await caches.open(RECEIPT_CACHE_NAME);
      const hit = await cache.match(versioned);
      if (hit) {
        const blob = await hit.blob();
        await idbPutReceipt_({ key, ver: String(ver || "0"), blob, url: versioned, savedAt: Date.now() });
        return URL.createObjectURL(blob);
      }
    } catch (e) {
      // CORS opaque 등으로 실패 가능 → 네이티브 URL 폴백
    }
  }

  // (C) 네트워크(또는 브라우저 디스크 캐시). 성공 시 백그라운드로 저장 시도
  prefetchReceiptIntoCache_(versioned, key, ver);
  return versioned;
}

function prefetchReceiptIntoCache_(versionedUrl, key, ver) {
  if (!versionedUrl) return;
  // no-cors 는 opaque 응답이라 blob 재사용이 어려워 cors 우선 시도
  fetch(versionedUrl, { mode: "cors", credentials: "omit", cache: "force-cache" })
    .then(async (res) => {
      if (!res || !res.ok) return;
      const blob = await res.blob();
      await idbPutReceipt_({ key, ver: String(ver || "0"), blob, url: versionedUrl, savedAt: Date.now() });
      if (window.caches) {
        try {
          const cache = await caches.open(RECEIPT_CACHE_NAME);
          await cache.put(versionedUrl, new Response(blob, { headers: { "Content-Type": blob.type || "image/jpeg" } }));
        } catch (e2) {}
      }
    })
    .catch(() => {
      // Drive CORS 미지원 시: ?v= 만으로 브라우저 캐시에 의존 (다음 클릭도 빠름)
    });
}


function slipActionBtnsHtml_(slipKeyValue, opts) {
  const icon = !!(opts && opts.icon);
  if (icon) {
    return `<span class="ml-auto shrink-0 inline-flex items-center gap-1">
      <button type="button" data-save-slip="${esc(slipKeyValue)}" disabled
        class="inspect-icon-btn is-save opacity-40 cursor-not-allowed" title="저장"><i class="fa-solid fa-floppy-disk"></i></button>
      <button type="button" data-delete-slip="${esc(slipKeyValue)}"
        class="inspect-icon-btn is-del" title="삭제"><i class="fa-solid fa-trash"></i></button>
    </span>`;
  }
  return `<span class="ml-auto shrink-0 inline-flex items-center gap-1.5">
    <button type="button" data-save-slip="${esc(slipKeyValue)}" disabled
      class="inspect-save-btn bg-ok text-white font-semibold whitespace-nowrap opacity-40 cursor-not-allowed">저장</button>
    <button type="button" data-delete-slip="${esc(slipKeyValue)}"
      class="inspect-save-btn bg-red-500 text-white font-semibold whitespace-nowrap">삭제</button>
  </span>`;
}

function closeOcrModal() {
  if (state.ocrBusy) return;
  state.ocrOpen = false;
  render();
}

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 1200;
        let w = img.width;
        let h = img.height;
        if (w > h && w > maxSide) {
          h = Math.round((h * maxSide) / w);
          w = maxSide;
        } else if (h >= w && h > maxSide) {
          w = Math.round((w * maxSide) / h);
          h = maxSide;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        const base64 = dataUrl.split(",")[1] || "";
        resolve({
          id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
          name: file.name || "receipt.jpg",
          preview: dataUrl,
          base64,
          mimeType: "image/jpeg",
        });
      };
      img.onerror = () => reject(new Error("이미지 변환 실패"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addOcrFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif)$/i.test(f.name));
  if (!files.length) {
    toast("이미지 파일만 추가할 수 있습니다.");
    return;
  }
  state.ocrStatus = `이미지 압축 중… (${files.length}장)`;
  render();
  try {
    const next = [];
    for (const file of files) {
      next.push(await compressImageFile(file));
    }
    state.ocrItems = state.ocrItems.concat(next);
    state.ocrStatus = `${state.ocrItems.length}장 준비됨`;
  } catch (err) {
    state.ocrStatus = err.message || "압축 실패";
  }
  render();
}

function removeOcrItem(id) {
  state.ocrItems = state.ocrItems.filter((x) => x.id !== id);
  state.ocrStatus = state.ocrItems.length ? `${state.ocrItems.length}장 준비됨` : "영수증 사진/파일을 추가하세요.";
  render();
}

function scriptRun(fnName, payload) {
  return new Promise((resolve, reject) => {
    if (typeof google === "undefined" || !google.script || !google.script.run) {
      reject(new Error("Apps Script 웹앱에서 열어 주세요."));
      return;
    }
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler((err) => reject(new Error((err && err.message) || String(err))))
      [fnName](payload);
  });
}

async function startOcrAnalyze() {
  if (state.ocrBusy || !state.ocrItems.length) return;
  state.ocrBusy = true;
  state.ocrDone = 0;
  state.ocrTotal = state.ocrItems.length;
  state.ocrStatus = "업로드 중…";
  render();
  let savedRows = 0;
  const errors = [];
  const lastMessages = [];
  try {
    for (let i = 0; i < state.ocrItems.length; i++) {
      const item = state.ocrItems[i];
      state.ocrStatus = `Gemini 분석 중 (${i + 1}/${state.ocrTotal})`;
      render();
      try {
        const result = await scriptRun("processOneReceiptWithGemini", {
          data: item.base64,
          mimeType: item.mimeType,
          name: item.name,
        });
        savedRows += result.saved || 0;
        if (result.message) lastMessages.push(result.message);
        if (result.version) state.apiVersion = result.version;
        state.ocrDone = i + 1;
      } catch (err) {
        errors.push(`${item.name}: ${err.message || err}`);
        state.ocrDone = i + 1;
      }
      render();
    }
    const detail = lastMessages.length ? ` · ${lastMessages[lastMessages.length - 1]}` : "";
    state.ocrStatus = errors.length
      ? `완료(일부 실패). 저장 ${savedRows}줄. ${errors.slice(0, 2).join(" / ")}`
      : `시트 저장 완료 · 영수증 ${state.ocrTotal}장 · 입고 ${savedRows}줄${detail}`;
    toast(errors.length ? "일부 실패" : (lastMessages[lastMessages.length - 1] || "OCR 등록 완료"));
    if (!errors.length) {
      state.ocrItems = [];
    }
  } catch (err) {
    state.ocrStatus = err.message || "OCR 실패";
  } finally {
    state.ocrBusy = false;
    render();
  }
}

function ocrModalHtml() {
  if (!state.ocrOpen) return "";
  const n = state.ocrItems.length;
  const pct = state.ocrTotal ? Math.round((state.ocrDone / state.ocrTotal) * 100) : 0;
  return `
    <div class="fixed inset-0 z-[80] bg-black/45 flex items-end sm:items-center justify-center p-0 sm:p-4" id="ocrBackdrop">
      <div class="w-full sm:max-w-2xl max-h-[92vh] overflow-hidden rounded-t-2xl sm:rounded-2xl bg-paper-card shadow-panel flex flex-col" id="ocrPanel">
        <div class="px-4 py-3 border-b border-paper-line flex items-center justify-between gap-2">
          <div>
            <h3 class="font-bold text-lg">영수증 OCR 입고 등록</h3>
            <p class="text-[11px] text-black/45">촬영/선택 → 1200px 압축 → Gemini 분석 → 시트·드라이브 저장</p>
          </div>
          <button id="btnOcrClose" class="compact-control rounded-lg border border-paper-line bg-white px-3 text-xs" ${state.ocrBusy ? "disabled" : ""}>닫기</button>
        </div>
        <div class="p-4 space-y-3 overflow-y-auto scroll-thin flex-1 min-h-0">
          <input type="file" id="receiptInputCamera" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif" capture="environment" class="hidden" />
          <input type="file" id="receiptInputGallery" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif" multiple class="hidden" />
          <div id="ocrDrop" class="rounded-2xl border-2 border-dashed border-paper-line bg-white px-4 py-6 text-center hover:bg-[#f7faf7]">
            <div class="flex flex-col sm:flex-row gap-2 justify-center">
              <button type="button" id="btnOcrCamera" class="compact-control rounded-xl bg-brand text-white px-4 py-2.5 text-sm font-bold" ${state.ocrBusy ? "disabled" : ""}>📷 카메라로 촬영</button>
              <button type="button" id="btnOcrGallery" class="compact-control rounded-xl border border-paper-line bg-white px-4 py-2.5 text-sm font-bold text-brand" ${state.ocrBusy ? "disabled" : ""}>🖼️ 사진첩에서 선택</button>
            </div>
            <p class="mt-2 text-[12px] text-black/45 desktop-only">PC에서는 이 영역에 이미지를 끌어다 놓을 수도 있습니다 (여러 장 가능)</p>
          </div>
          <div class="grid grid-cols-3 sm:grid-cols-4 gap-2" id="ocrThumbs">
            ${state.ocrItems.map((it) => `
              <div class="relative rounded-xl overflow-hidden border border-paper-line bg-white aspect-square">
                <img src="${esc(it.preview)}" alt="" class="w-full h-full object-cover" />
                <button type="button" data-ocr-del="${esc(it.id)}" class="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/65 text-white text-xs" ${state.ocrBusy ? "disabled" : ""}>✕</button>
              </div>`).join("")}
          </div>
          <div class="rounded-xl border border-paper-line bg-white px-3 py-2">
            <div class="text-[12px] text-black/60 mb-1">${esc(state.ocrStatus || "")}</div>
            <div class="h-2 rounded-full bg-black/5 overflow-hidden">
              <div class="h-full bg-ok transition-all" style="width:${state.ocrBusy || state.ocrTotal ? pct : 0}%"></div>
            </div>
            ${state.ocrTotal ? `<div class="mt-1 text-[11px] text-black/40">${state.ocrDone}/${state.ocrTotal}</div>` : ""}
          </div>
        </div>
        <div class="p-4 border-t border-paper-line flex gap-2">
          <button id="btnOcrRun" class="flex-1 compact-control rounded-xl bg-ok text-white px-3 py-3 text-sm font-bold ${n && !state.ocrBusy ? "" : "opacity-50"}" ${n && !state.ocrBusy ? "" : "disabled"}>
            ${state.ocrBusy ? "처리 중…" : `총 ${n}건 영수증 OCR 분석 및 시트 등록`}
          </button>
        </div>
      </div>
    </div>`;
}

async function startInboxOcrBatch() {
  const ok = window.confirm(
    "구글 드라이브 '001.중계_재고관리/입고대기' 폴더의 명세서를\n" +
    "OCR 해서 원재료입고에 추가할까요?\n\n" +
    "· 시트 전체는 지우지 않습니다.\n" +
    "· 동일 명세서가 있으면 해당 행만 지우고 다시 넣습니다.\n" +
    "· 처리 후 파일명을 바꾸고 '처리완료'로 이동합니다.\n\n" +
    "(수 분~수십 분 걸릴 수 있습니다.)"
  );
  if (!ok) return;

  state.jobBusy = true;
  state.ocrBusy = true;
  state.jobMessage = "입고대기 목록 확인 중…";
  state.ocrStatus = "입고대기 목록 확인 중…";
  render();
  try {
    const listed = await api("jobListInboxReceipts", {});
    const files = listed.files || [];
    if (!files.length) {
      state.jobMessage = "입고대기 폴더에 이미지가 없습니다.";
      state.ocrStatus = state.jobMessage;
      toast(state.jobMessage);
      return;
    }
    state.ocrTotal = files.length;
    state.ocrDone = 0;
    let savedRows = 0;
    const errors = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      state.ocrStatus = `대량OCR ${i + 1}/${files.length}: ${f.name}`;
      state.jobMessage = state.ocrStatus;
      render();
      try {
        const result = await api("processOneDriveReceiptWithGemini", { fileId: f.id });
        savedRows += result.saved || 0;
        if (result.version) state.apiVersion = result.version;
      } catch (err) {
        errors.push(`${f.name}: ${err.message || err}`);
      }
      state.ocrDone = i + 1;
      render();
    }
    state.jobMessage = errors.length
      ? `대량OCR 완료(일부 실패). 저장 ${savedRows}줄, 실패 ${errors.length}건. ${errors.slice(0, 2).join(" / ")}`
      : `대량OCR 완료. 영수증 ${files.length}장 · 입고 ${savedRows}줄 · ${listed.version || UI_VERSION}`;
    state.ocrStatus = state.jobMessage;
    toast(errors.length ? "일부 실패 — 작업센터 메시지 확인" : "입고대기 대량OCR 완료");
    await loadInspection();
  } catch (err) {
    state.jobMessage = err.message || "대량OCR 실패";
    state.ocrStatus = state.jobMessage;
  } finally {
    state.jobBusy = false;
    state.ocrBusy = false;
    render();
  }
}

async function runJobAction(card) {
  if (state.jobBusy) return;
  if (card.kind === "ocr") {
    openOcrModal();
    return;
  }
  if (card.kind === "inboxOcr") {
    await startInboxOcrBatch();
    return;
  }
  if (card.kind === "goto") {
    state.menu = card.menu;
    state.unregOpen = false;
    render();
    if (card.menu === "inspect") loadInspection();
    if (card.menu === "pos" && window.PosSales) window.PosSales.load();
    return;
  }
  if (card.kind === "pc") {
    state.jobMessage = card.title + " 은 매장 PC 재고관리 프로그램에서 실행하세요. (OKPOS 수집은 이 컴퓨터에서만 가능)";
    render();
    return;
  }
  if (card.action === "register") {
    state.unregOpen = true;
    await loadUnregistered();
    return;
  }
  let confirmText = card.confirm;
  if (card.action === "jobMonthlyClose") {
    const cur = state.latestMonth || state.selectedMonth || "이번 달";
    const openFrom = nextMonthTextFront_(cur) + "-01";
    const today = todayYmdLocal_();
    if (openFrom && today < openFrom) {
      toast(cur + " 월마감은 " + openFrom + "부터 가능합니다 (오늘 " + today + ")");
      return;
    }
    confirmText =
      cur +
      " 기록은 그대로 두고, 남은 재고를 다음 달 기초재고로 추가할까요?\n(월마감은 항상 시트 최신 기준월만 대상 · " +
      openFrom +
      "부터 가능)";
    try {
      const list = await api("balanceList", { month: cur });
      if (list && list.warnCount > 0) {
        confirmText +=
          "\n\n⚠ 거래처 금액 검증 이상 " +
          list.warnCount +
          "건이 있습니다. (경고만 — 막지 않습니다)\n그래도 월마감할까요?";
      }
    } catch (eWarn) {
      confirmText += "\n\n⚠ 거래처 검증 현황을 확인하지 못했습니다. 계속할까요?";
    }
  }
  if (confirmText && !window.confirm(confirmText)) return;
  state.jobBusy = true;
  state.jobMessage = card.title + " 실행 중…";
  render();
  try {
    const payload = {};
    if (card.action === "jobUpdateReceiptQuantities" || card.action === "jobCalculateInventory") {
      Object.assign(payload, monthPayload_());
    }
    const result = await api(card.action, payload);
    state.jobMessage = result.message || "완료되었습니다.";
    if (result.version) state.apiVersion = result.version;
    if (result.balanceRebuildAt != null) state.balanceRebuildAt = String(result.balanceRebuildAt || "");
    applyMonthMeta_(result);
    if (card.action === "jobMonthlyClose" && result.latestMonth) {
      state.selectedMonth = result.latestMonth;
      storeSelectedMonth_(result.latestMonth);
      applyPosRangeForMonth_(result.latestMonth);
    }
    if (card.after === "balance") {
      state.warnCount = result.warnCount != null ? result.warnCount : state.warnCount;
    }
    toast("작업 완료");
    if (state.menu === "stock" || state.menu === "order") await loadStock();
    else if (state.menu === "inspect") await loadInspection();
    else if (state.menu === "balance") await loadBalance();
  } catch (err) {
    state.jobMessage = err.message || "작업에 실패했습니다.";
  } finally {
    state.jobBusy = false;
    render();
  }
}

const UNREG_STATUS_OPTS = ["대표", "별칭", "미등록", "등록제외"];

/**
 * 등록구분 콤보 (시트 정본)
 * - 대표·별칭·등록제외 → 현재값 + 미등록만
 * - 미등록 → 대표·별칭·미등록·등록제외
 */
function unregStatusOptionsFor_(savedStatus, draftStatus) {
  const saved = normalizeUnregStatusFront_(savedStatus, false);
  const draft = normalizeUnregStatusFront_(draftStatus || savedStatus, false);
  let opts;
  if (saved === "대표" || saved === "별칭" || saved === "등록제외") {
    opts = [saved, "미등록"];
  } else {
    opts = ["대표", "별칭", "미등록", "등록제외"];
  }
  if (draft && !opts.includes(draft)) opts = opts.concat([draft]);
  return opts;
}

/** 레거시 '등록' → '대표' */
function normalizeUnregStatusFront_(value, hasCode) {
  const s = String(value || "").trim();
  if (s === "등록") return "대표";
  if (UNREG_STATUS_OPTS.includes(s)) return s;
  return hasCode ? "대표" : "미등록";
}

function ensureUnregDraft(g) {
  if (!g || !g.key) {
    return {
      checked: false, name: "", mode: "create", code: "", category: "기타",
      spec: "", conversion: "1", stockUnit: "개", regStatus: "미등록",
    };
  }
  if (!state.unregDrafts[g.key]) {
    const hasCode = !!(g.code || "").trim();
    const regStatus = normalizeUnregStatusFront_(g.regStatus, hasCode);
    state.unregDrafts[g.key] = {
      checked: false,
      name: g.name || "",
      mode: regStatus === "별칭" ? "link" : (hasCode ? "update" : "create"),
      code: g.code || "",
      parentCode: g.parentCode || "",
      category: g.suggestedCategory || "기타",
      spec: g.suggestedSpec || ((g.units && g.units[0]) || ""),
      conversion: String(g.suggestedConversion != null ? g.suggestedConversion : 1),
      stockUnit: g.suggestedStockUnit || "개",
      regStatus,
    };
  }
  return state.unregDrafts[g.key];
}

/** 등록구분 필터. 전체=대표+별칭+미등록+등록제외 모두 표시 */
function unregVisibleGroups() {
  let f = state.unregFilter || "전체";
  if (f === "등록") f = "대표";
  const seenRepCodes = new Set(); // 대표 코드 중복만 차단 (별칭은 sheetRow 단위)
  const list = (state.unregGroups || []).filter((g) => {
    const st = normalizeUnregStatusFront_(g.regStatus, !!(g.code || "").trim());
    const code = String(g.code || "").trim();
    if (st === "대표" && code) {
      if (seenRepCodes.has(code)) return false;
      seenRepCodes.add(code);
    }
    if (f === "전체") return true;
    return st === f;
  });
  return list.slice().sort((a, b) => {
    const ca = String(a.code || a.parentCode || "").trim();
    const cb = String(b.code || b.parentCode || "").trim();
    if (!ca && !cb) return String(a.name || "").localeCompare(String(b.name || ""), "ko");
    if (!ca) return 1;
    if (!cb) return -1;
    const cmp = ca.localeCompare(cb, "ko", { numeric: true, sensitivity: "base" });
    if (cmp !== 0) return cmp;
    const sa = normalizeUnregStatusFront_(a.regStatus, !!(a.code || "").trim());
    const sb = normalizeUnregStatusFront_(b.regStatus, !!(b.code || "").trim());
    if (sa === "대표" && sb !== "대표") return -1;
    if (sb === "대표" && sa !== "대표") return 1;
    return String(a.name || "").localeCompare(String(b.name || ""), "ko");
  });
}

/** 등록구분 Select 상태별 색상 */
function unregStatusSelectCls_(status) {
  const s = normalizeUnregStatusFront_(status, false);
  if (s === "대표") return "bg-[#e7f6ee] text-[#1f7a4c] border-[#86c5a3] font-bold";
  if (s === "별칭") return "bg-[#e8f1fb] text-[#1d4f91] border-[#90b4e0] font-bold";
  if (s === "등록제외") return "bg-[#fde8e8] text-[#b42318] border-[#e5a3a0] font-bold";
  return "bg-[#eceff1] text-[#546e7a] border-[#c5cad0] font-bold"; // 미등록
}

function unregAliasBadgesHtml_(aliases) {
  const list = (aliases || []).map((a) => String(a || "").trim()).filter(Boolean);
  if (!list.length) return "";
  return `<div class="flex flex-wrap gap-1 mt-1">${list.map((a) =>
    `<span class="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full" title="${esc(a)}">${esc(a)}</span>`
  ).join("")}</div>`;
}

function parseUnregCodeInput(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/\b(M\d{4,})\b/i);
  return m ? m[1].toUpperCase() : s;
}

/** DOM 입력값을 state.unregDrafts 에 반영 (리렌더 전 호출) */
function collectUnregDraftsFromDom() {
  document.querySelectorAll("[data-unreg-row]").forEach((row) => {
    const key = row.getAttribute("data-unreg-row");
    if (!key) return;
    const prev = state.unregDrafts[key] || {};
    const regStatus = (row.querySelector("[data-unreg-status]") && row.querySelector("[data-unreg-status]").value) || prev.regStatus || "미등록";
    const code = (row.querySelector("[data-unreg-code]") && row.querySelector("[data-unreg-code]").value) || prev.code || "";
    let mode = "create";
    if (regStatus === "별칭") mode = "link";
    else if (regStatus === "대표" && String(code).trim()) mode = "update";
    else if (regStatus === "대표") mode = "create";
    state.unregDrafts[key] = {
      checked: !!(row.querySelector("[data-unreg-check]") && row.querySelector("[data-unreg-check]").checked),
      name: (row.querySelector("[data-unreg-name]") && row.querySelector("[data-unreg-name]").value) || prev.name || "",
      mode,
      code,
      category: (row.querySelector("[data-unreg-category]") && row.querySelector("[data-unreg-category]").value) || prev.category || "기타",
      spec: (row.querySelector("[data-unreg-spec]") && row.querySelector("[data-unreg-spec]").value) || prev.spec || "",
      conversion: (row.querySelector("[data-unreg-conversion]") && row.querySelector("[data-unreg-conversion]").value) || prev.conversion || "1",
      stockUnit: (row.querySelector("[data-unreg-stockunit]") && row.querySelector("[data-unreg-stockunit]").value) || prev.stockUnit || "개",
      regStatus,
      parentCode: (row.querySelector("[data-unreg-parent-code]") && row.querySelector("[data-unreg-parent-code]").value) || prev.parentCode || "",
    };
  });
}

/** 미등록 목록 첫 행(현재 필터 기준 index 0) 자동 선택 */
function selectFirstUnregItem_() {
  const visible = unregVisibleGroups();
  state.unregSelectedKey = visible[0]
    ? visible[0].key
    : (state.unregGroups[0] ? state.unregGroups[0].key : null);
}

async function loadUnregistered() {
  state.jobBusy = true;
  state.jobMessage = "원재료관리를 불러오는 중…";
  render();
  try {
    const data = await api("jobUnregisteredList", {});
    const seenRepCodes = new Set();
    state.unregGroups = (data.groups || []).reduce((acc, g) => {
      const hasCode = !!(g.code || "").trim();
      const st = normalizeUnregStatusFront_(g.regStatus, hasCode);
      // 대표만 동일 코드 중복 차단. 별칭은 각각 표시
      if (st === "대표" && hasCode) {
        if (seenRepCodes.has(g.code)) return acc;
        seenRepCodes.add(g.code);
      }
      acc.push({
        ...g,
        regStatus: st,
        parentCode: g.parentCode || "",
        aliases: Array.isArray(g.aliases) ? g.aliases : [],
      });
      return acc;
    }, []);
    state.unregMaterials = data.materials || [];
    state.unregDrafts = {};
    state.unregGroups.forEach((g) => ensureUnregDraft(g));
    selectFirstUnregItem_(); // 진입 시 1행 자동 선택 → 우측 뷰어 즉시 표시
    const pending = state.unregGroups.filter((g) => normalizeUnregStatusFront_(g.regStatus, false) === "미등록").length;
    const aliasCnt = state.unregGroups.filter((g) => normalizeUnregStatusFront_(g.regStatus, false) === "별칭").length;
    state.jobMessage = state.unregGroups.length
      ? `원재료 ${state.unregGroups.length}종 · 미등록 ${pending}종 · 별칭 ${aliasCnt}종`
      : "원재료관리에 표시할 품목이 없습니다.";
    if (data.version) state.apiVersion = data.version;
  } catch (err) {
    state.jobMessage = err.message || "불러오지 못했습니다.";
  } finally {
    state.jobBusy = false;
    render();
  }
}

async function submitUnregisteredBatch() {
  collectUnregDraftsFromDom();
  const items = [];
  const ignoreItems = [];
  const downgrades = [];
  let abortMsg = "";
  state.unregGroups.forEach((g) => {
    if (abortMsg) return;
    const d = state.unregDrafts[g.key];
    if (!d || !d.checked) return;
    const hasCode = !!(g.code || "").trim();
    const prevParent = String(g.parentCode || d.parentCode || "").trim();
    const prevStatus = normalizeUnregStatusFront_(g.regStatus, hasCode);
    const regStatus = normalizeUnregStatusFront_(d.regStatus || g.regStatus, hasCode);

    // 등록제외: 미등록 → 등록제외만 (저장 버튼)
    if (regStatus === "등록제외") {
      if (prevStatus !== "미등록" && prevStatus !== "등록제외") {
        abortMsg = "등록제외는 미등록에서만 할 수 있습니다. 먼저 미등록으로 저장하세요.";
        return;
      }
      if (prevStatus === "등록제외") return;
      ignoreItems.push({
        sheetRow: g.sheetRow || null,
        name: g.name,
        receiptName: g.name,
        rows: g.rows || []
      });
      return;
    }

    const parentCode = parseUnregCodeInput(d.parentCode || "");
    let mode;
    let codeOut = "";
    let previousCode = "";
    let prevStatusOut = prevStatus;

    // 직행 금지: 대표↔별칭 등 미등록 경유
    if (prevStatus !== "미등록" && regStatus !== "미등록" && prevStatus !== regStatus) {
      if (!(prevStatus === "대표" && regStatus === "대표")) {
        abortMsg = "등록구분 변경은 미등록을 거쳐야 합니다. 먼저 미등록으로 저장하세요.";
        return;
      }
    }
    // 대표/별칭/등록제외 → 미등록
    if ((prevStatus === "대표" || prevStatus === "별칭" || prevStatus === "등록제외") && regStatus === "미등록") {
      mode = "downgrade_unreg";
      previousCode = hasCode ? String(g.code || "").trim() : parseUnregCodeInput(prevParent);
      codeOut = previousCode;
      downgrades.push(g.name || previousCode || "미등록 전환");
    } else if (regStatus === "별칭") {
      mode = "link";
      codeOut = parentCode || parseUnregCodeInput(d.code || "");
    } else if (hasCode || regStatus === "대표") {
      mode = prevStatus === "미등록" && !hasCode ? "create" : "update";
      if (mode === "create") codeOut = "";
      else codeOut = parseUnregCodeInput(d.code || g.code || "");
    } else {
      mode = "create";
      codeOut = "";
    }

    items.push({
      mode,
      receiptName: g.name,
      sheetRow: g.sheetRow || null,
      rows: g.rows || [],
      code: codeOut,
      previousCode,
      parentCode: parentCode || prevParent || codeOut,
      prevStatus: prevStatusOut,
      name: String(d.name || g.name || "").trim(),
      category: d.category || g.suggestedCategory || "기타",
      spec: String(d.spec != null ? d.spec : (g.suggestedSpec || "")).trim(),
      conversion: d.conversion != null && d.conversion !== "" ? d.conversion : (g.suggestedConversion != null ? g.suggestedConversion : 1),
      stockUnit: String(d.stockUnit || g.suggestedStockUnit || "개").trim() || "개",
      regStatus,
      receiptUrl: g.receiptUrl || g.imageUrl || "",
      receiptUptime: g.receiptUptime || g.imageVer || "",
      imageUrl: g.receiptUrl || g.imageUrl || "",
      imageVer: g.receiptUptime || g.imageVer || "",
    });
  });
  if (abortMsg) {
    toast(abortMsg);
    return;
  }
  if (!items.length && !ignoreItems.length) {
    toast("선택된 항목이 없습니다");
    return;
  }
  const missing = items.find((it) => {
    if (!it.name) return true;
    if (it.mode === "downgrade_unreg") return false; // 미등록 강등은 코드 없어도 sheetRow로 처리
    if (it.mode === "link" && !it.code) return true;
    if (it.mode === "update" && !it.code) return true;
    return false;
  });
  if (missing) {
    if (!missing.name) toast("원재료명이 필요합니다");
    else toast("별칭/기존연결은 대표코드를 선택하세요");
    return;
  }
  if (downgrades.length) {
    const ok = window.confirm(
      `정말 변경하시겠습니까? 과거 매핑 기록이 초기화되거나 변경됩니다.\n\n대상 ${downgrades.length}건:\n- ${downgrades.slice(0, 5).join("\n- ")}${downgrades.length > 5 ? "\n…" : ""}`
    );
    if (!ok) return;
  }
  if (ignoreItems.length) {
    const okEx = window.confirm(`등록제외 ${ignoreItems.length}종을 저장할까요?`);
    if (!okEx) return;
  }
  state.jobBusy = true;
  render();
  try {
    const msgs = [];
    let failed = false;
    if (items.length) {
      const result = await api("jobRegisterUnregisteredBatch", { items });
      msgs.push(result.message || "저장했습니다.");
      if (result.failed) failed = true;
    }
    if (ignoreItems.length) {
      const result = await api("jobIgnoreUnregistered", { items: ignoreItems });
      msgs.push(result.message || "등록제외했습니다.");
    }
    state.jobMessage = msgs.join("\n") || "저장했습니다.";
    toast(failed ? "일부 실패" : "저장 완료");
    await loadUnregistered();
  } catch (err) {
    state.jobMessage = err.message || "저장 실패";
    state.jobBusy = false;
    render();
  }
}

async function loadPrices() {
  state.priceLoading = true;
  state.priceError = "";
  render();
  try {
    await withMonthRetry_(async () => {
      const payload = { ...monthPayload_() };
      if (state.priceMonths >= 1) payload.months = state.priceMonths;
      else payload.months = 0;
      const data = await api("priceList", payload);
      applyMonthMeta_(data);
      state.priceRows = data.rows || [];
      state.priceStart = data.start || "";
      state.priceEnd = data.end || "";
      if (data.version) state.apiVersion = data.version;
      const cats = priceCategories();
      if (!cats.includes(state.priceCategory)) state.priceCategory = "전체";
      const visible = priceVisible();
      if (!visible.some((r) => r.key === state.priceSelectedKey)) {
        state.priceSelectedKey = visible[0] ? visible[0].key : null;
      }
    });
  } catch (err) {
    state.priceError = err.message || "불러오지 못했습니다.";
  } finally {
    state.priceLoading = false;
    render();
  }
}

async function api(action, payload = {}) {
  const body = { action, pin: state.pin, ...payload };

  // 1) Apps Script 웹앱: 지금 열린 배포의 서버를 직접 호출 (URL 불일치 방지)
  if (typeof google !== "undefined" && google.script && google.script.run) {
    const data = await new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler((result) => resolve(result || {}))
        .withFailureHandler((err) => reject(new Error((err && err.message) || String(err))))
        .apiFromClient(body);
    });
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  // 2) fetch 백업 (로컬 파일 테스트용)
  if (!API_URL) {
    if (!USE_MOCK_WHEN_EMPTY) {
      throw new Error("Apps Script 웹앱 주소로 열어 주세요. (로컬 파일에서는 API 가 없습니다)");
    }
    return mockApi(action, payload);
  }
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
    redirect: "follow",
  });
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

function mockApi(action, payload) {
  if (!mockApi._rows) {
    mockApi._rows = [
      { row: 12, date: "2026-10-28", vendor: "(주)회승", name: "이베리코 목살", spec: "1 Box / 11.96kg", qty: "1", code: "M0015", final: "11.96", checked: false },
      { row: 13, date: "2026-10-28", vendor: "(주)회승", name: "삼겹살", spec: "1 Box / 9.40kg", qty: "1", code: "M0012", final: "9.40", checked: false },
      { row: 18, date: "2026-10-29", vendor: "신선농산", name: "양파", spec: "망 / 20kg", qty: "2", code: "V003", final: "40", checked: true },
      { row: 21, date: "2026-10-30", vendor: "백두주류", name: "하이볼 베이스", spec: "1.5L × 6", qty: "3", code: "D010", final: "18", checked: false },
      { row: 25, date: "2026-10-31", vendor: "대한공산", name: "위생장갑", spec: "100매", qty: "10", code: "G002", final: "10", checked: false },
    ];
  }
  if (action === "inspectionList" || action === "login") {
    return Promise.resolve({ month: "2026-10", warnCount: 3, rows: JSON.parse(JSON.stringify(mockApi._rows)) });
  }
  if (action === "applyInspection") {
    (payload.changes || []).forEach((c) => {
      const row = mockApi._rows.find((r) => r.row === Number(c.row));
      if (row) row.checked = !!c.checked;
    });
    return Promise.resolve({ ok: true, count: (payload.changes || []).length, message: "반영했습니다." });
  }
  return Promise.reject(new Error("알 수 없는 요청입니다."));
}

function draftChecked(row) {
  const key = String(row.row);
  return Object.prototype.hasOwnProperty.call(state.draft, key) ? state.draft[key] : !!row.checked;
}

function dirtyChanges() {
  return state.rows
    .filter((r) => draftChecked(r) !== !!r.checked)
    .map((r) => ({ row: r.row, checked: draftChecked(r) }));
}

function waitingCount() {
  // 배지: 시트에 아직 미검수인 건수
  return state.rows.filter((r) => !r.checked).length;
}

function ensureSelection() {
  const visible = visibleRows();
  if (!visible.length) {
    state.selectedId = null;
    return;
  }
  if (!visible.some((r) => r.row === state.selectedId)) {
    // 필터 밖 옛 선택(다른 거래처) 방지: 보이는 첫 행으로
    const prefer = visible.find((r) => !draftChecked(r)) || visible[0];
    state.selectedId = prefer.row;
  }
}

function dateOptions() {
  const set = new Set(state.rows.map((r) => formatDate(r.date)).filter(Boolean));
  // 최근 날짜가 위(내림차순)
  return ["전체", ...Array.from(set).sort((a, b) => b.localeCompare(a))];
}

function vendorOptions() {
  let rows = state.rows;
  if (state.filterDate !== "전체") {
    rows = rows.filter((r) => formatDate(r.date) === state.filterDate);
  }
  const set = new Set(rows.map((r) => r.vendor).filter(Boolean));
  // 선택값 유지: 해당 날짜에 없어도 콤보에서 사라지지 않게
  if (state.filterVendor && state.filterVendor !== "전체") set.add(state.filterVendor);
  return ["전체", ...Array.from(set).sort((a, b) => a.localeCompare(b, "ko"))];
}

function visibleRows() {
  const q = state.query.trim().toLowerCase();
  return state.rows
    .filter((r) => {
      const date = formatDate(r.date);
      if (state.filterDate !== "전체" && date !== state.filterDate) return false;
      if (state.filterVendor !== "전체" && r.vendor !== state.filterVendor) return false;
      // 기본: 시트 기준 미검수(!checked)만
      if (state.filterInspect === "pending" && r.checked) return false;
      if (!q) return true;
      return `${date} ${r.vendor} ${r.name} ${r.receiptName || ""} ${r.spec} ${r.code}`.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      // 최근 날짜가 위, 같으면 거래처, 그다음 시트 행번호
      const da = formatDate(a.date);
      const db = formatDate(b.date);
      if (da !== db) return db.localeCompare(da);
      const va = String(a.vendor || "");
      const vb = String(b.vendor || "");
      if (va !== vb) return va.localeCompare(vb, "ko");
      return (Number(b.row) || 0) - (Number(a.row) || 0);
    });
}

/**
 * 명세서 고유ID → 전표 단위 키.
 * 예: 2026-10-19-0076_거래일련번호_(주)희승_0_1713325
 *  → 2026-10-19-0076_거래일련번호_(주)희승  (거래처명까지, 품목순번·금액 제외)
 * 같은 날·같은 거래처의 전표 2장(0076 / 0079)을 분리한다.
 */
function slipBaseId_(uniqueId, vendor) {
  const uid = String(uniqueId || "").trim();
  if (!uid) return "";
  const v = String(vendor || "").trim();
  if (v) {
    const idx = uid.indexOf(v);
    if (idx >= 0) return uid.slice(0, idx + v.length);
  }
  // 거래처명 매칭 실패 시: 끝의 _품목순번_금액 제거
  const m = uid.match(/^(.*)_\d+_\d+(?:\.\d+)?$/);
  return m && m[1] ? m[1] : uid;
}

/** 전표 그룹 키: 고유ID 전표베이스 우선, 없으면 날짜+거래처+명세서금액 */
function slipKey(r) {
  const base = slipBaseId_(r && r.uniqueId, r && r.vendor);
  if (base) return "uid:" + base;
  const daily = r && r.dailyAmount != null && r.dailyAmount !== ""
    ? String(moneyNum(r.dailyAmount) != null ? moneyNum(r.dailyAmount) : r.dailyAmount)
    : "";
  return `${formatDate(r && r.date)}||${(r && r.vendor) || ""}||${daily}`;
}

function moneyNum(v) {
  if (v == null || v === "") return null;
  const raw = String(v).replace(/,/g, "").replace(/원/g, "").replace(/\s+/g, "").trim();
  if (!raw || raw === "-" || raw === "+" || raw === "." || raw === "-.") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function formatMoney(v) {
  const n = moneyNum(v);
  if (n == null) return "";
  try {
    return n.toLocaleString("ko-KR");
  } catch (e) {
    return String(n);
  }
}

/** 입력 value용 — 숫자면 콤마(음수 포함), 아니면 원문 */
function formatMoneyInput(v) {
  if (v == null || v === "") return "";
  const n = moneyNum(v);
  if (n == null) return String(v);
  try {
    return n.toLocaleString("ko-KR");
  } catch (e) {
    return String(n);
  }
}

function sameMoneyField_(a, b) {
  const na = moneyNum(a);
  const nb = moneyNum(b);
  if (na == null && nb == null) return sameFieldText_(a, b);
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) < 0.0001;
}

/** 전표 OCR 전체합계 vs 품목 합계금액 합 검증 (할인 음수 포함 합산) */
function slipAmountCheck(items) {
  const list = items || [];
  let sum = 0;
  let hasLine = false;
  list.forEach((r) => {
    const n = moneyNum(r.lineAmount != null ? r.lineAmount : r.amount);
    if (n != null) {
      sum += n; // 쿠폰·에누리(-7000)도 그대로 가산 → 159490 + (-7000) = 152490
      hasLine = true;
    }
  });
  const daily = moneyNum(list[0] && list[0].dailyAmount);
  const mismatch = daily != null && hasLine && Math.abs(daily - sum) > 1;
  return { daily, sum: hasLine ? sum : null, mismatch };
}

function compareUniqueId(a, b) {
  const ua = String((a && a.uniqueId) || "");
  const ub = String((b && b.uniqueId) || "");
  if (ua && ub && ua !== ub) return ua < ub ? -1 : 1;
  return (Number(a && a.row) || 0) - (Number(b && b.row) || 0);
}

/** 전표 단위 그룹 (고유ID 베이스 · 품목은 명세서 고유ID 순) */
function groupedVisibleRows() {
  const rows = visibleRows();
  const groups = [];
  const map = new Map();
  rows.forEach((r) => {
    const key = slipKey(r);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        date: formatDate(r.date),
        vendor: r.vendor || "",
        slipId: slipBaseId_(r.uniqueId, r.vendor) || "",
        items: [],
      };
      map.set(key, g);
      groups.push(g);
    }
    g.items.push(r);
  });
  groups.forEach((g) => g.items.sort(compareUniqueId));
  return groups;
}

function slipAttrSel_(attr, value) {
  return attr + '="' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 전표 헤더: 거래일·거래처(OCR 오독 수정) */
function slipMetaEditHtml_(slipKeyValue, items) {
  const date = formatDate(items[0] && items[0].date) || "";
  const vendor = String((items[0] && items[0].vendor) || "").trim();
  const opts = Array.isArray(state.vendorOptions) ? state.vendorOptions.slice() : [];
  if (vendor && opts.indexOf(vendor) < 0) opts.unshift(vendor);
  const optHtml = opts
    .map((v) => `<option value="${esc(v)}" ${v === vendor ? "selected" : ""}>${esc(v)}</option>`)
    .join("");
  return `<span class="inline-flex items-center gap-1 shrink-0 flex-wrap min-w-0">
    <input type="date" ${slipAttrSel_("data-edit-trade-date", slipKeyValue)} value="${esc(date)}"
      title="거래일 (원재료입고 C열)"
      class="inspect-cell-input rounded border border-paper-line bg-white px-1 text-[11px] font-semibold text-black/80" />
    <select ${slipAttrSel_("data-edit-vendor", slipKeyValue)}
      title="거래처 (원재료입고 D열 · 거래처관리 목록)"
      class="inspect-cell-input max-w-[9.5rem] rounded border border-paper-line bg-white px-1 text-[11px] font-semibold text-black/80">
      ${optHtml || `<option value="${esc(vendor)}">${esc(vendor || "(거래처 없음)")}</option>`}
    </select>
  </span>`;
}

/** 거래처명 옆 OCR 영수증합계(F)·당월누적(G) — 수정 가능 */
function slipDailyEditHtml(slipKeyValue, items) {
  const chk = slipAmountCheck(items);
  const daily = items[0] && items[0].dailyAmount != null ? items[0].dailyAmount : "";
  const monthAmt = items[0] && items[0].monthAmount != null ? items[0].monthAmount : "";
  return `<span class="inline-flex items-center gap-1 shrink-0 ml-2 flex-wrap" data-slip-daily-wrap="${esc(slipKeyValue)}">
    <span class="inline-flex items-center gap-1">
      <span class="text-[10px] ${chk.mismatch ? "text-[#b42318]" : "text-black/55"}">명세서합계</span>
      <input ${slipAttrSel_("data-edit-daily", slipKeyValue)} value="${esc(formatMoneyInput(daily))}"
        class="inspect-cell-input w-[6.25rem] rounded border text-right tabular-nums font-semibold ${chk.mismatch ? "border-[#f0a0a0] bg-[#fff5f5] text-[#b42318]" : "border-paper-line bg-white"}" />
      <span data-slip-mismatch="${esc(slipKeyValue)}" class="text-[10px] font-bold bg-[#fde8e8] text-[#b42318] px-1 rounded ${chk.mismatch ? "" : "hidden"}" title="품목 매입금액 합 ≠ 전표합계">이상</span>
    </span>
    <span class="inline-flex items-center gap-1">
      <span class="text-[10px] text-black/55" title="원재료입고 G열 · OCR 오인식 시 수정">당월누적</span>
      <input ${slipAttrSel_("data-edit-month", slipKeyValue)} value="${esc(formatMoneyInput(monthAmt))}"
        placeholder="—"
        class="inspect-cell-input w-[6.25rem] rounded border border-paper-line bg-white text-right tabular-nums font-semibold" />
    </span>
  </span>`;
}

function setSlipDraft(slipKeyValue, checked) {
  state.rows.forEach((r) => {
    if (slipKey(r) === slipKeyValue) state.draft[String(r.row)] = checked;
  });
  render();
}

function applySearch() {
  state.query = state.searchText;
  ensureSelection();
  render();
}

function applyBalanceSearch() {
  state.balanceQuery = state.balanceSearchText;
  render();
}

function selectedRow() {
  ensureSelection();
  const visible = visibleRows();
  return visible.find((r) => r.row === state.selectedId) || null;
}

function resetDraftFromRows() {
  state.draft = {};
  state.rows.forEach((r) => {
    state.draft[String(r.row)] = !!r.checked;
  });
}

async function loadInspection() {
  state.loading = true;
  state.error = "";
  render();
  try {
    await withMonthRetry_(async () => {
      const data = await api("inspectionList", monthPayload_());
      applyMonthMeta_(data);
      state.month = data.month || state.selectedMonth || "";
      state.apiVersion = data.version || "";
      state.rows = (data.rows || []).map((r) => ({ ...r, date: formatDate(r.date) }));
      state.pendingOrders = Array.isArray(data.pendingOrders) ? data.pendingOrders : [];
      state.adjustedOrders = Array.isArray(data.adjustedOrders) ? data.adjustedOrders : [];
      state.pendingOrderDrafts = {};
      state.vendorOptions = Array.isArray(data.vendorOptions) ? data.vendorOptions : [];
      state.warnCount = data.warnCount || 0;
      resetDraftFromRows();
      state.selectedId = null;
      ensureSelection();
    });
  } catch (err) {
    state.error = err.message || "불러오지 못했습니다.";
  } finally {
    state.loading = false;
    render();
  }
}

/** 검수·발주 매칭용 코드 키 (별칭 _01 제거) */
function inspectOrderCodeKey_(code) {
  const c = String(code || "").trim();
  if (!c || c === "IGNORE" || c === "영구제외") return "";
  return c.replace(/_\d+$/i, "");
}

/**
 * 발주대기 합산 · OCR(영수증수량) 합산 인덱스
 * @param {Array|null} rowSource 검수 행 소스. 기본=전체 월 데이터. 미도착 판별은 화면 목록(visible) 사용
 */
function buildInspectOrderMatchIndex_(rowSource) {
  const orderByCode = {};
  (state.pendingOrders || []).forEach((o) => {
    const key = inspectOrderCodeKey_(o.code);
    if (!key) return;
    if (!orderByCode[key]) {
      orderByCode[key] = {
        code: key,
        name: o.name || key,
        vendor: o.vendor || "",
        qtyBox: 0,
        sheetRows: []
      };
    }
    const q = Number(o.qtyBox);
    if (q > 0) orderByCode[key].qtyBox += q;
    if (o.sheetRow) orderByCode[key].sheetRows.push(o.sheetRow);
    if (o.name) orderByCode[key].name = o.name;
    if (o.vendor) orderByCode[key].vendor = o.vendor;
  });
  const ocrByCode = {};
  const rows = rowSource != null ? rowSource : state.rows || [];
  rows.forEach((r) => {
    const key = inspectOrderCodeKey_(r.code);
    if (!key) return;
    const q = moneyNum(r.qty);
    if (q == null) return;
    ocrByCode[key] = (ocrByCode[key] || 0) + q;
  });
  return { orderByCode, ocrByCode };
}

/** 같은 전표(slip) 안에서 해당 코드의 영수증수량 합 */
function ocrQtyOnSameSlip_(r, codeKey) {
  const sk = slipKey(r);
  let sum = 0;
  (state.rows || []).forEach((row) => {
    if (slipKey(row) !== sk) return;
    if (inspectOrderCodeKey_(row.code) !== codeKey) return;
    const q = moneyNum(row.qty);
    if (q != null) sum += q;
  });
  return sum;
}

/** 코드가 조정완료 발주에 있는지 */
function isOrderCodeAdjusted_(code) {
  const key = inspectOrderCodeKey_(code);
  if (!key) return false;
  return (state.adjustedOrders || []).some((o) => inspectOrderCodeKey_(o.code) === key);
}

/**
 * 발주 대기 vs 이 전표 OCR 수량 대조.
 * @returns {{ key, order, ocrQty, diff, kind: 'none'|'match'|'short'|'over'|'adjusted' }}
 */
function orderMatchInfo_(r, index) {
  const idx = index || buildInspectOrderMatchIndex_();
  const key = inspectOrderCodeKey_(r && r.code);
  if (!key) return { key: "", order: null, ocrQty: 0, diff: 0, kind: "none" };
  const order = idx.orderByCode[key];
  if (!order || !(order.qtyBox > 0)) {
    if (isOrderCodeAdjusted_(r.code)) {
      return { key, order: null, ocrQty: 0, diff: 0, kind: "adjusted" };
    }
    return { key, order: null, ocrQty: 0, diff: 0, kind: "none" };
  }
  const ocrQty = ocrQtyOnSameSlip_(r, key);
  const diff = Math.round((order.qtyBox - ocrQty) * 1000) / 1000;
  if (Math.abs(diff) < 0.0001) return { key, order, ocrQty, diff, kind: "match" };
  if (diff > 0) return { key, order, ocrQty, diff, kind: "short" };
  return { key, order, ocrQty, diff, kind: "over" };
}

/**
 * 뱃지 대조: 발주 대기 Box vs 이 전표(같은 날짜·거래처) 영수증수량 합
 * (월 전체 합산하면 과거 입고까지 잡혀 '초과'로 오인됨)
 */
function orderMatchBadgeHtml_(r, index) {
  const info = orderMatchInfo_(r, index);
  if (info.kind === "adjusted") {
    return `<span class="inline-block mt-0.5 text-[9px] font-bold px-1 py-0.5 rounded bg-[#e8eef8] text-[#1d4f91] leading-none" title="발주 조정완료">조정완료</span>`;
  }
  if (info.kind === "none") {
    return `<span class="inline-block mt-0.5 text-[9px] font-semibold px-1 py-0.5 rounded bg-gray-100 text-gray-500 leading-none">발주내역 없음</span>`;
  }
  const tip = "발주 " + info.order.qtyBox + "Box · 이 전표 OCR " + info.ocrQty;
  if (info.kind === "match") {
    return `<span class="inline-block mt-0.5 text-[9px] font-bold px-1 py-0.5 rounded bg-[#e7f6ee] text-[#1f7a4c] leading-none" title="${esc(tip)}">✅ 발주수량 일치</span>`;
  }
  if (info.kind === "short") {
    return `<span class="inline-block mt-0.5 text-[9px] font-bold px-1 py-0.5 rounded bg-[#fde8e8] text-[#b42318] leading-none" title="${esc(tip)}">🚨 ${esc(moneyTextInt(info.diff))}박스 부족</span>`;
  }
  return `<span class="inline-block mt-0.5 text-[9px] font-bold px-1 py-0.5 rounded bg-[#fff4d6] text-[#9a6700] leading-none" title="${esc(tip)}">⚠️ ${esc(moneyTextInt(Math.abs(info.diff)))}박스 초과</span>`;
}

/**
 * 입고완료 적용 직전: 체크→완료로 바꾸는 행 중 부족/초과가 있으면 목록 반환
 */
function collectApplyOrderMismatches_(changes) {
  const idx = buildInspectOrderMatchIndex_();
  const seen = {};
  const list = [];
  (changes || []).forEach((c) => {
    if (!c || !c.checked) return;
    const row = state.rows.find((r) => r.row === c.row);
    if (!row) return;
    const info = orderMatchInfo_(row, idx);
    if (info.kind !== "short" && info.kind !== "over") return;
    const dedupe = info.key + "|" + slipKey(row);
    if (seen[dedupe]) return;
    seen[dedupe] = true;
    const label =
      info.kind === "short"
        ? moneyTextInt(info.diff) + "박스 부족"
        : moneyTextInt(Math.abs(info.diff)) + "박스 초과";
    list.push({
      name: row.name || info.order.name || info.key,
      vendor: row.vendor || info.order.vendor || "",
      code: info.key,
      orderQty: info.order.qtyBox,
      ocrQty: info.ocrQty,
      label: label,
    });
  });
  return list;
}

function pendingOrderDraft_(sheetRow) {
  const key = String(sheetRow);
  if (!state.pendingOrderDrafts[key]) {
    const src = (state.pendingOrders || []).find((o) => Number(o.sheetRow) === Number(sheetRow));
    state.pendingOrderDrafts[key] = {
      adjust: false,
      memo: String((src && src.memo) || ""),
    };
  }
  return state.pendingOrderDrafts[key];
}

function isPendingOrderOverdue_(expectedDate) {
  const exp = formatDate(expectedDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return false;
  return exp < todayYmdLocal_();
}

/** yyyy-MM-dd → MM-DD (title용 원문은 full 유지) */
function formatMonthDayShort_(value) {
  const full = formatDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(full)) return full || "—";
  return full.slice(5);
}

/** 배송방법 → 첫 글자 (hover=전체) */
function deliveryMethodShort_(method) {
  const full = String(method || "").trim();
  if (!full) return { short: "—", full: "" };
  return { short: full.charAt(0), full: full };
}

/** 표시 상태: 대기 | 지연 (시트는 대기) */
function pendingOrderDisplayStatus_(o) {
  if (isPendingOrderOverdue_(o.expectedDate)) return "지연";
  return "대기";
}

/**
 * 발주내역 대기 행 목록 (행 단위). 검수목록 매칭·지연 표시용 필드 추가.
 */
function pendingOrderPanelItems_() {
  const visibleOcr = buildInspectOrderMatchIndex_(visibleRows()).ocrByCode;
  return (state.pendingOrders || [])
    .map((o) => {
      const codeKey = inspectOrderCodeKey_(o.code);
      const ocrQty = codeKey ? visibleOcr[codeKey] || 0 : 0;
      const inInspectList = ocrQty > 0;
      const draft = pendingOrderDraft_(o.sheetRow);
      const overdue = isPendingOrderOverdue_(o.expectedDate);
      const displayStatus = pendingOrderDisplayStatus_(o);
      return {
        ...o,
        adjustOn: !!draft.adjust,
        draftMemo: draft.memo,
        inInspectList,
        ocrQty,
        overdue,
        displayStatus,
      };
    })
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.inInspectList !== b.inInspectList) return a.inInspectList ? 1 : -1;
      const da = formatDate(a.expectedDate) || formatDate(a.orderDate) || "";
      const db = formatDate(b.expectedDate) || formatDate(b.orderDate) || "";
      if (da !== db) return da < db ? -1 : 1;
      return String(a.vendor || "").localeCompare(String(b.vendor || ""), "ko");
    });
}

async function savePendingOrderAdjust_(sheetRow) {
  if (state.pendingOrderSaveBusy) return;
  const draft = pendingOrderDraft_(sheetRow);
  const memo = String(draft.memo || "").trim();
  if (!memo) {
    toast("조정완료는 메모를 입력해 주세요");
    return;
  }
  state.pendingOrderSaveBusy = true;
  render();
  try {
    const result = await api("savePendingOrderPatches", {
      patches: [{ sheetRow: Number(sheetRow), status: "조정완료", memo: memo }],
    });
    if (result && result.version) state.apiVersion = result.version;
    state.pendingOrders = Array.isArray(result.pendingOrders) ? result.pendingOrders : state.pendingOrders;
    state.adjustedOrders = Array.isArray(result.adjustedOrders) ? result.adjustedOrders : state.adjustedOrders;
    delete state.pendingOrderDrafts[String(sheetRow)];
    toast(result.message || "조정완료로 저장했습니다.");
  } catch (err) {
    toast((err && err.message) || "발주 저장에 실패했습니다.");
  } finally {
    state.pendingOrderSaveBusy = false;
    render();
  }
}

/** opts.compact: 우측 패널용. opts.wrapClass: 바깥 래퍼 클래스 */
function missingPendingOrdersHtml_(opts) {
  const items = pendingOrderPanelItems_();
  const compact = !!(opts && opts.compact);
  const wrapClass = (opts && opts.wrapClass) || (compact ? "mb-2" : "mt-3");
  const busy = !!state.pendingOrderSaveBusy;
  if (!items.length) {
    return `
    <div class="${wrapClass} rounded-xl border border-dashed border-paper-line bg-white px-3 py-2.5 ${compact ? "shrink-0" : ""}">
      <div class="text-[13px] font-bold text-black/55">입고대기품목 · 0건</div>
    </div>`;
  }
  const delayed = items.filter((o) => o.overdue).length;
  const maxH = compact ? "max-h-[min(52vh,28rem)] overflow-auto scroll-thin" : "max-h-[70vh] overflow-auto scroll-thin";
  const desktopRows = items
    .map((o) => {
      const orderFull = formatDate(o.orderDate) || "";
      const expFull = formatDate(o.expectedDate) || "";
      const del = deliveryMethodShort_(o.deliveryMethod);
      const statusClass =
        o.displayStatus === "지연" ? "text-[#b42318] font-bold" : "text-[#c46a1b] font-semibold";
      const adjustBlock = o.adjustOn
        ? `<div class="mt-0.5 flex items-center gap-1">
            <input data-pending-memo="${o.sheetRow}" type="text" value="${esc(o.draftMemo || "")}"
              placeholder="조정 사유"
              class="compact-control flex-1 min-w-0 rounded border border-paper-line bg-white px-1 text-[11px] h-7" ${busy ? "disabled" : ""} />
            <button type="button" data-pending-save="${o.sheetRow}"
              class="compact-control shrink-0 rounded bg-ok text-white px-2 text-[11px] font-bold h-7 disabled:opacity-40"
              ${busy ? "disabled" : ""}>저장</button>
          </div>`
        : "";
      return `<tr class="border-t border-paper-line ${o.overdue ? "bg-[#fff5f4]" : ""}" data-pending-row="${o.sheetRow}">
        <td class="px-1 py-1 text-[11px] whitespace-nowrap tabular-nums" title="${esc(orderFull)}">${esc(formatMonthDayShort_(o.orderDate))}</td>
        <td class="px-1 py-1 text-[11px] truncate" title="${esc(o.vendor)}">${esc(o.vendor || "—")}</td>
        <td class="px-1 py-1 text-[11px] truncate" title="${esc(o.name)}">${esc(o.name || "—")}</td>
        <td class="px-1 py-1 text-[11px] text-right tabular-nums">${esc(moneyTextInt(o.qtyBox))}</td>
        <td class="px-1 py-1 text-[11px] whitespace-nowrap tabular-nums ${o.overdue ? "text-[#b42318] font-bold" : ""}" title="${esc(expFull)}">${esc(formatMonthDayShort_(o.expectedDate))}</td>
        <td class="px-1 py-1 text-[11px] text-center" title="${esc(del.full)}">${esc(del.short)}</td>
        <td class="px-1 py-1 text-[11px]">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="${statusClass}">${esc(o.displayStatus)}</span>
            <label class="inline-flex items-center gap-1 text-[11px] text-black/55 shrink-0 cursor-pointer">
              <input type="checkbox" data-pending-adjust="${o.sheetRow}" class="w-3.5 h-3.5 accent-ok" ${o.adjustOn ? "checked" : ""} ${busy ? "disabled" : ""} />
              조정
            </label>
          </div>
          ${adjustBlock}
        </td>
      </tr>`;
    })
    .join("");

  const mobileCards = items
    .map((o) => {
      const del = deliveryMethodShort_(o.deliveryMethod);
      const statusClass =
        o.displayStatus === "지연" ? "text-[#b42318] font-bold" : "text-[#c46a1b] font-semibold";
      const adjustBlock = o.adjustOn
        ? `<div class="mt-2 flex items-center gap-2">
            <input data-pending-memo="${o.sheetRow}" type="text" value="${esc(o.draftMemo || "")}"
              placeholder="조정 사유"
              class="compact-control flex-1 min-w-0 rounded-lg border border-paper-line bg-white px-2 text-[13px]" ${busy ? "disabled" : ""} />
            <button type="button" data-pending-save="${o.sheetRow}"
              class="compact-control shrink-0 rounded-lg bg-ok text-white px-3 text-[13px] font-bold disabled:opacity-40"
              ${busy ? "disabled" : ""}>저장</button>
          </div>`
        : "";
      return `<article class="rounded-xl border border-paper-line bg-white p-3 ${o.overdue ? "ring-1 ring-[#f0a0a0]" : ""}" data-pending-row="${o.sheetRow}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-bold text-brand truncate">${esc(o.vendor || "거래처 미지정")}</div>
            <div class="text-[15px] font-semibold leading-snug mt-0.5">${esc(o.name || "—")}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-[16px] font-bold tabular-nums">${esc(moneyTextInt(o.qtyBox))} <span class="text-[12px] font-medium text-black/45">Box</span></div>
            <div class="${statusClass} text-[13px] mt-0.5">${esc(o.displayStatus)}</div>
          </div>
        </div>
        <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-black/55">
          <span>발주 ${esc(formatMonthDayShort_(o.orderDate) || "—")}</span>
          <span class="${o.overdue ? "text-[#b42318] font-bold" : ""}">예정 ${esc(formatMonthDayShort_(o.expectedDate) || "—")}</span>
          <span title="${esc(del.full)}">${esc(del.full || del.short || "—")}</span>
        </div>
        <label class="mt-2 inline-flex items-center gap-2 text-[13px] text-black/60 cursor-pointer">
          <input type="checkbox" data-pending-adjust="${o.sheetRow}" class="order-check accent-ok" ${o.adjustOn ? "checked" : ""} ${busy ? "disabled" : ""} />
          조정완료로 처리
        </label>
        ${adjustBlock}
      </article>`;
    })
    .join("");

  return `
    <div class="${wrapClass} ${compact ? "shrink-0" : ""}">
      <div class="desktop-only rounded-xl border border-dashed border-[#e5a3a0] bg-[#fff8f7] px-2 py-2">
        <div class="flex items-baseline justify-between gap-2 px-0.5 mb-1">
          <div class="text-[12px] font-bold text-[#b42318]">입고대기품목 · ${items.length}건</div>
          <div class="text-[11px] text-black/45">${delayed ? "지연 " + delayed + " · " : ""}검수→입고완료</div>
        </div>
        <div class="${maxH}">
          <table class="w-full text-[11px]">
            <thead class="text-black/50 sticky top-0 bg-[#fff8f7] z-[1]">
              <tr>
                <th class="px-1 py-1 text-left font-medium">발주</th>
                <th class="px-1 py-1 text-left font-medium">거래처</th>
                <th class="px-1 py-1 text-left font-medium">품목</th>
                <th class="px-1 py-1 text-right font-medium">수</th>
                <th class="px-1 py-1 text-left font-medium">예정</th>
                <th class="px-1 py-1 text-center font-medium">배</th>
                <th class="px-1 py-1 text-left font-medium">상태</th>
              </tr>
            </thead>
            <tbody>${desktopRows}</tbody>
          </table>
        </div>
      </div>
      <div class="mobile-only space-y-2">
        <div class="flex items-baseline justify-between gap-2 px-0.5">
          <div class="text-[15px] font-bold text-[#b42318]">입고대기 · ${items.length}건</div>
          <div class="text-[12px] text-black/45">${delayed ? "지연 " + delayed : "검수 후 입고완료"}</div>
        </div>
        <div class="${maxH} space-y-2">${mobileCards}</div>
      </div>
    </div>`;
}

function sameFieldText_(a, b) {
  return String(a ?? "").trim() === String(b ?? "").trim();
}

function isDomVisible_(el) {
  if (!el) return false;
  try {
    if (el.getClientRects && el.getClientRects().length) return true;
  } catch (e) {}
  return !!(el.offsetParent || (el.style && el.style.position === "fixed"));
}

function findEditInput_(attr, value) {
  const nodes = document.querySelectorAll(
    "input[" + slipAttrSel_(attr, value) + "], select[" + slipAttrSel_(attr, value) + "]"
  );
  for (let i = 0; i < nodes.length; i++) {
    if (isDomVisible_(nodes[i])) return nodes[i];
  }
  return nodes[0] || null;
}

function collectSlipRowPatch_(row) {
  const panels = document.querySelectorAll(`[data-edit-panel="${row.row}"]`);
  let root = null;
  for (let i = 0; i < panels.length; i++) {
    if (isDomVisible_(panels[i])) {
      root = panels[i];
      break;
    }
  }
  if (!root) root = panels[0] || null;
  const q = (attr) => {
    const local = root && root.querySelector(`input[${attr}="${row.row}"]`);
    if (local) return local;
    return findEditInput_(attr, row.row);
  };
  const lineFallback = row.lineAmount != null ? row.lineAmount : row.amount;
  const qtyEl = q("data-edit-qty");
  const finalEl = q("data-edit-final");
  const qty = qtyEl ? qtyEl.value : row.qty;
  let final = finalEl ? finalEl.value : row.final;
  if (!String(final || "").trim() && String(qty || "").trim()) final = qty;
  const nameEl = q("data-edit-name");
  const receiptNameEl = q("data-edit-receipt-name");
  const specEl = q("data-edit-spec");
  const unitEl = q("data-edit-unit");
  const lineEl = q("data-edit-line");
  return {
    row: row.row,
    name: nameEl ? nameEl.value : row.name,
    receiptName: receiptNameEl ? receiptNameEl.value : (row.receiptName || ""),
    spec: specEl ? specEl.value : row.spec,
    qty,
    final,
    unitPrice: unitEl ? unitEl.value : row.unitPrice,
    lineAmount: lineEl ? lineEl.value : lineFallback,
  };
}

function isSlipRowDirty_(row) {
  const p = collectSlipRowPatch_(row);
  const line = row.lineAmount != null ? row.lineAmount : row.amount;
  return (
    !sameFieldText_(p.name, row.name) ||
    !sameFieldText_(p.receiptName, row.receiptName || "") ||
    !sameFieldText_(p.spec, row.spec) ||
    !sameMoneyField_(p.qty, row.qty) ||
    !sameMoneyField_(p.final, row.final) ||
    !sameMoneyField_(p.unitPrice, row.unitPrice) ||
    !sameMoneyField_(p.lineAmount, line)
  );
}

function isSlipFieldsDirty_(slipKeyValue) {
  const items = state.rows.filter((r) => slipKey(r) === slipKeyValue);
  if (!items.length) return false;
  const dailyEl = findEditInput_("data-edit-daily", slipKeyValue);
  if (dailyEl && !sameMoneyField_(dailyEl.value, items[0].dailyAmount)) return true;
  const monthEl = findEditInput_("data-edit-month", slipKeyValue);
  if (monthEl && !sameMoneyField_(monthEl.value, items[0].monthAmount)) return true;
  const dateEl = findEditInput_("data-edit-trade-date", slipKeyValue);
  if (dateEl && formatDate(dateEl.value) !== formatDate(items[0].date)) return true;
  const vendorEl = findEditInput_("data-edit-vendor", slipKeyValue);
  if (vendorEl && !sameFieldText_(vendorEl.value, items[0].vendor || "")) return true;
  return items.some(isSlipRowDirty_);
}

function refreshSlipSaveButtons_() {
  document.querySelectorAll("[data-save-slip]").forEach((btn) => {
    const key = btn.getAttribute("data-save-slip");
    const dirty = isSlipFieldsDirty_(key);
    btn.disabled = !dirty;
    btn.classList.toggle("opacity-40", !dirty);
    btn.classList.toggle("cursor-not-allowed", !dirty);
  });
  // 입력 중 금액 이상 표시 갱신
  document.querySelectorAll("[data-slip-daily-wrap]").forEach((wrap) => {
    const key = wrap.getAttribute("data-slip-daily-wrap");
    const items = state.rows.filter((r) => slipKey(r) === key);
    if (!items.length) return;
    const patches = items.map(collectSlipRowPatch_);
    const dailyEl = findEditInput_("data-edit-daily", key);
    const daily = moneyNum(dailyEl ? dailyEl.value : items[0].dailyAmount);
    let sum = 0;
    let has = false;
    patches.forEach((p) => {
      const n = moneyNum(p.lineAmount);
      if (n != null) {
        sum += n;
        has = true;
      }
    });
    const mismatch = daily != null && has && Math.abs(daily - sum) > 1;
    const badge = wrap.querySelector("[data-slip-mismatch]");
    if (badge) badge.classList.toggle("hidden", !mismatch);
    if (dailyEl) {
      dailyEl.classList.toggle("border-[#f0a0a0]", mismatch);
      dailyEl.classList.toggle("bg-[#fff5f5]", mismatch);
      dailyEl.classList.toggle("text-[#b42318]", mismatch);
    }
  });
}

async function saveInspectSlip(slipKeyValue) {
  const items = state.rows.filter((r) => slipKey(r) === slipKeyValue).sort(compareUniqueId);
  if (!items.length) return;
  if (!isSlipFieldsDirty_(slipKeyValue)) {
    toast("변경된 값이 없습니다");
    return;
  }
  const dailyEl = findEditInput_("data-edit-daily", slipKeyValue);
  const monthEl = findEditInput_("data-edit-month", slipKeyValue);
  const dateEl = findEditInput_("data-edit-trade-date", slipKeyValue);
  const vendorEl = findEditInput_("data-edit-vendor", slipKeyValue);
  const prevTradeDate = formatDate(items[0].date);
  const prevVendor = String(items[0].vendor || "").trim();
  const nextTradeDate = dateEl ? formatDate(dateEl.value) : prevTradeDate;
  const nextVendor = vendorEl ? String(vendorEl.value || "").trim() : prevVendor;
  if (!nextTradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextTradeDate)) {
    toast("거래일을 yyyy-MM-dd 형식으로 입력해 주세요");
    return;
  }
  if (!nextVendor) {
    toast("거래처를 선택해 주세요");
    return;
  }
  const dateChanged = nextTradeDate !== prevTradeDate;
  const vendorChanged = nextVendor !== prevVendor;
  const rows = items.map(collectSlipRowPatch_);
  try {
    const payload = {
      dailyAmount: dailyEl ? dailyEl.value : items[0].dailyAmount,
      monthAmount: monthEl ? monthEl.value : items[0].monthAmount,
      rows,
    };
    if (dateChanged || vendorChanged) {
      payload.tradeDate = nextTradeDate;
      payload.vendor = nextVendor;
      payload.prevTradeDate = prevTradeDate;
      payload.prevVendor = prevVendor;
    }
    const result = await api("saveInspectionBatch", payload);
    (result.rows || []).forEach((res) => {
      const row = state.rows.find((r) => r.row === res.row);
      if (!row || !res.fields) return;
      ["name", "receiptName", "spec", "qty", "final", "unitPrice", "lineAmount", "amount", "dailyAmount", "monthAmount", "date", "vendor"].forEach((k) => {
        if (res.fields[k] !== undefined) row[k] = res.fields[k];
      });
    });
    if (result.dailyAmount != null) {
      items.forEach((r) => {
        r.dailyAmount = result.dailyAmount;
      });
    }
    if (result.monthAmount != null) {
      items.forEach((r) => {
        r.monthAmount = result.monthAmount;
      });
    }
    if (result.tradeDate != null) {
      items.forEach((r) => {
        r.date = formatDate(result.tradeDate);
      });
    }
    if (result.vendor != null) {
      items.forEach((r) => {
        r.vendor = result.vendor;
      });
    }
    toast(result.message || "저장됨");
    // 날짜가 다른 달로 바뀌면 현재 월 목록에서 사라질 수 있음 → 재조회
    if (textMonthFront_(nextTradeDate) !== textMonthFront_(prevTradeDate)) {
      await loadInspection();
    } else {
      render();
    }
  } catch (err) {
    toast(err.message || "저장 실패");
  }
}

function textMonthFront_(yyyyMmDd) {
  const m = String(yyyyMmDd || "").match(/^(\d{4}-\d{2})/);
  return m ? m[1] : "";
}

/** 전표 내 체크된 행 삭제 */
async function deleteInspectSlipItems(slipKeyValue) {
  const items = state.rows.filter((r) => slipKey(r) === slipKeyValue);
  const checked = items.filter((r) => {
    const boxes = document.querySelectorAll(`input[data-check="${r.row}"]`);
    for (let i = 0; i < boxes.length; i++) {
      if (isDomVisible_(boxes[i])) return !!boxes[i].checked;
    }
    if (boxes.length) return !!boxes[0].checked;
    return draftChecked(r);
  });
  if (!checked.length) {
    toast("삭제할 항목을 선택해주세요");
    return;
  }
  if (!confirm(checked.length + "개 품목을 삭제할까요? (원재료입고에서 행이 지워집니다)")) return;
  try {
    const result = await api("deleteInspectionItems", {
      rows: checked.map((r) => r.row),
    });
    toast(result.message || "삭제됨");
    await loadInspection();
  } catch (err) {
    toast(err.message || "삭제 실패");
  }
}

function setDraft(rowNumber, checked) {
  state.draft[String(rowNumber)] = checked;
  render();
}

async function applyDraft() {
  const changes = dirtyChanges();
  if (!changes.length) {
    toast("변경된 체크가 없습니다.");
    return;
  }
  const mismatches = collectApplyOrderMismatches_(changes);
  if (mismatches.length) {
    const lines = mismatches
      .slice(0, 8)
      .map(
        (m) =>
          "· " +
          (m.vendor ? m.vendor + " " : "") +
          m.name +
          ": 발주 " +
          m.orderQty +
          " / 전표 " +
          m.ocrQty +
          " (" +
          m.label +
          ")"
      );
    const more = mismatches.length > 8 ? "\n· …외 " + (mismatches.length - 8) + "건" : "";
    window.alert(
      "수량 불일치 발주가 있어 입고완료 적용을 할 수 없습니다.\n\n" +
        lines.join("\n") +
        more +
        "\n\n오른쪽 입고대기품목에서 「조정」을 체크하고 메모를 저장한 뒤 다시 적용하세요."
    );
    return;
  }
  state.applying = true;
  render();
  try {
    // 새 Api.gs 의 applyInspection 우선, 없으면 기존 setInspection 으로 한 건씩
    try {
      const result = await api("applyInspection", { changes, ...monthPayload_() });
      changes.forEach((c) => {
        const row = state.rows.find((r) => r.row === c.row);
        if (row) row.checked = c.checked;
      });
      resetDraftFromRows();
      toast(result.message || `${changes.length}건 적용했습니다.`);
      // 발주내역 상태 갱신 반영
      try {
        const refreshed = await api("inspectionList", {});
        state.pendingOrders = Array.isArray(refreshed.pendingOrders) ? refreshed.pendingOrders : [];
        state.adjustedOrders = Array.isArray(refreshed.adjustedOrders) ? refreshed.adjustedOrders : [];
        state.pendingOrderDrafts = {};
        if (refreshed.version) state.apiVersion = refreshed.version;
      } catch (eRef) {}
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (!/지원하지 않는|action/i.test(msg)) throw err;
      for (const c of changes) {
        await api("setInspection", { row: c.row, checked: c.checked });
        const row = state.rows.find((r) => r.row === c.row);
        if (row) row.checked = c.checked;
      }
      resetDraftFromRows();
      toast(`${changes.length}건 적용했습니다.`);
      try {
        const refreshed = await api("inspectionList", {});
        state.pendingOrders = Array.isArray(refreshed.pendingOrders) ? refreshed.pendingOrders : [];
        state.adjustedOrders = Array.isArray(refreshed.adjustedOrders) ? refreshed.adjustedOrders : [];
        state.pendingOrderDrafts = {};
      } catch (eRef2) {}
    }
  } catch (err) {
    toast(err.message || "적용에 실패했습니다.");
  } finally {
    state.applying = false;
    render();
  }
}

function renderPin() {
  root.innerHTML = `
    <div class="min-h-full grid place-items-center p-4">
      <form id="pinForm" class="w-full max-w-md bg-paper-card border border-paper-line rounded-2xl shadow-panel p-6">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-12 h-12 rounded-xl bg-brand text-white grid place-items-center text-lg"><i class="fa-solid fa-store"></i></div>
          <div>
            <h1 class="text-xl font-bold text-brand">중계고기파티</h1>
            <p class="text-sm text-black/55">재고관리 · 직원 로그인</p>
          </div>
        </div>
        <p class="text-sm text-black/60 mb-3">직원용 비밀번호를 입력하세요.</p>
        <input id="pinInput" type="password" inputmode="numeric" autocomplete="current-password"
          class="w-full tap rounded-xl border border-paper-line px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-brand/30" />
        ${state.error ? `<p class="text-red-700 text-sm mt-2">${esc(state.error)}</p>` : ""}
        <button class="mt-4 w-full tap rounded-xl bg-brand text-white font-semibold">들어가기</button>
      </form>
    </div>`;
  document.getElementById("pinForm").onsubmit = async (e) => {
    e.preventDefault();
    const pin = document.getElementById("pinInput").value.trim();
    if (!pin) return;
    state.pin = pin;
    try {
      await api("inspectionList", { pin });
      sessionStorage.setItem("stockPin", pin);
      state.error = "";
      await loadInspection();
    } catch (err) {
      state.pin = "";
      sessionStorage.removeItem("stockPin");
      state.error = err.message || "로그인에 실패했습니다.";
      render();
    }
  };
}

function actionCardButtonHtml_(c, variant) {
  const danger = c.danger ? "text-[#ffd0c4]" : "text-white/90";
  const tag = c.tag || (c.kind === "pc" ? "PC" : c.kind === "goto" ? "조회" : c.kind === "ocr" || c.kind === "inboxOcr" ? "OCR" : "실행");
  if (variant === "mobile") {
    return `<button data-job="${c.id}" class="w-full text-left rounded-lg border border-paper-line px-3 py-2 text-[13px] ${c.danger ? "bg-[#fdf3ef]" : "bg-white"}" ${state.jobBusy ? "disabled" : ""}>
      <span class="text-black/40 mr-1">${c.no}.</span>${esc(c.title)}
    </button>`;
  }
  return `<button data-job="${c.id}" title="${esc(c.desc)}"
    class="w-full tap text-left rounded-lg px-2.5 py-2 hover:bg-white/10 disabled:opacity-50 ${danger}"
    ${state.jobBusy ? "disabled" : ""}>
    <div class="flex items-center gap-2">
      <span class="text-[10px] font-bold text-white/40 w-3 shrink-0">${c.no}</span>
      <span class="text-[12px] font-medium leading-snug flex-1 min-w-0">${esc(c.title)}</span>
      <span class="text-[9px] text-white/35 shrink-0">${tag}</span>
    </div>
  </button>`;
}

function jobsPanelHtml(opts = {}) {
  const mobileOnly = !!opts.mobileOnly;
  return `
    <div class="${mobileOnly ? "mobile-only " : ""}mb-3 rounded-2xl border border-paper-line bg-white p-3 space-y-3">
      ${closeNagBannerHtml_()}
      <div>
        <div class="text-xs font-bold text-black/45 mb-2">도구</div>
        <div class="space-y-1">${QUICK_TOOLS.map((c) => actionCardButtonHtml_(c, "mobile")).join("")}</div>
      </div>
      <div>
        <div class="text-xs font-bold text-black/45 mb-2">배치작업</div>
        <div class="space-y-1">${JOB_CARDS.map((c) => actionCardButtonHtml_(c, "mobile")).join("")}</div>
      </div>
      ${state.jobMessage ? `<p class="text-[11px] text-black/50 whitespace-pre-wrap">${esc(state.jobMessage)}</p>` : ""}
    </div>`;
}

function sidebarJobButtonsHtml() {
  return `
    <div class="mt-3 pt-3 border-t border-white/10 space-y-3">
      <div>
        <div class="px-2 mb-2 text-[10px] font-bold tracking-wide text-white/45 uppercase">도구</div>
        <div class="space-y-1">${QUICK_TOOLS.map((c) => actionCardButtonHtml_(c, "sidebar")).join("")}</div>
      </div>
      <div>
        <div class="px-2 mb-2 text-[10px] font-bold tracking-wide text-white/45 uppercase">배치작업</div>
        <div class="space-y-1">${JOB_CARDS.map((c) => actionCardButtonHtml_(c, "sidebar")).join("")}</div>
      </div>
      ${state.jobMessage ? `<div class="mx-1 rounded-lg bg-black/20 px-2 py-1.5 text-[10px] text-white/75 whitespace-pre-wrap leading-snug">${esc(state.jobMessage)}</div>` : ""}
    </div>`;
}

function sidebarHtml() {
  const wait = waitingCount();
  return `
    <aside class="desktop-only w-72 shrink-0 bg-brand text-white flex flex-col min-h-0">
      <div class="px-5 py-5 border-b border-white/10">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-xl bg-white/10 grid place-items-center"><i class="fa-solid fa-store"></i></div>
          <div>
            <div class="font-bold text-lg leading-tight">중계고기파티</div>
            <div class="text-xs text-white/65">재고관리 콘솔</div>
          </div>
        </div>
      </div>
      <nav class="flex-1 p-3 space-y-1 overflow-y-auto scroll-thin">
        ${MENUS.map((m) => {
          const on = state.menu === m.id;
          let badge = "";
          if (m.badge === "count") badge = `<span class="ml-auto text-[11px] font-bold bg-white text-brand rounded-full px-2 py-0.5">${wait}</span>`;
          if (m.badge === "warn") badge = `<span class="ml-auto text-[10px] font-bold bg-[#ffd9a8] text-[#8a4b00] rounded-full px-2 py-0.5">${state.warnCount || "확인요망"}</span>`;
          if (m.badge === "low" && state.stockLowCount > 0) badge = `<span class="ml-auto text-[11px] font-bold bg-[#ffd9a8] text-[#8a4b00] rounded-full px-2 py-0.5">${state.stockLowCount}</span>`;
          return `<button data-menu="${m.id}" class="nav-item w-full tap flex items-center gap-3 rounded-xl px-3 py-3 text-left ${on ? "bg-white/15" : "hover:bg-white/10"}">
            <i class="fa-solid ${m.icon} w-5 text-center opacity-90"></i>
            <span class="text-sm font-medium">${m.label}</span>${badge}
          </button>`;
        }).join("")}
        ${sidebarJobButtonsHtml()}
      </nav>
    </aside>`;
}

function mobileHeaderHtml() {
  const dirty = dirtyChanges().length;
  const showInspectActions = state.menu === "inspect" && !state.unregOpen;
  return `
    <header class="mobile-only sticky top-0 z-20 bg-brand text-white px-3 py-2">
      <div class="flex items-center gap-1.5">
        <div class="w-8 h-8 rounded-lg bg-white/10 grid place-items-center text-sm shrink-0"><i class="fa-solid fa-store"></i></div>
        <div class="min-w-0 flex-1">
          <div class="font-bold text-sm truncate leading-tight">중계고기파티</div>
          <div class="text-[10px] text-white/65 truncate">${esc(state.month)} · 대기 ${waitingCount()}${dirty ? ` · 변경 ${dirty}` : ""} · ${uiVersionShort_()}</div>
        </div>
        <button id="mobileRefresh" class="tap rounded-lg px-2 hover:bg-white/10 shrink-0" title="새로고침"><i class="fa-solid fa-rotate-right"></i></button>
        ${showInspectActions ? `
          <button id="mobileOcrOpen" class="tap rounded-lg bg-white/15 px-2.5 text-[12px] font-bold shrink-0" title="OCR 입고" ${state.jobBusy ? "disabled" : ""}>OCR</button>
          <button id="mobileApply" class="tap rounded-lg bg-ok px-2.5 text-[12px] font-bold shrink-0 ${dirty ? "" : "opacity-50"}" ${dirty && !state.applying ? "" : "disabled"}>
            ${state.applying ? "…" : "입고완료 적용"}
          </button>` : ""}
      </div>
    </header>`;
}

function mobileTabsHtml() {
  return `
    <nav class="mobile-only fixed bottom-0 inset-x-0 z-20 bg-brand text-white grid grid-cols-6 border-t border-white/10 pb-[env(safe-area-inset-bottom)]">
      ${MENUS.map((m) => {
        const on = state.menu === m.id;
        const short =
          m.id === "inspect" ? "입고"
          : m.id === "balance" ? "검증"
          : m.id === "price" ? "단가"
          : m.id === "stock" ? "재고"
          : m.id === "order" ? "발주"
          : "POS";
        return `<button data-menu="${m.id}" class="tap py-2 text-[11px] font-medium ${on ? "text-white" : "text-white/55"}">
          <div class="text-[17px] mb-0.5"><i class="fa-solid ${m.icon}"></i></div>${short}
        </button>`;
      }).join("")}
    </nav>`;
}

function toolbarHtml() {
  const dirty = dirtyChanges().length;
  const dates = dateOptions();
  const vendors = vendorOptions();
  const filtersOpen = !!state.mobileFiltersOpen;
  return `
    <div class="mb-2 space-y-1.5">
      ${screenTitleRowHtml_({
        title: "입고검수",
        selectId: "inspectMonthSelect",
        rightHtml: `변경 ${dirty}건 · 대기 ${waitingCount()}건
          <div class="text-[11px] tabular-nums ${state.apiVersion ? "text-black/40" : "text-red-600 font-semibold"}">
            ${uiVersionShort_()}${state.apiVersion ? (" · 서버 " + esc(state.apiVersion)) : " · 서버 ?"}
          </div>`
      })}
      ${pastMonthBannerHtml_()}
      ${closeNagBannerHtml_()}
      ${!state.apiVersion && !state.loading ? `<div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">서버 버전을 못 받았습니다. <b>배포 관리</b>에 나온 <b>웹 앱 URL</b> 로 다시 여세요. (북마크한 옛 주소면 서버가 안 바뀝니다) Index+Api.gs+웹앱.gs 저장 → 연필 → <b>새 버전</b> → 배포</div>` : ""}
      <div class="flex gap-1.5 items-center">
        <div class="flex flex-1 min-w-0">
          <input id="searchInput" value="${esc(state.searchText)}" placeholder="품목·코드 검색 (Enter)"
            class="compact-control w-full rounded-l-lg border border-paper-line bg-white px-2 focus:outline-none focus:ring-2 focus:ring-brand/25" />
          <button type="button" id="btnSearch" class="compact-control rounded-r-lg border border-l-0 border-paper-line bg-white px-2.5" title="검색">
            <i class="fa-solid fa-magnifying-glass text-[11px] text-black/45"></i>
          </button>
        </div>
        <button type="button" id="btnToggleFilters" class="mobile-only compact-control rounded-lg border border-paper-line bg-white px-2.5 ${filtersOpen ? "ring-2 ring-brand/30 bg-[#eef6f1]" : ""}" title="필터 보기" aria-expanded="${filtersOpen ? "true" : "false"}">
          <i class="fa-solid fa-filter text-[12px] ${filtersOpen ? "text-brand" : "text-black/45"}"></i>
        </button>
        <button id="btnOcrOpen" class="desktop-only compact-control rounded-lg bg-brand text-white px-3 text-xs font-bold" ${state.jobBusy ? "disabled" : ""}>OCR 입고</button>
        <button id="btnRefresh" class="desktop-only compact-control rounded-lg border border-paper-line bg-white px-2" title="새로고침"><i class="fa-solid fa-rotate-right text-xs"></i></button>
      </div>
      <div id="filterPanel" class="grid grid-cols-2 gap-1.5 lg:grid-cols-4 ${filtersOpen ? "" : "mobile-filters-collapsed"}">
        <label class="block">
          <span class="sr-only">거래일자</span>
          <select id="filterDate" class="compact-control w-full rounded-lg border border-paper-line bg-white px-2">
            ${dates.map((d) => `<option value="${esc(d)}" ${d === state.filterDate ? "selected" : ""}>${d === "전체" ? "날짜: 전체" : d}</option>`).join("")}
          </select>
        </label>
        <label class="block">
          <span class="sr-only">거래처</span>
          <select id="filterVendor" class="compact-control w-full rounded-lg border border-paper-line bg-white px-2">
            ${vendors.map((v) => `<option value="${esc(v)}" ${v === state.filterVendor ? "selected" : ""}>${v === "전체" ? "거래처: 전체" : esc(v)}</option>`).join("")}
          </select>
        </label>
        <label class="block">
          <span class="sr-only">검수 보기</span>
          <select id="filterInspect" class="compact-control w-full rounded-lg border border-paper-line bg-white px-2">
            <option value="pending" ${state.filterInspect === "pending" ? "selected" : ""}>보기: 미검수만</option>
            <option value="all" ${state.filterInspect === "all" ? "selected" : ""}>보기: 전체</option>
          </select>
        </label>
        <button id="btnApply" class="desktop-only compact-control rounded-lg bg-ok text-white px-3 text-xs font-bold ${dirty ? "hover:brightness-110" : "opacity-50"}" ${dirty && !state.applying ? "" : "disabled"}>
          ${state.applying ? "입고완료 적용 중…" : `입고완료 적용${dirty ? ` ${dirty}` : ""}`}
        </button>
      </div>
    </div>`;
}

function tableHtml(_rows) {
  if (state.loading) return `<div class="p-6 text-sm text-black/50">불러오는 중…</div>`;
  const groups = groupedVisibleRows();
  const orderIdx = buildInspectOrderMatchIndex_();
  const pendingHint = (state.pendingOrders || []).length
    ? `<div class="desktop-only mb-2 text-[11px] text-black/50">입고대기 ${(state.pendingOrders || []).length}건 · 원재료코드 매칭 · 같은 전표의 영수증수량 ↔ 발주 Box · 목록은 오른쪽</div>`
    : "";
  if (!groups.length) {
    // 모바일 입고대기 목록은 cardsHtml 에서만 그림 (중복 방지)
    return `${pendingHint}<div class="desktop-only p-6 text-sm text-black/50">조건에 맞는 입고가 없습니다.</div>`;
  }
  // 스크롤은 #mainScrollArea 에서만 → thead sticky 가 동작. 표 자체에 overflow 두지 않음.
  // 고정폭: 영수증수량/반영 w-15, 단가 w-20, 매입 w-24, 상태 w-15 · 품목명=영수증명 동일 비율
  return `
    ${pendingHint}
    <div class="desktop-only rounded-xl border border-paper-line bg-white shadow-panel">
      <table class="inspect-table app-table w-full table-fixed text-[12px]">
        <colgroup>
          <col style="width:2.25rem" />
          <col style="width:18%" />
          <col style="width:18%" />
          <col style="width:10%" />
          <col style="width:3.75rem" />
          <col style="width:3.75rem" />
          <col style="width:5rem" />
          <col style="width:6rem" />
          <col style="width:3.75rem" />
        </colgroup>
        <thead class="text-black/55">
          <tr class="text-center">
            <th class="px-1 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]" title="검수">✓</th>
            <th class="px-1 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">품목명</th>
            <th class="px-1 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">영수증상품목명</th>
            <th class="px-1 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">규격</th>
            <th class="px-0.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">영수증수량</th>
            <th class="px-0.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">반영수량</th>
            <th class="px-0.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">단가</th>
            <th class="px-0.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">매입금액</th>
            <th class="px-0.5 py-1.5 font-medium sticky top-0 z-10 bg-[#f3f6f3]">상태</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map((g) => {
            const allOn = g.items.every((r) => draftChecked(r));
            const anyDirty = g.items.some((r) => draftChecked(r) !== !!r.checked);
            const amtChk = slipAmountCheck(g.items);
            const header = `<tr class="slip-header bg-[#ece8e1] border-t border-paper-line" data-slip-block="${esc(g.key)}">
              <td class="px-1.5 py-1" colspan="9">
                <div class="flex items-center gap-2 min-w-0">
                  <label class="shrink-0 inline-flex items-center justify-center cursor-pointer" title="이 전표 전체 검수">
                    <input type="checkbox" class="w-3.5 h-3.5 accent-ok" data-slip-check="${esc(g.key)}" ${allOn ? "checked" : ""} />
                  </label>
                  ${slipMetaEditHtml_(g.key, g.items)}
                  ${slipDailyEditHtml(g.key, g.items)}
                  <span class="text-[10px] text-black/40 shrink-0">${g.items.length}품목${anyDirty ? " · 미적용" : ""}${amtChk.mismatch ? " · 금액불일치" : ""}</span>
                  ${slipActionBtnsHtml_(g.key, { icon: false })}
                </div>
              </td>
            </tr>`;
            const body = g.items.map((r) => {
              const draft = draftChecked(r);
              const saved = !!r.checked;
              const dirty = draft !== saved;
              const on = r.row === state.selectedId;
              const line = r.lineAmount != null ? r.lineAmount : r.amount;
              const neg = moneyNegClass(line);
              return `<tr data-row="${r.row}" data-edit-panel="${r.row}" data-slip-of="${esc(g.key)}" class="row-hover border-t border-paper-line/70 cursor-pointer ${on ? "bg-[#eef6f1]" : ""} ${dirty ? "bg-[#fff4d6]" : ""}">
                <td class="px-1 py-0.5 text-center">
                  <input type="checkbox" class="w-3.5 h-3.5 accent-ok" data-check="${r.row}" ${draft ? "checked" : ""} />
                </td>
                <td class="px-0.5 py-0.5 text-center">
                  <input data-edit-name="${r.row}" value="${esc(r.name || "")}"
                    class="inspect-cell-input w-full rounded border border-paper-line bg-white text-center px-1" />
                  <div class="mt-0.5 flex justify-center">${orderMatchBadgeHtml_(r, orderIdx)}</div>
                </td>
                <td class="px-0.5 py-0.5 text-center">
                  <input data-edit-receipt-name="${r.row}" value="${esc(r.receiptName || "")}"
                    class="inspect-cell-input w-full rounded border border-paper-line bg-white text-center px-1" title="영수증 원문 품목명" />
                </td>
                <td class="px-0.5 py-0.5 text-center">
                  <input data-edit-spec="${r.row}" value="${esc(r.spec || "")}"
                    class="inspect-cell-input w-full rounded border border-paper-line bg-white text-center" />
                </td>
                <td class="px-0.5 py-0.5 text-right">
                  <input data-edit-qty="${r.row}" value="${esc(formatMoneyInput(r.qty))}"
                    class="inspect-cell-input w-full rounded border border-paper-line bg-white text-right tabular-nums" />
                </td>
                <td class="px-0.5 py-0.5 text-right">
                  <input data-edit-final="${r.row}" value="${esc(formatMoneyInput(r.final))}"
                    class="inspect-cell-input w-full rounded border border-paper-line bg-white text-right tabular-nums font-semibold" />
                </td>
                <td class="px-0.5 py-0.5 text-right">
                  <input data-edit-unit="${r.row}" value="${esc(formatMoneyInput(r.unitPrice))}"
                    class="inspect-cell-input w-full rounded border border-paper-line bg-white text-right tabular-nums ${moneyNegClass(r.unitPrice)}" />
                </td>
                <td class="px-0.5 py-0.5 text-right">
                  <input data-edit-line="${r.row}" value="${esc(formatMoneyInput(line))}"
                    class="inspect-cell-input w-full rounded border border-paper-line bg-white text-right tabular-nums font-medium ${neg}" />
                </td>
                <td class="px-0.5 py-0.5 text-center text-[10px] ${draft ? "text-ok" : "text-[#c46a1b]"}">${saved !== draft ? (draft ? "✓미적용" : "대기") : (draft ? "완료" : "대기")}</td>
              </tr>`;
            }).join("");
            return header + body;
          }).join("")}
        </tbody>
      </table>
    </div>
`;
}

function cardsHtml(_rows) {
  if (state.loading) return `<div class="mobile-only p-2 text-sm text-black/50">불러오는 중…</div>`;
  const groups = groupedVisibleRows();
  const orderIdx = buildInspectOrderMatchIndex_();
  if (!groups.length) {
    return `<div class="mobile-only p-3 space-y-3 pb-24">
      <div class="text-[14px] text-black/55">조건에 맞는 입고가 없습니다.</div>
      ${missingPendingOrdersHtml_({ wrapClass: "" })}
    </div>`;
  }
  return `
    <div class="mobile-only dense-list pb-24">
      <div class="px-3 pt-3">${missingPendingOrdersHtml_({ wrapClass: "mb-3" })}</div>
      ${groups.map((g) => {
        const allOn = g.items.every((r) => draftChecked(r));
        const anyDirty = g.items.some((r) => draftChecked(r) !== !!r.checked);
        const amtChk = slipAmountCheck(g.items);
        return `
        <div class="slip-group">
          <div class="slip-header m-slip-header flex items-center gap-1.5 py-1 px-1.5 bg-[#ece8e1] border-b border-paper-line" data-slip-block="${esc(g.key)}">
            <label class="shrink-0 inline-flex items-center justify-center w-7 h-7" title="전표 전체 검수">
              <input type="checkbox" class="dense-check" data-slip-check="${esc(g.key)}" ${allOn ? "checked" : ""} />
            </label>
            <div class="min-w-0 flex-1 leading-tight">
              <div class="flex items-center gap-1 flex-wrap mb-0.5">${slipMetaEditHtml_(g.key, g.items)}</div>
              <div class="flex items-center gap-1 flex-wrap">
                ${slipDailyEditHtml(g.key, g.items)}
                <span class="text-[9px] text-black/40">${g.items.length}품목${anyDirty ? " · 미적용" : ""}${amtChk.mismatch ? " · 금액이상" : ""}</span>
              </div>
            </div>
            ${slipActionBtnsHtml_(g.key, { icon: true })}
          </div>
          ${g.items.map((r) => {
            const draft = draftChecked(r);
            const dirty = draft !== !!r.checked;
            const on = r.row === state.selectedId;
            const line = r.lineAmount != null ? r.lineAmount : r.amount;
            const qtyShow = r.final != null && r.final !== "" ? r.final : r.qty;
            const negAmt = moneyNegClass(line);
            return `
            <div class="m-card dense-row ${dirty ? "is-dirty" : ""} ${draft ? "is-checked" : ""} ${on ? "is-open" : ""}" data-row="${r.row}">
              <input type="checkbox" class="dense-check" data-check="${r.row}" ${draft ? "checked" : ""} />
              <button type="button" class="m-card-body min-w-0 flex-1" data-select-row="${r.row}">
                <span class="m-card-name">${esc(r.name)}</span>
                <span class="block mt-0.5">${orderMatchBadgeHtml_(r, orderIdx)}</span>
                <span class="m-card-meta">
                  <span class="m-card-spec">${esc(r.spec || "—")}</span>
                  <span class="m-card-qty tabular-nums">${esc(formatMoney(qtyShow) || "—")}</span>
                  <span class="m-card-amt tabular-nums ${negAmt}">${esc(formatMoney(line) || "—")}</span>
                </span>
              </button>
            </div>
            ${on ? `
            <div data-edit-panel="${r.row}" data-slip-of="${esc(g.key)}" class="m-card-edit px-1.5 pb-1.5 bg-[#f7f4ef] border-b border-paper-line space-y-1">
              <label class="block text-[9px] text-black/45 text-center">품목명
                <input data-edit-name="${r.row}" value="${esc(r.name || "")}" class="compact-control mt-0.5 w-full rounded border border-paper-line bg-white px-1.5 text-[11px] text-center" />
              </label>
              <label class="block text-[9px] text-black/45 text-center">영수증상품목명
                <input data-edit-receipt-name="${r.row}" value="${esc(r.receiptName || "")}" class="compact-control mt-0.5 w-full rounded border border-paper-line bg-white px-1.5 text-[11px] text-center" />
              </label>
              <label class="block text-[9px] text-black/45 text-center">규격
                <input data-edit-spec="${r.row}" value="${esc(r.spec || "")}" class="compact-control mt-0.5 w-full rounded border border-paper-line bg-white px-1.5 text-[11px] text-center" />
              </label>
              <div class="grid grid-cols-2 gap-1">
                <label class="block text-[9px] text-black/45 text-center">영수증수량
                  <input data-edit-qty="${r.row}" value="${esc(formatMoneyInput(r.qty))}" class="compact-control mt-0.5 w-full rounded border border-paper-line bg-white px-1.5 text-[11px] text-right tabular-nums" />
                </label>
                <label class="block text-[9px] text-black/45 text-center">반영수량
                  <input data-edit-final="${r.row}" value="${esc(formatMoneyInput(r.final))}" class="compact-control mt-0.5 w-full rounded border border-paper-line bg-white px-1.5 text-[11px] text-right tabular-nums" />
                </label>
                <label class="block text-[9px] text-black/45 text-center">단가
                  <input data-edit-unit="${r.row}" value="${esc(formatMoneyInput(r.unitPrice))}" class="compact-control mt-0.5 w-full rounded border border-paper-line bg-white px-1.5 text-[11px] text-right tabular-nums ${moneyNegClass(r.unitPrice)}" />
                </label>
                <label class="block text-[9px] text-black/45 text-center">매입금액
                  <input data-edit-line="${r.row}" value="${esc(formatMoneyInput(line))}" class="compact-control mt-0.5 w-full rounded border border-paper-line bg-white px-1.5 text-[11px] text-right tabular-nums ${negAmt}" />
                </label>
              </div>
            </div>` : ""}`;
          }).join("")}
        </div>`;
      }).join("")}
    </div>`;
}

function detailHtml() {
  const row = selectedRow();
  // PC 전용: 입고대기 표 + 영수증. 전표 상세 카드는 가운데 목록에서 처리.
  const meta = row ? slipImageMeta(row) : { url: "", ver: "" };
  const img = row ? withImageVer(meta.url, meta.ver) : "";
  return `
    <aside class="desktop-only w-[calc(42%-2.5rem)] xl:w-[calc(45%-2.5rem)] shrink-0 border-l border-paper-line bg-paper-card flex flex-col min-h-0 overflow-hidden">
      <div class="shrink-0 px-3 pt-3 pb-2">
        ${missingPendingOrdersHtml_({ compact: true, wrapClass: "" })}
      </div>
      <div class="flex-1 min-h-0 flex flex-col px-3 pb-3">
        <div class="text-[12px] font-semibold mb-1.5 text-black/70">영수증 / 명세서${row ? ` · <span class="font-normal text-black/45">${esc(row.vendor || "")} ${esc(formatDate(row.date) || "")}</span>` : ""}</div>
        ${img
          ? receiptViewerFrameHtml_(img, { id: "receiptPreviewImg", minH: "420px" })
          : `<div class="receipt-frame flex-1 overflow-hidden rounded-2xl border border-dashed border-paper-line grid place-items-center text-center p-4 text-sm text-black/45 bg-white" style="min-height:280px">
              <div><i class="fa-regular fa-image text-3xl mb-2 block text-brand/30"></i>${row ? "연결된 명세서 이미지가 없습니다" : "가운데 목록에서 전표를 선택하세요"}</div>
            </div>`}
      </div>
    </aside>`;
}

function placeholderMenu(title) {
  return `
    <div class="flex-1 grid place-items-center p-8 text-center">
      <div>
        <div class="text-4xl text-brand/25 mb-3"><i class="fa-solid fa-screwdriver-wrench"></i></div>
        <h2 class="text-xl font-bold mb-2">${esc(title)}</h2>
        <p class="text-sm text-black/50">다음 단계에서 연결됩니다.</p>
      </div>
    </div>`;
}

/** 부모대표코드 후보 (구분 필터). 목록에는 코드 숨기고 품목명만 1행 표시 */
function unregParentMaterialChoices_(category) {
  const cat = category || "기타";
  return (state.unregMaterials || [])
    .filter((m) => String(m.category || "") === cat && m.code)
    .slice(0, 400)
    .map((m) => ({
      code: String(m.code || "").trim(),
      name: String(m.name || "").trim(),
      category: String(m.category || "").trim(),
      // 목록 표시: 코드 없이 1행
      label: "[" + (m.category || "") + "] " + (m.name || "")
    }));
}

function unregMaterialOptionsForCategory(category) {
  // 레거시 datalist용 (미사용 시에도 안전)
  return unregParentMaterialChoices_(category)
    .map((m) => `<option value="${esc(m.code + " " + m.name)}"></option>`)
    .join("");
}

function unregListId(key) {
  return "unregCodeList_" + String(key || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function selectedUnregGroup() {
  const key = state.unregSelectedKey;
  if (!key) return null;
  const visible = unregVisibleGroups();
  return visible.find((g) => g.key === key)
    || (state.unregGroups || []).find((g) => g.key === key)
    || null;
}

/** 원재료관리 receiptUrl + receiptUptime → 캐시버스팅 img src (없으면 "") */
function unregReceiptImgSrc_(g) {
  if (!g) return "";
  const url = String(g.receiptUrl || g.imageUrl || "").trim();
  if (!url) return "";
  return withImageVer(url, g.receiptUptime || g.imageVer || "0");
}

/** 좌측 미등록 카드 is-selected 만 갱신 (전체 render 없음) */
function markUnregItemSelected_(key) {
  const want = String(key);
  document.querySelectorAll("[data-unreg-select]").forEach((el) => {
    el.classList.toggle("is-selected", el.getAttribute("data-unreg-select") === want);
  });
}

/** 우측 미등록 영수증 패널만 DOM 교체 + 인플레이스 줌 바인딩 */
function updateUnregReceiptPanel_() {
  const panel = document.getElementById("unregReceiptPanel");
  if (!panel) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = unregReceiptPanelHtml().trim();
  const next = wrap.firstElementChild;
  if (!next) return;
  panel.replaceWith(next);
  bindPanelReceiptViewers_(next);
}

/**
 * 미등록 행 클릭: 전체 render() 중단 → 스크롤 점프 방지
 * (이전: collect + state 변경 + render() → unregScrollArea 재생성 → scrollTop=0)
 */
function selectUnregItem_(key) {
  if (!key || state.unregSelectedKey === key) return;
  // 입력 중 값은 state 에만 반영 (DOM 은 유지)
  collectUnregDraftsFromDom();
  state.unregSelectedKey = key;
  markUnregItemSelected_(key);
  updateUnregReceiptPanel_();
}

/** 부모대표코드 바깥 클릭 시 목록 닫기 (1회만 바인딩) */
let unregParentOutsideBound_ = false;
function bindUnregParentOutsideOnce_() {
  if (unregParentOutsideBound_) return;
  unregParentOutsideBound_ = true;
  document.addEventListener(
    "mousedown",
    (e) => {
      document.querySelectorAll("[data-unreg-parent-wrap]").forEach((wrap) => {
        if (!wrap.isConnected || wrap.contains(e.target)) return;
        const drop = wrap.querySelector(".unreg-parent-dropdown");
        if (drop) drop.classList.add("hidden");
      });
    },
    true
  );
}

/** 부모대표코드: 커스텀 드롭다운 (1행·코드숨김·높이 약 2배) */
function bindUnregParentPickers_(root) {
  bindUnregParentOutsideOnce_();
  const scope = root || document;
  scope.querySelectorAll("[data-unreg-parent-wrap]").forEach((wrap) => {
    if (wrap.dataset.parentPickBound === "1") return;
    wrap.dataset.parentPickBound = "1";
    const input = wrap.querySelector("[data-unreg-parent-code]");
    const drop = wrap.querySelector(".unreg-parent-dropdown");
    if (!input || !drop || input.disabled) return;
    const cat = wrap.getAttribute("data-unreg-parent-cat") || "기타";

    const hide_ = () => {
      drop.classList.add("hidden");
      drop.classList.remove("is-above");
      wrap.style.zIndex = "";
    };
    const placeDrop_ = () => {
      const rect = input.getBoundingClientRect();
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 8);
      const spaceAbove = Math.max(0, rect.top - 8);
      const prefer = Math.min(window.innerHeight * 0.55, 480);
      const openAbove = spaceBelow < prefer && spaceAbove > spaceBelow;
      drop.classList.toggle("is-above", openAbove);
      const avail = openAbove ? spaceAbove : spaceBelow;
      drop.style.maxHeight = Math.max(160, Math.min(480, avail)) + "px";
      wrap.style.zIndex = "50";
    };
    const showFiltered_ = () => {
      const q = String(input.value || "").trim().toLowerCase();
      const qCode = parseUnregCodeInput(input.value || "").toLowerCase();
      const items = unregParentMaterialChoices_(cat).filter((m) => {
        if (!q) return true;
        const hay = (m.label + " " + m.code + " " + m.name).toLowerCase();
        return hay.includes(q) || (qCode && m.code.toLowerCase().includes(qCode));
      });
      if (!items.length) {
        drop.innerHTML = '<div class="unreg-parent-empty">검색 결과 없음</div>';
      } else {
        drop.innerHTML = items
          .map(
            (m) =>
              '<button type="button" class="unreg-parent-option" role="option" data-code="' +
              esc(m.code) +
              '" data-name="' +
              esc(m.name) +
              '" title="' +
              esc(m.code) +
              '"><span class="unreg-parent-option-label">' +
              esc(m.label) +
              "</span></button>"
          )
          .join("");
      }
      drop.classList.remove("hidden");
      placeDrop_();
    };

    input.addEventListener("focus", () => showFiltered_());
    input.addEventListener("input", () => showFiltered_());
    input.addEventListener("click", () => showFiltered_());
    drop.addEventListener("mousedown", (e) => {
      const btn = e.target && e.target.closest && e.target.closest(".unreg-parent-option");
      if (!btn) return;
      e.preventDefault();
      const code = btn.getAttribute("data-code") || "";
      const name = btn.getAttribute("data-name") || "";
      input.value = code + (name ? " " + name : "");
      hide_();
      const row = wrap.closest("[data-unreg-row]");
      const key = row && row.getAttribute("data-unreg-row");
      if (key) {
        const g = (state.unregGroups || []).find((x) => x.key === key) || { key: key };
        const d = ensureUnregDraft(g);
        d.parentCode = code;
      }
    });
  });
}

/** 상태변경 render 전: 확대된 영수증 패널을 분리 보관 */
function detachUnregReceiptPanelIfSame_() {
  if (!state.unregOpen) return null;
  const panel = document.getElementById("unregReceiptPanel");
  if (!panel) return null;
  const key = String(state.unregSelectedKey || "");
  if (!key) return null;
  const img = panel.querySelector("#unregReceiptPreview");
  if (!img) return null;
  const liveSrc = img.getAttribute("src") || "";
  const g = selectedUnregGroup();
  const expectSrc = g ? unregReceiptImgSrc_(g) : "";
  const base = (s) => String(s || "").split("?")[0];
  if (!expectSrc || base(liveSrc) !== base(expectSrc)) return null;
  if (!state.unregReceiptZoomByKey) state.unregReceiptZoomByKey = {};
  state.unregReceiptZoomByKey[key] = {
    src: liveSrc,
    scale: Number(img.dataset.zoomScale) || 1,
    x: Number(img.dataset.panX) || 0,
    y: Number(img.dataset.panY) || 0
  };
  panel.remove();
  return { key: key, srcBase: base(liveSrc), el: panel };
}

/** render 후: 같은 품목·이미지면 분리해 둔 영수증 패널 재부착 */
function reattachUnregReceiptPanel_(saved) {
  if (!saved || !saved.el || !state.unregOpen) return false;
  if (String(state.unregSelectedKey || "") !== saved.key) return false;
  const g = selectedUnregGroup();
  const expectSrc = g ? unregReceiptImgSrc_(g) : "";
  const base = (s) => String(s || "").split("?")[0];
  if (!expectSrc || saved.srcBase !== base(expectSrc)) return false;
  const fresh = document.getElementById("unregReceiptPanel");
  if (!fresh || fresh === saved.el) return false;
  fresh.replaceWith(saved.el);
  return true;
}

function unregReceiptPanelHtml() {
  const g = selectedUnregGroup();
  // id=unregReceiptPanel → 행 클릭 시 이 aside 만 replaceWith
  if (!g) {
    return `
      <aside id="unregReceiptPanel" class="unreg-receipt-panel hidden lg:flex w-[40%] xl:w-[42%] shrink-0 border-l border-paper-line bg-paper-card flex-col min-h-0 overflow-hidden">
        <div class="px-4 pt-4 pb-2 shrink-0">
          <h3 class="font-bold text-base">영수증 / 명세서</h3>
          <p class="text-[12px] text-black/50 mt-1">왼쪽 목록에서 품목을 선택하세요.</p>
        </div>
        <div class="flex-1 min-h-0 px-4 pb-4">
          <div class="receipt-frame h-full min-h-[280px] rounded-2xl border border-dashed border-paper-line grid place-items-center text-center p-4 text-sm text-black/45 bg-white">
            <div><i class="fa-regular fa-image text-3xl mb-2 block text-brand/30"></i>선택된 품목 없음</div>
          </div>
        </div>
      </aside>`;
  }
  // 원재료관리 영수증위치 + ?v=영수증UPTIME (캐시 버스팅) → Zoom/Pan 뷰어
  const img = unregReceiptImgSrc_(g);
  return `
    <aside id="unregReceiptPanel" class="unreg-receipt-panel hidden lg:flex w-[40%] xl:w-[42%] shrink-0 border-l border-paper-line bg-paper-card flex-col min-h-0 overflow-hidden">
      <div class="px-4 pt-4 pb-2 shrink-0 space-y-1">
        <h3 class="font-bold text-base leading-tight">영수증 / 명세서</h3>
        <p class="text-[12px] text-black/55 truncate" title="${esc(g.name)}">${esc(g.name)}</p>
        <p class="text-[11px] text-black/40">${esc(g.regStatus || "")}${(g.units || []).length ? ` · ${(g.units || []).join(" / ")}` : ""}</p>
      </div>
      <div class="flex-1 min-h-0 flex flex-col px-4 pb-4">
        ${img
          ? receiptViewerFrameHtml_(img, { id: "unregReceiptPreview", minH: "280px" })
          : `<div class="receipt-frame flex-1 overflow-hidden rounded-2xl border border-dashed border-paper-line grid place-items-center text-center p-4 text-sm text-black/45 bg-white" style="min-height:280px">
              <div><i class="fa-regular fa-image text-3xl mb-2 block text-brand/30"></i>연결된 명세서 이미지가 없습니다</div>
            </div>`}
      </div>
    </aside>`;
}

/** 원재료 코드 관리: 헤더·본문 공통 컬럼 폭 (1:1, 가로스크롤 없음) */
const UNREG_COL = {
  check: "w-5 text-center flex-shrink-0 flex items-center justify-center",
  code: "w-24 text-center flex-shrink-0",
  name: "flex-1 min-w-[150px]",
  cat: "w-20 text-center flex-shrink-0",
  spec: "w-28 text-center flex-shrink-0",
  conv: "w-16 text-center flex-shrink-0",
  unit: "w-16 text-center flex-shrink-0",
  status: "w-24 text-center flex-shrink-0",
  /** 별칭: 부모대표코드 검색 (= 규격+환산+단위 폭) */
  linkSpan: "w-64 flex-shrink-0",
};

function unregHeaderHtml(allChecked) {
  return `
    <div class="unreg-thead sticky top-0 z-10 bg-gray-100 border-b">
      <div class="unreg-row w-full flex flex-row flex-nowrap items-center gap-2 px-2.5 py-1.5">
        <div class="${UNREG_COL.check}" title="전체 선택">
          <input type="checkbox" id="unregCheckAll" class="dense-check" ${allChecked ? "checked" : ""} />
        </div>
        <div class="${UNREG_COL.code} text-[10px] font-semibold text-black/55 truncate">원재료코드</div>
        <div class="${UNREG_COL.name} text-[10px] font-semibold text-black/55 truncate">품목명</div>
        <div class="${UNREG_COL.cat} text-[10px] font-semibold text-black/55">구분</div>
        <div class="${UNREG_COL.spec} text-[10px] font-semibold text-black/55">입고단위/규격</div>
        <div class="${UNREG_COL.conv} text-[10px] font-semibold text-black/55">재고수환산</div>
        <div class="${UNREG_COL.unit} text-[10px] font-semibold text-black/55">재고단위</div>
        <div class="${UNREG_COL.status} text-[10px] font-semibold text-black/55">등록구분</div>
      </div>
    </div>`;
}

function unregRowHtml(g) {
  const d = ensureUnregDraft(g);
  const codeText = String(g.code || "").trim();
  const hasCode = !!codeText;
  const savedStatus = normalizeUnregStatusFront_(g.regStatus, hasCode);
  const regStatus = normalizeUnregStatusFront_(d.regStatus || g.regStatus, hasCode);
  const showParentPick = regStatus === "별칭"; // 부모대표코드 검색
  const isRepEdit = !showParentPick && (hasCode || regStatus === "대표");
  const cat = d.category || g.suggestedCategory || "기타";
  const on = state.unregSelectedKey === g.key;
  const rowEditable = !!d.checked;
  const unitDisabled = !rowEditable || showParentPick;
  const dis = rowEditable ? "" : "disabled";
  const inputCls = "unreg-input w-full rounded border border-paper-line bg-white px-1 h-8 text-[11px] text-[#1a1a1a]";
  const inputOff = rowEditable ? "" : " unreg-input-locked";
  // 별칭: 코드칸은 비움(_01 숨김). 부모코드는 검색칸에만
  const isAliasRow = regStatus === "별칭";
  const codeDisplay = isAliasRow ? "" : codeText;
  const codeInputCls = `${inputCls} text-center tabular-nums bg-[#f3f5f3] text-[#1a1a1a] font-medium`;
  const aliases = Array.isArray(g.aliases) ? g.aliases : [];
  const statusCls = unregStatusSelectCls_(regStatus);
  const parentVal = d.parentCode || g.parentCode || "";

  const codeColHtml = `
        <div class="${UNREG_COL.code} unreg-stop">
          <input type="text" value="${esc(codeDisplay)}" readonly tabindex="-1"
            class="${codeInputCls}"
            title="${isAliasRow ? "별칭은 원재료코드 없음(부모대표코드 사용)" : "원재료코드(수정 불가)"}" placeholder="-" />
          ${isRepEdit
            ? `<input type="hidden" data-unreg-code value="${esc(codeText)}" />`
            : `<input type="hidden" data-unreg-code value="" />`}
        </div>`;

  const parentPickHtml = `
       <div class="${UNREG_COL.linkSpan} unreg-stop unreg-parent-pick relative" data-unreg-parent-wrap data-unreg-parent-cat="${esc(cat)}">
         <div class="text-[9px] text-[#1d4f91] font-semibold leading-none mb-0.5">부모대표코드</div>
         <input data-unreg-parent-code value="${esc(parentVal)}" autocomplete="off"
           class="${inputCls} unreg-parent-input${inputOff}" placeholder="품목명 검색 후 선택" ${dis} />
         <div class="unreg-parent-dropdown hidden" role="listbox"></div>
         <input type="hidden" data-unreg-spec value="${esc(d.spec || "")}" />
         <input type="hidden" data-unreg-conversion value="${esc(d.conversion || "1")}" />
         <input type="hidden" data-unreg-stockunit value="${esc(d.stockUnit || "개")}" />
       </div>`;

  const unitCols = showParentPick
    ? parentPickHtml
    : `<div class="${UNREG_COL.spec} unreg-stop">
           <input data-unreg-spec value="${esc(d.spec || "")}"
             class="${inputCls} text-center${inputOff}" placeholder="Box/Kg" ${unitDisabled ? "disabled" : ""} />
         </div>
         <div class="${UNREG_COL.conv} unreg-stop">
           <input data-unreg-conversion type="number" step="any" min="0" value="${esc(d.conversion || "1")}"
             class="${inputCls} text-center${inputOff}" placeholder="1" ${unitDisabled ? "disabled" : ""} />
         </div>
         <div class="${UNREG_COL.unit} unreg-stop">
           <input data-unreg-stockunit value="${esc(d.stockUnit || "개")}"
             class="${inputCls} text-center${inputOff}" placeholder="개" ${unitDisabled ? "disabled" : ""} />
         </div>`;

  return `
    <article class="unreg-card border-b border-paper-line cursor-pointer ${on ? "is-selected" : ""} ${rowEditable ? "is-editing" : "is-locked"}"
      data-unreg-row="${esc(g.key)}" data-unreg-select="${esc(g.key)}">
      <div class="unreg-row w-full flex flex-row flex-nowrap items-center gap-2 px-2.5 py-1">
        <div class="${UNREG_COL.check} h-8 unreg-stop">
          <input type="checkbox" class="dense-check" data-unreg-check ${d.checked ? "checked" : ""}
            title="체크 시 이 행 수정 가능" />
        </div>
        ${codeColHtml}
        <div class="${UNREG_COL.name} unreg-stop min-w-0">
          <input data-unreg-name value="${esc(d.name || g.name)}"
            class="${inputCls} min-w-0${inputOff}" placeholder="품목명" title="${esc(g.name)}" ${dis} />
          ${unregAliasBadgesHtml_(aliases)}
        </div>
        <div class="${UNREG_COL.cat} unreg-stop">
          <select data-unreg-category class="${inputCls} text-center${inputOff}" ${dis}>
            ${STOCK_CATEGORIES.map((c) => `<option value="${esc(c)}" ${c === cat ? "selected" : ""}>${esc(c)}</option>`).join("")}
          </select>
        </div>
        ${unitCols}
        <div class="${UNREG_COL.status} unreg-stop">
          <select data-unreg-status class="${inputCls} text-center text-[10px] ${statusCls}${inputOff}" ${dis}>
            ${unregStatusOptionsFor_(savedStatus, regStatus).map((s) => `<option value="${esc(s)}" ${s === regStatus ? "selected" : ""}>${esc(s)}</option>`).join("")}
          </select>
        </div>
      </div>
    </article>`;
}

function unregHtml() {
  const groups = unregVisibleGroups();
  const checkedCount = groups.filter((g) => ensureUnregDraft(g).checked).length;
  const allChecked = groups.length > 0 && checkedCount === groups.length;
  const filterOpts = ["전체", "대표", "별칭", "미등록", "등록제외"];
  const listBody = !groups.length
    ? `<div class="p-6 text-sm text-black/50">조건에 맞는 품목이 없습니다.</div>`
    : `<div class="unreg-list w-full min-w-0">
        ${unregHeaderHtml(allChecked)}
        ${groups.map((g) => unregRowHtml(g)).join("")}
      </div>`;

  return `
    <section class="flex-1 min-w-0 min-h-0 flex overflow-hidden">
      <div class="flex-1 min-w-0 min-h-0 flex flex-col p-2 sm:p-3 lg:p-3 lg:pr-2 overflow-hidden">
        <div class="mb-2 shrink-0 flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <h2 class="text-lg lg:text-xl font-bold tracking-tight">원재료 코드 관리</h2>
            <p class="text-[11px] text-black/50 mt-0.5">${esc(state.jobMessage || "원재료관리 전체 · 코드 오름차순 · 미등록은 맨 뒤")}</p>
          </div>
          <div class="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <select id="unregFilter" class="compact-control rounded-lg border border-paper-line bg-white px-2 text-xs min-w-[7rem]">
              ${filterOpts.map((o) => `<option value="${esc(o)}" ${state.unregFilter === o ? "selected" : ""}>${esc(o)}</option>`).join("")}
            </select>
            <button id="btnUnregReflectQty" type="button"
              class="compact-control shrink-0 rounded-lg border border-brand/40 bg-[#eef6f1] px-3 text-xs font-bold text-brand"
              title="열린 달 원재료입고 최종반영수량을 다시 계산합니다"
              ${state.jobBusy ? "disabled" : ""}>원재료입고반영</button>
            <button id="btnUnregBatchSave" type="button"
              class="compact-control shrink-0 rounded-lg bg-ok text-white px-3 text-xs font-bold"
              ${state.jobBusy || !checkedCount ? "disabled" : ""}>저장${checkedCount ? ` ${checkedCount}` : ""}</button>
            <button id="btnUnregClose" class="compact-control rounded-lg border border-paper-line bg-white px-3 text-xs">닫기</button>
          </div>
        </div>
        <div id="unregScrollArea" class="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden scroll-thin rounded-xl border border-paper-line bg-white shadow-panel">
          ${listBody}
        </div>
        <p class="mt-1.5 shrink-0 text-[10px] text-black/40">상태변경=미등록 경유 · 별칭=부모대표코드 · 저장 시 입고 O/P 동기화 · 원재료입고반영=수량 재계산</p>
      </div>
      ${unregReceiptPanelHtml()}
    </section>`;
}

function priceHtml() {
  const list = priceVisible();
  const item = selectedPriceItem();
  const cats = priceCategories();
  const periods = [
    { m: 0, label: "당월" },
    { m: 1, label: "1개월" },
    { m: 3, label: "3개월" },
    { m: 6, label: "6개월" },
    { m: 12, label: "1년" },
  ];

  const desktopList = state.priceLoading
    ? `<div class="p-3 text-sm text-black/50">불러오는 중…</div>`
    : !list.length
      ? `<div class="p-3 text-sm text-black/50">조건에 맞는 단가가 없습니다.</div>`
      : list.map((r) => {
        const on = item && r.key === item.key;
        const u = r.stockUnit ? `/${r.stockUnit}` : "";
        const cat = r.category || "";
        const tip = [cat, r.code, r.name].filter(Boolean).join(" · ");
        return `<button type="button" data-price-key="${esc(r.key)}" title="${esc(tip)}" class="w-full text-left px-2.5 py-1.5 border-b border-paper-line hover:bg-[#f3f6f3] ${on ? "bg-[#eef6f1] font-bold" : ""}">
          <div class="flex items-center gap-1.5 min-w-0 text-[12px] leading-tight">
            <span class="shrink-0 max-w-[3.5rem] truncate text-black/45">${esc(cat || "—")}</span>
            <span class="min-w-0 flex-1 truncate font-medium">${esc(r.name)}</span>
            <span class="tabular-nums font-semibold text-brand shrink-0">${esc(moneyTextInt(r.average))}원${esc(u)}</span>
          </div>
        </button>`;
      }).join("");

  const mobileList = state.priceLoading
    ? `<div class="px-2 py-1.5 text-[12px] text-black/50">불러오는 중…</div>`
    : !list.length
      ? `<div class="px-2 py-1.5 text-[12px] text-black/50">단가 없음</div>`
      : list.map((r) => {
        const on = item && r.key === item.key;
        const cat = r.category || "";
        return `<button type="button" data-price-key="${esc(r.key)}" class="shrink-0 max-w-[200px] rounded-lg border px-2.5 py-1.5 text-left ${on ? "bg-[#eef6f1] border-brand/40 font-bold" : "bg-white border-paper-line"}">
          <div class="flex items-center gap-1 min-w-0 text-[11px] leading-tight">
            <span class="shrink-0 max-w-[2.5rem] truncate text-black/45">${esc(cat || "—")}</span>
            <span class="min-w-0 flex-1 truncate font-medium">${esc(r.name)}</span>
            <span class="tabular-nums font-semibold text-brand shrink-0">${esc(moneyTextInt(r.average))}</span>
          </div>
        </button>`;
      }).join("");

  return `
    <section class="flex-1 min-w-0 min-h-0 flex flex-col p-3 lg:p-6 overflow-hidden">
      <div class="mb-2 shrink-0 space-y-2">
        ${screenTitleRowHtml_({
          title: "단가 추이",
          selectId: "priceMonthSelect",
          rightHtml: `${esc(state.priceStart)} ~ ${esc(state.priceEnd)} · ${state.priceRows.length}품목
            <div class="text-[11px] text-black/40">화면 ${UI_VERSION}${state.apiVersion ? ` · 서버 ${esc(state.apiVersion)}` : ""}</div>`
        })}
        <div class="flex items-center gap-2 flex-nowrap overflow-x-auto scroll-thin pb-0.5">
          ${periods.map((p) => `
            <button data-price-months="${p.m}" class="compact-control shrink-0 rounded-lg border px-3 text-xs ${Number(state.priceMonths) === p.m ? "bg-brand text-white border-brand" : "bg-white border-paper-line"}">${p.label}</button>
          `).join("")}
          <select id="priceCategory" class="compact-control shrink-0 rounded-lg border border-paper-line bg-white px-2 text-xs min-w-[7rem]">
            ${cats.map((c) => `<option value="${esc(c)}" ${c === state.priceCategory ? "selected" : ""}>${c === "전체" ? "구분: 전체" : esc(c)}</option>`).join("")}
          </select>
          <div class="flex flex-1 min-w-[140px]">
            <input id="priceSearch" value="${esc(state.priceSearchText)}" placeholder="품목·코드 (Enter)"
              class="compact-control w-full rounded-l-lg border border-paper-line bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-brand/25" />
            <button type="button" id="btnPriceSearch" class="compact-control rounded-r-lg border border-l-0 border-paper-line bg-white px-2.5" title="검색">
              <i class="fa-solid fa-magnifying-glass text-[11px] text-black/45"></i>
            </button>
          </div>
          <button id="btnPriceRefresh" class="compact-control shrink-0 rounded-lg border border-paper-line bg-white px-2 text-xs" title="새로고침"><i class="fa-solid fa-rotate-right"></i></button>
        </div>
        <p class="text-[11px] text-black/45 desktop-only">그래프·평균은 <b>재고 1단위당 환산단가</b>(매입금액 ÷ 영수증수량 ÷ 재고수환산) 기준입니다.</p>
        ${state.priceError ? `<div class="text-sm text-red-700">${esc(state.priceError)}</div>` : ""}
      </div>

      <div class="flex-1 min-h-0 flex flex-col lg:flex-row gap-2 lg:gap-3 overflow-hidden">
        <div class="mobile-only shrink-0 -mx-1 px-1">
          <div class="flex gap-1.5 overflow-x-auto scroll-thin pb-1">${mobileList}</div>
        </div>
        <aside id="priceListScroll" class="desktop-only w-[21.75rem] shrink-0 rounded-2xl border border-paper-line bg-white overflow-y-auto scroll-thin shadow-panel min-h-0">${desktopList}</aside>
        <div id="priceDetailPanel" class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden rounded-2xl border border-paper-line bg-paper-card p-3 lg:p-4 shadow-panel">
          ${priceDetailInnerHtml_()}
        </div>
      </div>
    </section>`;
}

function stockItemRowHtml_(r, adjustOn, mode) {
  const qty = (v) => (v === null || v === undefined || v === "" ? "—" : moneyText(v));
  const low = isLowStock(r);
  const tip = [r.name, r.code, r.category, r.spec, r.unit].filter(Boolean).join(" · ");
  const unitSpec = orderUnitSpecLabel_(r);
  const safetyInput = `<input data-stock="${r.row}" data-code="${esc(r.code)}" data-kind="safety"
    value="${r.safety == null ? "" : esc(formatMoneyInput(r.safety))}"
    class="compact-control w-[3.25rem] rounded border border-paper-line bg-white px-0.5 text-right tabular-nums text-[11px]" placeholder="—" title="안전재고" />`;
  const adjInInput = `<input data-stock="${r.row}" data-code="${esc(r.code)}" data-kind="adjustmentIn"
    value="${esc(formatMoneyInput(r.adjustmentIn ?? 0))}"
    class="compact-control w-[3.25rem] rounded border border-paper-line bg-white px-0.5 text-right tabular-nums text-[11px]" title="조정입고" />`;
  const adjLossInput = `<input data-stock="${r.row}" data-code="${esc(r.code)}" data-kind="adjustment"
    value="${esc(formatMoneyInput(r.adjustment ?? 0))}"
    class="compact-control w-[3.25rem] rounded border border-paper-line bg-white px-0.5 text-right tabular-nums text-[11px]" title="조정로스" />`;

  if (mode === "mobile") {
    const short = stockShortageQty(r);
    return `<article class="rounded-2xl border border-paper-line bg-white p-3.5 ${low ? "ring-1 ring-[#f0c56d]" : ""}">
      <div class="text-[12px] text-black/45 text-left">${esc(r.category || "기타")} · ${esc(stockVendorName_(r) || "거래처 미지정")}</div>
      <div class="flex justify-between gap-3 mt-0.5">
        <div class="min-w-0 flex-1">
          <div class="font-bold text-[15px] leading-snug">${esc(r.name)}</div>
          <div class="text-[12px] text-black/40 mt-0.5">${esc(r.code)} · ${esc(unitSpec)}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-[11px] text-black/40">현재고</div>
          <div class="text-[20px] font-bold tabular-nums leading-none">${esc(qty(r.stock))}</div>
          ${short != null ? `<div class="text-[13px] text-red-500 font-bold mt-1">부족 ${esc(moneyText(short))}</div>` : ""}
        </div>
      </div>
      <div class="mt-2 grid grid-cols-3 gap-1.5 text-[11px] text-black/55">
        <div>이월 <span class="tabular-nums text-black/80 font-medium">${esc(qty(r.opening))}</span></div>
        <div>입고 <span class="tabular-nums text-black/80 font-medium">${esc(qty(r.incoming))}</span></div>
        <div>사용 <span class="tabular-nums text-black/80 font-medium">${esc(qty(r.used))}</span></div>
        <div>당일 <span class="tabular-nums text-black/80 font-medium">${esc(qty(r.usedToday))}</span></div>
        <div>평균 <span class="tabular-nums text-black/80 font-medium">${esc(r.avgUsed == null ? "—" : qty(r.avgUsed))}</span></div>
      </div>
      <div class="mt-3 grid ${adjustOn ? "grid-cols-3" : "grid-cols-1"} gap-2 text-[13px]">
        <label class="flex flex-col gap-1">안전재고
          <input data-stock="${r.row}" data-code="${esc(r.code)}" data-kind="safety"
            value="${r.safety == null ? "" : esc(String(r.safety))}"
            class="compact-control w-full rounded-lg border border-paper-line px-2 text-right text-[15px] font-semibold" placeholder="—" />
        </label>
        ${adjustOn ? `
        <label class="flex flex-col gap-1">조정입고
          <input data-stock="${r.row}" data-code="${esc(r.code)}" data-kind="adjustmentIn"
            value="${esc(String(r.adjustmentIn ?? 0))}"
            class="compact-control w-full rounded-lg border border-paper-line px-2 text-right text-[15px]" />
        </label>
        <label class="flex flex-col gap-1">조정로스
          <input data-stock="${r.row}" data-code="${esc(r.code)}" data-kind="adjustment"
            value="${esc(String(r.adjustment ?? 0))}"
            class="compact-control w-full rounded-lg border border-paper-line px-2 text-right text-[15px]" />
        </label>` : ""}
      </div>
    </article>`;
  }

  return `<tr class="border-t border-paper-line ${low ? "bg-[#fdf3ef]" : "bg-white"}" title="${esc(tip)}">
    <td class="px-1 py-1 text-left tabular-nums text-black/55 whitespace-nowrap">${esc(r.code || "")}</td>
    <td class="px-1 py-1 text-left font-medium max-w-[7rem] truncate">${esc(r.name || "")}</td>
    <td class="px-1 py-1 text-right tabular-nums whitespace-nowrap">${esc(qty(r.opening))}</td>
    <td class="px-1 py-1 text-right tabular-nums whitespace-nowrap">${esc(qty(r.incoming))}</td>
    <td class="px-1 py-1 text-right tabular-nums whitespace-nowrap">${esc(qty(r.used))}</td>
    <td class="px-1 py-1 text-right tabular-nums whitespace-nowrap">${esc(qty(r.usedToday))}</td>
    <td class="px-1 py-1 text-right tabular-nums whitespace-nowrap">${esc(r.avgUsed == null ? "—" : qty(r.avgUsed))}</td>
    ${adjustOn ? `
    <td class="px-0.5 py-1 text-right">${adjInInput}</td>
    <td class="px-0.5 py-1 text-right">${adjLossInput}</td>` : ""}
    <td class="px-0.5 py-1 text-right">${safetyInput}</td>
    <td class="px-1 py-1 text-right whitespace-nowrap">${stockCurrentShortageLabel_(r)}</td>
  </tr>`;
}

function stockSectionGroupHtml_(g, adjustOn) {
  const colSpan = adjustOn ? 11 : 9;
  const itemsHtml = (g.items || []).map((r) => stockItemRowHtml_(r, adjustOn, "desktop")).join("");
  return `<tbody data-stock-section="${esc(g.key)}">
    <tr class="bg-[#e8efe9]">
      <td colspan="${colSpan}" class="px-2 py-1 text-left text-[11px] font-bold text-brand">${esc(g.category)} · ${esc(g.vendor)}</td>
    </tr>
    ${itemsHtml}
  </tbody>`;
}

function stockTableHeadHtml_(adjustOn) {
  return `<thead class="stock-thead">
    <tr class="text-[10px]">
      <th class="px-1 py-1.5 font-medium text-left whitespace-nowrap">원재료코드</th>
      <th class="px-1 py-1.5 font-medium text-left whitespace-nowrap">원재료명</th>
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">이월재고</th>
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">이번달입고</th>
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">이번달사용량</th>
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">당일사용량</th>
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">평균사용량</th>
      ${adjustOn ? `
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">조정입고</th>
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">조정로스</th>` : ""}
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">안전재고</th>
      <th class="px-1 py-1.5 font-medium text-right whitespace-nowrap">현재고 (부족)</th>
    </tr>
  </thead>`;
}

function stockGroupsColumnHtml_(groups, adjustOn) {
  return (groups || []).map((g) => stockSectionGroupHtml_(g, adjustOn)).join("");
}

function stockHtml() {
  const rows = stockVisible();
  const cats = stockCategories();
  const adjustOn = !!state.stockAdjustMode;
  const groups = stockSectionGroups_(rows);
  const colCount = 2;
  const cols = splitOrderGroupsCols_(groups, colCount);
  const useMulti = groups.length >= 2;

  const desktopList = state.stockLoading
    ? `<div class="p-6 text-sm text-black/50">불러오는 중…</div>`
    : !rows.length
      ? `<div class="p-6 text-sm text-black/50">조건에 맞는 재고가 없습니다.</div>`
      : useMulti
        ? `<div class="grid grid-cols-2 gap-2 items-start p-1.5">
            ${cols.map((col) => `
              <div class="min-w-0">
                <table class="app-table stock-table w-full text-[11px]">
                  ${stockTableHeadHtml_(adjustOn)}
                  ${stockGroupsColumnHtml_(col, adjustOn)}
                </table>
              </div>`).join("")}
          </div>`
        : `<div class="p-1.5">
            <table class="app-table stock-table w-full text-[11px]">
              ${stockTableHeadHtml_(adjustOn)}
              ${stockGroupsColumnHtml_(groups, adjustOn)}
            </table>
          </div>`;

  const mobileList = state.stockLoading || !rows.length
    ? ""
    : groups.map((g) => `
        <div class="mb-2">
          <div class="sticky top-0 z-10 rounded-lg bg-[#e8efe9] px-2.5 py-1.5 text-[13px] font-bold text-brand text-left mb-1.5">
            ${esc(g.category)} · ${esc(g.vendor)}
          </div>
          <div class="space-y-2">
            ${g.items.map((r) => stockItemRowHtml_(r, adjustOn, "mobile")).join("")}
          </div>
        </div>`).join("");

  return `
    <section class="flex-1 min-w-0 min-h-0 flex flex-col p-3 lg:p-4 overflow-hidden">
      <div class="mb-2 shrink-0 space-y-2">
        ${screenTitleRowHtml_({
          title: "재고관리",
          mobileTitle: "재고",
          selectId: "stockMonthSelect",
          afterSelectHtml: stockUsageDayInputHtml_(),
          splitMobile: true,
          rightHtml: `안전이하 ${state.stockLowCount}개 · 전체 ${state.stockRows.length}개
            <div class="text-[11px] text-black/40">화면 ${UI_VERSION}${state.apiVersion ? ` · 서버 ${esc(state.apiVersion)}` : ""}</div>`,
          rightMobileHtml: `<div class="text-[12px] text-black/45 shrink-0">안전이하 ${state.stockLowCount}</div>`
        })}
      ${pastMonthBannerHtml_()}
        ${closeNagBannerHtml_()}
        <div class="flex flex-wrap gap-1.5 items-stretch">
          <select id="stockCategory" class="compact-control min-w-[7rem] flex-1 sm:flex-none rounded-lg border border-paper-line bg-white px-2">
            ${cats.map((c) => `<option value="${esc(c)}" ${c === state.stockCategory ? "selected" : ""}>${c === "전체" ? "구분: 전체" : esc(c)}</option>`).join("")}
          </select>
          <button id="btnStockLow" class="compact-control rounded-lg border border-paper-line bg-white px-2.5 text-[13px] shrink-0">
            ${state.stockLowOnly ? "전체 보기" : "안전이하만"}
          </button>
          <button id="btnStockAdjustMode" type="button"
            class="compact-control rounded-lg border px-2.5 text-[13px] shrink-0 ${adjustOn ? "bg-[#eef6f1] border-brand/40 text-brand font-semibold" : "bg-white border-paper-line"}"
            title="조정입고·조정로스 열 표시">
            ${adjustOn ? "조정 숨기기" : "조정 보기"}
          </button>
          <button id="btnStockCalculate" type="button"
            class="compact-control rounded-lg bg-brand text-white px-3 text-[13px] font-bold shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
            ${state.stockCalcBusy || state.jobBusy || !isSelectedMonthHasInventory_() ? "disabled" : ""}
            title="${isSelectedMonthHasInventory_() ? "선택월 입고·판매를 반영해 현재고를 다시 계산합니다" : "재고 시트에 이 달 행이 없습니다(월마감 전 다음달 계산 불가)"}">
            ${state.stockCalcBusy
              ? `<i class="fa-solid fa-spinner fa-spin mr-1"></i>계산 중…`
              : `<i class="fa-solid fa-calculator mr-1"></i>재고 계산`}
          </button>
          <button id="btnStockRefresh" class="compact-control rounded-lg border border-paper-line bg-white px-2.5 text-[13px] shrink-0"
            ${state.stockCalcBusy ? "disabled" : ""}>
            <i class="fa-solid fa-rotate-right"></i>
          </button>
          <div class="relative flex-1 min-w-[140px]">
            <i class="fa-solid fa-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-black/35 text-[12px]"></i>
            <input id="stockSearch" value="${esc(state.stockQuery)}" placeholder="품목·코드 검색"
              class="compact-control w-full rounded-lg border border-paper-line bg-white pl-8 pr-2" />
          </div>
        </div>
        ${state.stockError ? `<div class="text-sm text-red-700">${esc(state.stockError)}</div>` : ""}
      </div>
      <div id="stockScrollArea" data-scroll-keep="stockScrollArea" class="desktop-only flex-1 min-h-0 overflow-auto scroll-thin rounded-2xl border border-paper-line bg-white shadow-panel">
        ${desktopList}
      </div>
      <div id="stockMobileScroll" data-scroll-keep="stockMobileScroll" class="mobile-only flex-1 min-h-0 overflow-y-auto scroll-thin space-y-2.5 pb-24">
        ${state.stockLoading
          ? `<div class="p-6 text-sm text-black/50">불러오는 중…</div>`
          : !rows.length
            ? `<div class="p-6 text-sm text-black/50">조건에 맞는 재고가 없습니다.</div>`
            : mobileList}
      </div>
    </section>`;
}

function orderStockShortageLabel_(r) {
  const qty = (v) => (v === null || v === undefined || v === "" ? "—" : moneyText(v));
  const short = stockShortageQty(r);
  if (short == null) return `<span class="tabular-nums font-semibold">${esc(qty(r.stock))}</span>`;
  return `<span class="tabular-nums font-semibold">${esc(qty(r.stock))}</span><span class="text-red-500 font-bold tabular-nums"> (${esc(moneyText(short))})</span>`;
}

function orderVendorEditPanelHtml_(g) {
  const opts = orderVendorOptions_();
  const cur = g.vendor || "";
  return `<div class="mt-1 flex flex-wrap items-center gap-1 pl-6">
    <select data-order-vendor-pick="${esc(g.key)}" class="compact-control rounded border border-paper-line bg-white px-1 text-[11px] min-w-[7rem]">
      ${opts.map((v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("")}
      <option value="__custom__">직접입력</option>
    </select>
    <input data-order-vendor-custom-name="${esc(g.key)}" type="text" value="${esc(cur)}"
      placeholder="주문처명" class="compact-control rounded border border-paper-line bg-white px-1 text-[11px] w-[7rem]" />
    <button type="button" data-order-vendor-apply="${esc(g.key)}"
      class="compact-control rounded bg-brand text-white px-2 text-[11px] font-semibold">적용</button>
    <button type="button" data-order-vendor-cancel="${esc(g.key)}"
      class="compact-control rounded border border-paper-line bg-white px-2 text-[11px]">취소</button>
  </div>`;
}

function orderItemRowHtml_(r, mode) {
  const low = isLowStock(r);
  const draft = ensureStockOrderDraft_(r);
  const orderKey = stockOrderKey_(r);
  const tip = [r.name, r.code, r.category, orderUnitSpecLabel_(r)].filter(Boolean).join(" · ");
  const spec = orderUnitSpecLabel_(r);
  const qtyInput = `<input type="number" min="0" step="1" inputmode="numeric"
    data-stock-order-qty="${esc(orderKey)}"
    value="${esc(draft.orderQty == null ? "" : String(draft.orderQty))}"
    class="compact-control shrink-0 w-[3.5rem] rounded border border-paper-line bg-white px-0.5 text-right tabular-nums text-[12px]"
    placeholder="—" title="주문수량(Box) 추천 ${esc(r.recommendOrderBox === "" || r.recommendOrderBox == null ? "—" : String(r.recommendOrderBox))}" />`;

  if (mode === "mobile") {
    return `<div class="flex gap-1.5 px-2 py-1.5 border-t border-paper-line text-[13px] ${low ? "bg-[#fdf3ef]" : "bg-white"}" data-stock-order-row="${esc(orderKey)}">
      <input type="checkbox" class="order-check accent-ok shrink-0 mt-1" data-stock-order-check="${esc(orderKey)}" ${draft.checked ? "checked" : ""} />
      <div class="min-w-0 flex-1">
        <div class="font-semibold leading-snug text-left" title="${esc(tip)}">${esc(r.name)}</div>
        <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-black/50">
          <span class="truncate max-w-full text-left">${esc(spec)}</span>
          <span class="tabular-nums text-black/70">재고 ${orderStockShortageLabel_(r)}</span>
        </div>
      </div>
      <div class="shrink-0 flex flex-col items-end gap-0.5">
        <span class="text-[10px] text-black/40">주문</span>
        ${qtyInput}
      </div>
    </div>`;
  }

  return `<div class="flex items-center gap-1 px-1 py-0.5 border-t border-paper-line text-[12px] ${low ? "bg-[#fdf3ef]" : "bg-white"}" data-stock-order-row="${esc(orderKey)}">
    <input type="checkbox" class="order-check accent-ok shrink-0" data-stock-order-check="${esc(orderKey)}" ${draft.checked ? "checked" : ""} />
    <div class="min-w-0 flex-1 text-left">
      <div class="font-medium leading-tight truncate" title="${esc(tip)}">${esc(r.name)}</div>
    </div>
    <div class="shrink-0 w-[6.5rem] text-[10px] text-black/45 truncate text-left" title="${esc(spec)}">${esc(spec)}</div>
    <div class="shrink-0 text-right text-[11px] min-w-[4.25rem]">${orderStockShortageLabel_(r)}</div>
    ${qtyInput}
  </div>`;
}

function orderVendorGroupHtml_(g, mode) {
  const editing = state.orderVendorEditKey === g.key;
  const isMobile = mode === "mobile";
  const itemsHtml = g.items.map((r) => orderItemRowHtml_(r, mode)).join("");
  const headClass = isMobile
    ? "order-vendor-head sticky top-0 z-10 flex items-center gap-1.5 px-2 py-2 bg-[#e8efe9] border-b border-paper-line"
    : "flex items-center gap-1 px-1.5 py-1 bg-[#e8efe9]";

  return `<section class="rounded-lg border border-paper-line overflow-hidden bg-white mb-2 text-[12px]" data-order-vendor-group="${esc(g.key)}">
    <div class="${headClass}">
      <input type="checkbox" class="order-check accent-ok shrink-0" data-order-vendor-group-check="${esc(g.key)}" ${g.allChecked ? "checked" : ""} title="이 업체 전체" />
      <div class="min-w-0 flex-1 font-bold ${isMobile ? "text-[14px]" : "text-[13px]"} text-brand truncate">${esc(g.vendor)}</div>
      ${isMobile ? "" : `<div class="shrink-0 w-8" aria-hidden="true"></div>`}
      <button type="button" data-order-vendor-change="${esc(g.key)}"
        class="compact-control shrink-0 rounded border border-brand/30 bg-white px-2 ${isMobile ? "text-[12px] py-1" : "text-[10px] px-1.5"} font-semibold text-brand">주문처변경</button>
    </div>
    ${editing ? orderVendorEditPanelHtml_(g) : ""}
    ${itemsHtml}
  </section>`;
}

function orderGroupsColumnHtml_(groups, mode) {
  return (groups || []).map((g) => orderVendorGroupHtml_(g, mode || "desktop")).join("");
}

function orderHtml() {
  const rows = orderVisible();
  const cats = stockCategories();
  const groups = orderVendorGroups_(rows);
  const allChecked = rows.length > 0 && rows.every((r) => !!ensureStockOrderDraft_(r).checked);
  const colCount = 4;
  const cols = splitOrderGroupsCols_(groups, colCount);
  const useMulti = groups.length >= 2;

  const desktopList = state.stockLoading
    ? `<div class="p-6 text-sm text-black/50">불러오는 중…</div>`
    : !rows.length
      ? `<div class="p-6 text-sm text-black/50">조건에 맞는 발주 후보가 없습니다.</div>`
      : `<div class="p-2">
          <div class="sticky top-0 z-30 flex items-center gap-2 px-1 py-1.5 mb-1 border-b border-paper-line text-[11px] text-black/50 bg-white">
            <label class="inline-flex items-center gap-1 font-medium text-black/70">
              <input type="checkbox" id="stockOrderCheckAll" class="order-check accent-ok" ${allChecked ? "checked" : ""} />
              전체선택
            </label>
            <span>업체 ${groups.length}곳 · 품목 ${rows.length}개</span>
            <span class="ml-auto">원재료명 · 입고단위/규격 · 현재고(부족) · 주문수량</span>
          </div>
          ${useMulti
            ? `<div class="grid grid-cols-4 gap-2 items-start">
                ${cols.map((col) => `<div>${orderGroupsColumnHtml_(col)}</div>`).join("")}
              </div>`
            : orderGroupsColumnHtml_(groups)}
        </div>`;

  const mobileList = state.stockLoading || !rows.length
    ? ""
    : `<div class="pb-16">
        <div class="sticky top-0 z-20 bg-paper-card/95 backdrop-blur-sm flex items-center gap-2 px-1 py-1.5 mb-1 border-b border-paper-line text-[12px]">
          <label class="inline-flex items-center gap-1 font-medium">
            <input type="checkbox" id="stockOrderCheckAllMobile" class="order-check accent-ok" ${allChecked ? "checked" : ""} />
            전체선택
          </label>
          <span class="text-black/45">업체 ${groups.length} · 품목 ${rows.length}</span>
          <span class="ml-auto text-[10px] text-black/35">${esc(UI_VERSION)}</span>
        </div>
        ${orderGroupsColumnHtml_(groups, "mobile")}
      </div>`;

  return `
    <section class="flex-1 min-w-0 min-h-0 flex flex-col p-3 lg:p-4 overflow-hidden">
      <div class="mb-2 shrink-0 space-y-1.5">
        ${screenTitleRowHtml_({
          title: "발주관리",
          mobileTitle: "발주",
          selectId: "orderMonthSelect",
          splitMobile: true,
          h2Class: "text-lg font-bold tracking-tight",
          mobileH2Class: "text-base font-bold tracking-tight",
          rightHtml: `업체 ${groups.length}곳 · 후보 ${rows.length}개
            <div class="text-[11px] text-black/40">화면 ${UI_VERSION}${state.apiVersion ? ` · 서버 ${esc(state.apiVersion)}` : ""}</div>`,
          rightMobileHtml: `<div class="text-[11px] text-black/45 shrink-0">업체 ${groups.length} · ${rows.length}품목</div>`
        })}
        ${pastMonthBannerHtml_()}
        ${closeNagBannerHtml_()}
        <div class="flex flex-wrap gap-1.5 items-stretch">
          <select id="orderCategory" class="compact-control min-w-[7rem] flex-1 sm:flex-none rounded-lg border border-paper-line bg-white px-2">
            ${cats.map((c) => `<option value="${esc(c)}" ${c === state.orderCategory ? "selected" : ""}>${c === "전체" ? "구분: 전체" : esc(c)}</option>`).join("")}
          </select>
          <button id="btnOrderLow" class="compact-control rounded-lg border border-paper-line bg-white px-2 text-xs shrink-0">
            ${state.orderLowOnly ? "전체 보기" : "부족만"}
          </button>
          <button id="btnOrderRefresh" class="compact-control rounded-lg border border-paper-line bg-white px-2 text-xs shrink-0">
            <i class="fa-solid fa-rotate-right"></i> 새로고침
          </button>
          <button type="button" id="btnStockOrderKakao"
            class="compact-control rounded-lg bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-bold px-3 text-xs shrink-0 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            ${isSelectedMonthLatest_() ? "" : "disabled"}
            title="${isSelectedMonthLatest_() ? "체크한 품목을 거래처별로 묶어 카톡 발주 문구를 만듭니다" : "현재 기준월에서만 발주할 수 있습니다"}">
            <i class="fa-solid fa-comment-dots mr-1"></i>발주 카톡 만들기
          </button>
          <div class="relative flex-1 min-w-[140px]">
            <i class="fa-solid fa-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-black/35 text-[10px]"></i>
            <input id="orderSearch" value="${esc(state.orderQuery)}" placeholder="업체·품목·코드"
              class="compact-control w-full rounded-lg border border-paper-line bg-white pl-7 pr-2" />
          </div>
        </div>
        ${state.stockError ? `<div class="text-sm text-red-700">${esc(state.stockError)}</div>` : ""}
      </div>
      <div id="orderScrollArea" data-scroll-keep="orderScrollArea" class="desktop-only flex-1 min-h-0 overflow-auto scroll-thin rounded-2xl border border-paper-line bg-white shadow-panel">
        ${desktopList}
      </div>
      <div id="orderMobileScroll" data-scroll-keep="orderMobileScroll" class="mobile-only flex-1 min-h-0 overflow-y-auto scroll-thin">
        ${state.stockLoading
          ? `<div class="p-6 text-sm text-black/50">불러오는 중…</div>`
          : !rows.length
            ? `<div class="p-6 text-sm text-black/50">조건에 맞는 발주 후보가 없습니다.</div>`
            : mobileList}
      </div>
    </section>`;
}

function balanceReceiptPanelHtml() {
  const r = selectedBalanceRow();
  // id=balanceReceiptPanel → 행 클릭 시 이 aside 만 replaceWith (전체 render 없음)
  if (!r) {
    return `
      <aside id="balanceReceiptPanel" class="balance-receipt-panel hidden lg:flex w-[40%] xl:w-[42%] shrink-0 border-l border-paper-line bg-paper-card flex-col min-h-0 overflow-hidden">
        <div class="px-4 pt-4 pb-2 shrink-0">
          <h3 class="font-bold text-base">영수증 / 명세서</h3>
          <p class="text-[12px] text-black/50 mt-1">왼쪽 표에서 전표를 선택하세요.</p>
        </div>
        <div class="flex-1 min-h-0 px-4 pb-4">
          <div class="receipt-frame h-full min-h-[280px] rounded-2xl border border-dashed border-paper-line grid place-items-center text-center p-4 text-sm text-black/45 bg-white">
            <div><i class="fa-regular fa-image text-3xl mb-2 block text-brand/30"></i>선택된 전표 없음</div>
          </div>
        </div>
      </aside>`;
  }
  const img = withImageVer(r.receiptUrl || r.imageUrl, r.receiptUptime || r.imageVer || "0");
  return `
    <aside id="balanceReceiptPanel" class="balance-receipt-panel hidden lg:flex w-[40%] xl:w-[42%] shrink-0 border-l border-paper-line bg-paper-card flex-col min-h-0 overflow-hidden">
      <div class="px-4 pt-4 pb-2 shrink-0 space-y-1">
        <h3 class="font-bold text-base leading-tight">영수증 / 명세서</h3>
        <p class="text-[13px] font-semibold truncate" title="${esc(r.vendor)}">${esc(r.vendor)}</p>
        <p class="text-[11px] text-black/45">${esc(formatDate(r.date))} · 명세서금액 ${esc(moneyText(r.daily))}</p>
      </div>
      <div class="flex-1 min-h-0 flex flex-col px-4 pb-4">
        ${img
          ? receiptViewerFrameHtml_(img, {
              id: "balanceReceiptPreview",
              minH: "280px",
              tip: "행 클릭 시 이 전표 표시 · 휠 확대·축소 · 드래그 이동 · 더블클릭 초기화"
            })
          : `<div class="receipt-frame flex-1 overflow-hidden rounded-2xl border border-dashed border-paper-line grid place-items-center text-center p-4 text-sm text-black/45 bg-white" style="min-height:280px">
              <div><i class="fa-regular fa-image text-3xl mb-2 block text-brand/30"></i>연결된 명세서 이미지가 없습니다</div>
            </div>`}
      </div>
    </aside>`;
}

function balanceHtml() {
  const rows = balanceVisible();
  const warns = state.warnCount || 0;
  const table = state.balanceLoading
    ? `<div class="p-6 text-sm text-black/50">불러오는 중…</div>`
    : !rows.length
      ? `<div class="p-6 text-sm text-black/50">표시할 거래가 없습니다. PC에서 「검증 계산」을 먼저 실행했는지 확인하세요.</div>`
      : `
    <div id="balanceScrollArea" class="h-full min-h-0 overflow-auto scroll-thin">
      <div class="desktop-only rounded-xl border border-paper-line bg-white shadow-panel">
        <table class="app-table balance-table min-w-full text-sm">
          <thead class="bg-[#f3f6f3] text-black/55">
            <tr>
              <th class="px-3 py-2.5 font-medium text-center sticky top-0 z-10 bg-[#f3f6f3] shadow-sm">거래처</th>
              <th class="px-3 py-2.5 font-medium text-center sticky top-0 z-10 bg-[#f3f6f3] shadow-sm">거래일</th>
              <th class="px-3 py-2.5 font-medium text-center sticky top-0 z-10 bg-[#f3f6f3] shadow-sm">명세서금액</th>
              <th class="px-3 py-2.5 font-medium text-center sticky top-0 z-10 bg-[#f3f6f3] shadow-sm">결제/조정</th>
              <th class="px-3 py-2.5 font-medium text-center sticky top-0 z-10 bg-[#f3f6f3] shadow-sm">명세서누적금액</th>
              <th class="px-3 py-2.5 font-medium text-center sticky top-0 z-10 bg-[#f3f6f3] shadow-sm">당월누적계산</th>
              <th class="px-3 py-2.5 font-medium text-center sticky top-0 z-10 bg-[#f3f6f3] shadow-sm">검증</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              const warn = r.status !== "OK";
              const on = state.balanceSelectedRow === r.row;
              return `<tr class="balance-row border-t border-paper-line cursor-pointer ${warn ? "bg-[#fdf3ef]" : ""} ${on ? "is-selected" : ""}"
                data-balance-select="${r.row}">
                <td class="px-3 py-2 font-medium">${esc(r.vendor)}</td>
                <td class="px-3 py-2 whitespace-nowrap">${esc(formatDate(r.date))}</td>
                <td class="px-3 py-2 num tabular-nums whitespace-nowrap">${esc(moneyText(r.daily))}${balanceRecoveryBadge(r.recovery)}</td>
                <td class="px-3 py-2 num">
                  <input data-pay="${r.row}" value="${r.payment == null ? "" : esc(formatMoneyInput(r.payment))}"
                    class="compact-control w-28 rounded-lg border border-paper-line bg-white px-2 text-right tabular-nums" placeholder="0" />
                </td>
                <td class="px-3 py-2 num tabular-nums">${esc(moneyText(r.month))}</td>
                <td class="px-3 py-2 num tabular-nums">${esc(moneyText(r.checkTotal))}</td>
                <td class="px-3 py-2">${balanceStatusBadge(r.status, r)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div class="mobile-only space-y-3 pb-24">
        ${rows.map((r) => {
          const warn = r.status !== "OK";
          const on = state.balanceSelectedRow === r.row;
          return `<article class="balance-card rounded-2xl border border-paper-line bg-white p-3.5 cursor-pointer ${warn ? "ring-1 ring-[#f0c56d]" : ""} ${on ? "is-selected" : ""}"
            data-balance-select="${r.row}">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="font-bold text-[15px] leading-snug">${esc(r.vendor)}</div>
                <div class="text-[13px] text-black/45 mt-0.5">${esc(formatDate(r.date))}</div>
              </div>
              ${balanceStatusBadge(r.status, r)}
            </div>
            <div class="mt-3 space-y-2 text-[13px]">
              <div class="flex justify-between gap-2"><span class="text-black/50">명세서금액</span><b class="tabular-nums">${esc(moneyText(r.daily))}</b></div>
              ${r.recovery ? `<div class="flex justify-between gap-2"><span class="text-black/50">회수</span>${balanceRecoveryBadge(r.recovery)}</div>` : ""}
              <div class="flex justify-between gap-2"><span class="text-black/50">명세서누적</span><b class="tabular-nums">${esc(moneyText(r.month))}</b></div>
              <div class="flex justify-between gap-2"><span class="text-black/50">당월누적계산</span><b class="tabular-nums">${esc(moneyText(r.checkTotal))}</b></div>
              <label class="flex items-center justify-between gap-3 pt-2 border-t border-paper-line" data-balance-stop>
                <span class="text-black/55 shrink-0 font-medium">결제/조정</span>
                <input data-pay="${r.row}" value="${r.payment == null ? "" : esc(String(r.payment))}"
                  class="compact-control w-[9rem] rounded-lg border border-paper-line px-2 text-right text-[15px] font-semibold tabular-nums" placeholder="0" />
              </label>
            </div>
          </article>`;
        }).join("")}
      </div>
    </div>`;

  return `
    <section class="flex-1 min-w-0 min-h-0 flex overflow-hidden">
      <div class="flex-1 min-w-0 min-h-0 flex flex-col p-2 sm:p-3 lg:p-3 lg:pr-2 overflow-hidden">
        <div class="mb-2 space-y-2 shrink-0">
          ${screenTitleRowHtml_({
            title: "거래처 금액 검증",
            selectId: "balanceMonthSelect",
            rightHtml: `이상 ${warns}건 · 전체 ${state.balanceRows.length}건
              <div class="text-[11px] text-black/40">화면 ${UI_VERSION}${state.apiVersion ? ` · 서버 ${esc(state.apiVersion)}` : ""}</div>`
          })}
          ${pastMonthBannerHtml_()}
          <div class="flex flex-wrap gap-1.5">
            <button id="btnBalanceFilter" class="compact-control rounded-lg border border-paper-line bg-white px-3 text-xs">
              ${state.balanceWarnOnly ? "전체 보기" : "이상만"}
            </button>
            <button id="btnBalanceRebuild" class="compact-control rounded-lg bg-brand text-white px-3 text-xs font-bold" ${state.jobBusy ? "disabled" : ""}>
              검증 계산
            </button>
            ${balanceRebuildAtHtml_()}
            <button id="btnBalanceRefresh" class="compact-control rounded-lg border border-paper-line bg-white px-3 text-xs">
              <i class="fa-solid fa-rotate-right"></i> 새로고침
            </button>
            <div class="flex flex-1 min-w-[140px]">
              <input id="balanceSearch" value="${esc(state.balanceSearchText)}" placeholder="거래처 검색 (Enter)"
                class="compact-control w-full rounded-l-lg border border-paper-line bg-white px-2 focus:outline-none focus:ring-2 focus:ring-brand/25" />
              <button type="button" id="btnBalanceSearch" class="compact-control rounded-r-lg border border-l-0 border-paper-line bg-white px-2.5" title="검색">
                <i class="fa-solid fa-magnifying-glass text-[11px] text-black/45"></i>
              </button>
            </div>
          </div>
          <p class="text-[11px] text-black/45 desktop-only">불일치 시 결제/조정에 뱃지 차액(명세서누적−당월누적계산, 부호 포함)을 넣고 저장 → 검증 계산하면 OK. 결제/조정은 검증 계산 후에도 유지됩니다. 회수 뱃지=보증금(V).</p>
          <p class="text-[13px] text-black/50 mobile-only leading-snug">불일치 시 <b>결제/조정</b>에 차액 입력 → 저장 → 검증 계산.</p>
          ${state.balanceError ? `<div class="text-sm text-red-700">${esc(state.balanceError)}</div>` : ""}
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">${table}</div>
      </div>
      ${balanceReceiptPanelHtml()}
    </section>`;
}

function renderApp() {
  ensureSelection();
  const rows = visibleRows();
  const inspectMain = `
    <section class="flex-1 min-w-0 min-h-0 flex flex-col p-2 sm:p-3 lg:p-3 lg:pr-2 overflow-hidden">
      ${toolbarHtml()}
      ${state.error ? `<div class="mb-2 text-sm text-red-700">${esc(state.error)}</div>` : ""}
      <div id="mainScrollArea" class="flex-1 min-h-0 overflow-y-auto scroll-thin">
        ${tableHtml(rows)}
        ${cardsHtml(rows)}
      </div>
    </section>`;

  let main = inspectMain;
  if (state.menu === "balance") main = balanceHtml();
  if (state.menu === "price") main = priceHtml();
  if (state.menu === "stock") main = stockHtml();
  if (state.menu === "order") main = orderHtml();
  if (state.menu === "pos") {
    if (window.PosSales && typeof window.PosSales.html === "function") main = window.PosSales.html();
    else main = `<section class="flex-1 p-6 text-sm text-red-700">POS 판매내역 모듈(AppJs_PosSales)이 로드되지 않았습니다.</section>`;
  }
  if (state.unregOpen) main = unregHtml();

  // 미등록·금액검증·POS·재고·발주는 화면 내부 전체폭 사용 → 바깥 aside 생략
  const asideHtml = state.unregOpen || state.menu === "balance" || state.menu === "pos" || state.menu === "price" || state.menu === "stock" || state.menu === "order"
    ? ""
    : (state.menu === "inspect"
      ? detailHtml()
      : `<aside class="desktop-only w-[calc(42%-2.5rem)] xl:w-[calc(45%-2.5rem)] shrink-0 border-l border-paper-line bg-paper-card"></aside>`);

  // render() 직전: 모든 화면 스크롤 위치 저장
  captureViewScroll_();
  // 등록구분 변경 등 전체 render 시에도 영수증 확대 상태 유지
  const keptReceipt = detachUnregReceiptPanelIfSame_();

  root.innerHTML = `
    <div class="h-full flex flex-col lg:flex-row min-h-0">
      ${sidebarHtml()}
      <div class="flex-1 min-w-0 min-h-0 flex flex-col">
        ${mobileHeaderHtml()}
        <div class="flex-1 min-h-0 flex">
          ${main}
          ${asideHtml}
        </div>
        ${mobileTabsHtml()}
      </div>
      ${state.toast ? `<div class="fixed left-1/2 -translate-x-1/2 bottom-24 lg:bottom-8 z-50 bg-brand text-white text-sm px-4 py-2.5 rounded-full shadow-lg">${esc(state.toast)}</div>` : ""}
      ${ocrModalHtml()}
      ${stockOrderKakaoModalHtml()}
    </div>`;
  if (!reattachUnregReceiptPanel_(keptReceipt)) {
    bindPanelReceiptViewers_();
  }
  bindUnregParentPickers_();
  bindAppEvents();
  if (state.menu === "pos" && window.PosSales && typeof window.PosSales.bind === "function") {
    window.PosSales.bind();
  }
  // DOM 재생성 직후 스크롤·포커스 복원 (rAF + timeout 으로 레이아웃 확정 보장)
  restoreViewScroll_();
}

/** 스크롤 복원 대상 id (모든 화면 공통 기본) */
const SCROLL_RESTORE_IDS_ = [
  "mainScrollArea",
  "balanceScrollArea",
  "unregScrollArea",
  "stockScrollArea",
  "stockMobileScroll",
  "orderScrollArea",
  "orderMobileScroll",
  "priceListScroll",
  "posScrollArea",
  "posTableScroll"
];

function markFocusRestore_(spec) {
  state.focusRestore = spec || null;
}

function captureViewScroll_() {
  if (!state.scrollRestoreMap) state.scrollRestoreMap = {};
  const busy =
    !!state.stockLoading ||
    !!state.balanceLoading ||
    !!state.loading ||
    !!state.stockCalcBusy ||
    !!state.priceLoading ||
    !!state.posLoading;
  SCROLL_RESTORE_IDS_.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    // 로딩 중 빈 화면(scrollTop=0)으로 이전 위치를 덮어쓰지 않음
    if (busy && el.scrollTop === 0 && (state.scrollRestoreMap[id] || 0) > 0) return;
    state.scrollRestoreMap[id] = el.scrollTop;
  });
  document.querySelectorAll("[data-scroll-keep]").forEach((el) => {
    const key = el.id || el.getAttribute("data-scroll-keep");
    if (!key) return;
    if (busy && el.scrollTop === 0 && (state.scrollRestoreMap[key] || 0) > 0) return;
    state.scrollRestoreMap[key] = el.scrollTop;
  });
  // 호환 필드 동기화
  if (state.scrollRestoreMap.mainScrollArea != null) state.lastScrollTop = state.scrollRestoreMap.mainScrollArea;
  if (state.scrollRestoreMap.balanceScrollArea != null) state.balanceScrollTop = state.scrollRestoreMap.balanceScrollArea;
  if (state.scrollRestoreMap.unregScrollArea != null) state.unregScrollTop = state.scrollRestoreMap.unregScrollArea;
  if (state.scrollRestoreMap.priceListScroll != null) state.priceListScrollTop = state.scrollRestoreMap.priceListScroll;
}

function findFocusRestoreEl_(spec) {
  if (!spec) return null;
  if (spec.selector) return document.querySelector(spec.selector);
  if (spec.type === "stock") {
    const kind = String(spec.kind || "safety").replace(/"/g, "");
    return document.querySelector(
      `input[data-stock="${spec.row}"][data-kind="${kind}"]`
    ) || document.querySelector(`input[data-stock="${spec.row}"]`);
  }
  if (spec.type === "pay") {
    return document.querySelector(`input[data-pay="${spec.row}"]`);
  }
  return null;
}

function restoreViewScroll_() {
  const map = state.scrollRestoreMap || {};
  const focusSpec = state.focusRestore;
  state.focusRestore = null;
  const applyScroll = () => {
    Object.keys(map).forEach((id) => {
      const top = Number(map[id]) || 0;
      if (top <= 0) return;
      const el = document.getElementById(id) || document.querySelector(`[data-scroll-keep="${id}"]`);
      if (el) el.scrollTop = top;
    });
  };
  const applyFocus = () => {
    const input = findFocusRestoreEl_(focusSpec);
    if (!input) return;
    try {
      input.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    } catch (e0) {
      try { input.scrollIntoView(true); } catch (e1) {}
    }
    try {
      input.focus({ preventScroll: true });
    } catch (e2) {
      try { input.focus(); } catch (e3) {}
    }
  };
  const apply = () => {
    applyScroll();
    if (focusSpec) applyFocus();
  };
  const hasScroll = Object.keys(map).some((id) => (Number(map[id]) || 0) > 0);
  if (!hasScroll && !focusSpec) return;
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
  setTimeout(apply, 0);
  setTimeout(apply, 50);
}

/** @deprecated 호환 — captureViewScroll_ 사용 */
function captureMainScroll_() {
  captureViewScroll_();
}

/** @deprecated 호환 — restoreViewScroll_ 사용 */
function restoreMainScroll_() {
  restoreViewScroll_();
}

function bindAppEvents() {
  bindMonthSelect_("inspectMonthSelect");
  bindMonthSelect_("stockMonthSelect");
  bindMonthSelect_("orderMonthSelect");
  bindMonthSelect_("balanceMonthSelect");
  bindMonthSelect_("priceMonthSelect");
  bindMonthSelect_("posMonthSelect");
  document.getElementById("stockUsageDay")?.addEventListener("change", async (e) => {
    const next = clampStockUsageDay_((e.target && e.target.value) || "", state.selectedMonth);
    if (next === state.stockUsageDay) return;
    state.stockUsageDay = next;
    await loadStock();
  });

  document.querySelectorAll("[data-menu]").forEach((btn) => {
    btn.onclick = () => {
      state.menu = btn.getAttribute("data-menu");
      state.unregOpen = false;
      if (!state.ocrBusy) state.ocrOpen = false;
      render();
      if (state.menu === "balance") loadBalance();
      if (state.menu === "price") loadPrices();
      if (state.menu === "stock" || state.menu === "order") loadStock();
      if (state.menu === "pos" && window.PosSales) {
        if (state.selectedMonth) applyPosRangeForMonth_(state.selectedMonth);
        window.PosSales.load();
      }
    };
  });

  document.querySelectorAll("[data-job]").forEach((btn) => {
    btn.onclick = () => {
      const card = allActionCards_().find((c) => c.id === btn.getAttribute("data-job"));
      if (card) runJobAction(card);
    };
  });
  document.getElementById("btnUnregClose")?.addEventListener("click", () => {
    state.unregOpen = false;
    state.unregSelectedKey = null;
    render();
  });
  document.getElementById("unregFilter")?.addEventListener("change", (e) => {
    collectUnregDraftsFromDom();
    state.unregFilter = (e.target && e.target.value) || "전체";
    const visible = unregVisibleGroups();
    if (!visible.some((g) => g.key === state.unregSelectedKey)) {
      selectFirstUnregItem_(); // 필터 변경 시에도 보이는 1행 + 우측 뷰어 동기화
    }
    render();
  });
  document.getElementById("btnUnregReflectQty")?.addEventListener("click", () => {
    runJobAction({
      id: "qty",
      title: "원재료입고반영",
      kind: "web",
      action: "jobUpdateReceiptQuantities",
      confirm: null
    });
  });
  document.getElementById("btnUnregBatchSave")?.addEventListener("click", () => submitUnregisteredBatch());
  document.getElementById("unregCheckAll")?.addEventListener("change", (e) => {
    collectUnregDraftsFromDom();
    const on = !!(e.target && e.target.checked);
    unregVisibleGroups().forEach((g) => {
      const d = ensureUnregDraft(g);
      d.checked = on;
    });
    render();
  });
  document.querySelectorAll("[data-unreg-select]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest(".unreg-stop")) return;
      const key = card.getAttribute("data-unreg-select");
      if (key) selectUnregItem_(key);
    });
  });
  document.querySelectorAll("[data-unreg-check]").forEach((box) => {
    box.addEventListener("change", () => {
      collectUnregDraftsFromDom();
      render();
    });
  });
  document.querySelectorAll("[data-unreg-status]").forEach((sel) => {
    sel.addEventListener("change", () => {
      collectUnregDraftsFromDom();
      const row = sel.closest("[data-unreg-row]");
      const key = row && row.getAttribute("data-unreg-row");
      const d = key && state.unregDrafts[key];
      const g = key && (state.unregGroups || []).find((x) => x.key === key);
      if (d) {
        const prevSt = g
          ? normalizeUnregStatusFront_(g.regStatus, !!(g.code || "").trim())
          : "";
        d.regStatus = normalizeUnregStatusFront_(d.regStatus, !!(d.code || "").trim());
        // 시트 규칙: 대표·별칭·등록제외는 미등록으로만 변경 가능
        if ((prevSt === "대표" || prevSt === "별칭" || prevSt === "등록제외")
            && d.regStatus !== "미등록" && d.regStatus !== prevSt) {
          toast("등록구분 변경은 미등록을 거쳐야 합니다.");
          d.regStatus = prevSt;
          sel.value = prevSt;
          render();
          return;
        }
        if (d.regStatus === "별칭") {
          d.mode = "link";
        } else if (d.regStatus === "대표" && (d.code || "").trim()) {
          d.mode = "update";
          d.parentCode = "";
        } else if (d.regStatus === "미등록" || d.regStatus === "등록제외") {
          d.mode = "create";
          d.parentCode = "";
        } else {
          d.parentCode = "";
        }
      }
      render();
    });
  });
  document.querySelectorAll("[data-unreg-category]").forEach((sel) => {
    sel.addEventListener("change", () => {
      collectUnregDraftsFromDom();
      const row = sel.closest("[data-unreg-row]");
      const key = row && row.getAttribute("data-unreg-row");
      if (key && state.unregDrafts[key]) state.unregDrafts[key].code = "";
      render();
    });
  });

  const cameraInput = document.getElementById("receiptInputCamera");
  const galleryInput = document.getElementById("receiptInputGallery");
  document.getElementById("btnOcrCamera")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.ocrBusy) cameraInput?.click();
  });
  document.getElementById("btnOcrGallery")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.ocrBusy) galleryInput?.click();
  });
  document.getElementById("btnOcrClose")?.addEventListener("click", closeOcrModal);
  document.getElementById("btnOcrRun")?.addEventListener("click", startOcrAnalyze);
  document.getElementById("ocrBackdrop")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "ocrBackdrop") closeOcrModal();
  });
  document.getElementById("ocrPanel")?.addEventListener("click", (e) => e.stopPropagation());
  const bindFileInput = (el) => {
    el?.addEventListener("change", async () => {
      await addOcrFiles(el.files);
      el.value = "";
    });
  };
  bindFileInput(cameraInput);
  bindFileInput(galleryInput);

  const drop = document.getElementById("ocrDrop");
  if (drop) {
    ["dragenter", "dragover"].forEach((ev) => {
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add("bg-[#f0f7f0]");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove("bg-[#f0f7f0]");
      });
    });
    drop.addEventListener("drop", (e) => {
      if (state.ocrBusy) return;
      addOcrFiles(e.dataTransfer && e.dataTransfer.files);
    });
  }
  document.querySelectorAll("[data-ocr-del]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.ocrBusy) return;
      removeOcrItem(btn.getAttribute("data-ocr-del"));
    };
  });
  document.getElementById("btnBalanceRebuild")?.addEventListener("click", async () => {
    await runJobAction({
      id: "balance",
      title: "거래처 금액 검증",
      kind: "web",
      action: "jobRebuildVendorBalances",
      after: "balance",
    });
    await loadBalance();
  });

  document.querySelectorAll("[data-price-months]").forEach((btn) => {
    btn.onclick = () => {
      // 검색창에 보이는 값과 필터 동기화 (지운 뒤 기간만 바꿔도 반영)
      syncPriceQueryFromInput_();
      state.priceMonths = Number(btn.getAttribute("data-price-months"));
      loadPrices();
    };
  });
  document.querySelectorAll("[data-price-key]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      selectPriceItem_(btn.getAttribute("data-price-key"));
    };
  });
  if (state.menu === "price") {
    const listEl = document.getElementById("priceListScroll");
    if (listEl && state.priceListScrollTop) listEl.scrollTop = state.priceListScrollTop;
    bindPriceChartTip_();
  }
  const priceCat = document.getElementById("priceCategory");
  if (priceCat) {
    priceCat.onchange = () => {
      syncPriceQueryFromInput_();
      state.priceCategory = priceCat.value;
      const visible = priceVisible();
      if (!visible.some((r) => r.key === state.priceSelectedKey)) {
        state.priceSelectedKey = visible[0] ? visible[0].key : null;
      }
      render();
    };
  }
  document.getElementById("btnPriceRefresh")?.addEventListener("click", () => {
    syncPriceQueryFromInput_();
    loadPrices();
  });
  const priceSearch = document.getElementById("priceSearch");
  if (priceSearch) {
    priceSearch.oninput = () => {
      state.priceSearchText = priceSearch.value;
      // 검색어를 전부 지우면 Enter 없이도 전체(구분 필터만)로 복귀
      if (!String(priceSearch.value || "").trim() && state.priceQuery) {
        state.priceQuery = "";
        const visible = priceVisible();
        if (!visible.some((r) => r.key === state.priceSelectedKey)) {
          state.priceSelectedKey = visible[0] ? visible[0].key : null;
        }
        render();
      }
    };
    priceSearch.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyPriceSearch();
      }
    };
  }
  document.getElementById("btnPriceSearch")?.addEventListener("click", () => applyPriceSearch());

  const stockCat = document.getElementById("stockCategory");
  if (stockCat) {
    stockCat.onchange = () => {
      state.stockCategory = stockCat.value;
      render();
    };
  }
  document.getElementById("btnStockLow")?.addEventListener("click", () => {
    state.stockLowOnly = !state.stockLowOnly;
    render();
  });
  document.getElementById("btnStockAdjustMode")?.addEventListener("click", () => {
    state.stockAdjustMode = !state.stockAdjustMode;
    render();
  });
  document.getElementById("btnStockCalculate")?.addEventListener("click", () => runStockCalculate_());
  document.getElementById("btnStockRefresh")?.addEventListener("click", () => loadStock());

  const orderCat = document.getElementById("orderCategory");
  if (orderCat) {
    orderCat.onchange = () => {
      state.orderCategory = orderCat.value;
      render();
    };
  }
  document.getElementById("btnOrderLow")?.addEventListener("click", () => {
    state.orderLowOnly = !state.orderLowOnly;
    render();
  });
  document.getElementById("btnOrderRefresh")?.addEventListener("click", () => loadStock());
  const orderSearch = document.getElementById("orderSearch");
  if (orderSearch) {
    orderSearch.oninput = () => {
      state.orderQuery = orderSearch.value;
      clearTimeout(bindAppEvents._oq);
      bindAppEvents._oq = setTimeout(render, 120);
    };
  }

  document.getElementById("btnStockOrderKakao")?.addEventListener("click", () => openStockOrderKakaoModal_());
  document.getElementById("btnStockOrderKakaoCopy")?.addEventListener("click", () => {
    if (!state.stockOrderSaveBusy) copyStockOrderKakaoText_();
  });
  document.getElementById("btnStockOrderKakaoConfirm")?.addEventListener("click", () => {
    confirmSaveStockOrderList_();
  });
  document.querySelectorAll("input[data-pending-adjust]").forEach((box) => {
    box.addEventListener("change", () => {
      const sheetRow = box.getAttribute("data-pending-adjust");
      const d = pendingOrderDraft_(sheetRow);
      d.adjust = !!box.checked;
      if (!d.adjust) d.memo = d.memo || "";
      render();
    });
  });
  document.querySelectorAll("input[data-pending-memo]").forEach((input) => {
    input.addEventListener("input", () => {
      const sheetRow = input.getAttribute("data-pending-memo");
      const d = pendingOrderDraft_(sheetRow);
      d.memo = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const sheetRow = input.getAttribute("data-pending-memo");
        if (sheetRow) savePendingOrderAdjust_(sheetRow);
      }
    });
  });
  document.querySelectorAll("button[data-pending-save]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sheetRow = btn.getAttribute("data-pending-save");
      if (sheetRow) savePendingOrderAdjust_(sheetRow);
    });
  });
  document.getElementById("btnStockOrderKakaoClose")?.addEventListener("click", () => closeStockOrderKakaoModal_());
  document.getElementById("btnStockOrderKakaoCloseTop")?.addEventListener("click", () => closeStockOrderKakaoModal_());
  document.getElementById("stockOrderKakaoBackdrop")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "stockOrderKakaoBackdrop" && !state.stockOrderSaveBusy) {
      closeStockOrderKakaoModal_();
    }
  });
  document.getElementById("stockOrderKakaoPanel")?.addEventListener("click", (e) => e.stopPropagation());
  const stockSearch = document.getElementById("stockSearch");
  if (stockSearch) {
    stockSearch.oninput = () => {
      state.stockQuery = stockSearch.value;
      clearTimeout(bindAppEvents._sq);
      bindAppEvents._sq = setTimeout(render, 120);
    };
  }
  document.querySelectorAll("input[data-stock]").forEach((input) => {
    const commit = () => {
      const row = Number(input.getAttribute("data-stock"));
      const code = input.getAttribute("data-code") || "";
      const kind = input.getAttribute("data-kind");
      const current = state.stockRows.find((r) => r.row === row);
      if (!current) return;
      const prev = kind === "safety"
        ? (current.safety == null ? "" : String(current.safety))
        : kind === "adjustmentIn"
          ? String(current.adjustmentIn ?? 0)
          : String(current.adjustment ?? 0);
      if (String(input.value).trim() === prev) return;
      saveStockField(row, code, kind, input.value);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
  });

  const toggleAllOrderChecks_ = (on) => {
    orderVisible().forEach((r) => {
      ensureStockOrderDraft_(r).checked = on;
    });
    render();
  };
  document.getElementById("stockOrderCheckAll")?.addEventListener("change", (e) => {
    toggleAllOrderChecks_(!!(e.target && e.target.checked));
  });
  document.getElementById("stockOrderCheckAllMobile")?.addEventListener("change", (e) => {
    toggleAllOrderChecks_(!!(e.target && e.target.checked));
  });
  document.querySelectorAll("input[data-order-vendor-group-check]").forEach((box) => {
    box.addEventListener("change", () => {
      const vendorKey = box.getAttribute("data-order-vendor-group-check") || "";
      const on = !!box.checked;
      const g = orderVendorGroups_(orderVisible()).find((x) => x.key === vendorKey);
      if (!g) return;
      g.items.forEach((r) => {
        ensureStockOrderDraft_(r).checked = on;
      });
      render();
    });
  });
  document.querySelectorAll("button[data-order-vendor-change]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const vendorKey = btn.getAttribute("data-order-vendor-change") || "";
      state.orderVendorEditKey = state.orderVendorEditKey === vendorKey ? "" : vendorKey;
      render();
    });
  });
  document.querySelectorAll("button[data-order-vendor-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.orderVendorEditKey = "";
      render();
    });
  });
  document.querySelectorAll("select[data-order-vendor-pick]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const root = sel.closest("[data-order-vendor-group]");
      const input = root && root.querySelector("input[data-order-vendor-custom-name]");
      if (!input) return;
      if (sel.value === "__custom__") {
        input.focus();
        return;
      }
      input.value = sel.value || "";
    });
  });
  document.querySelectorAll("button[data-order-vendor-apply]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const vendorKey = btn.getAttribute("data-order-vendor-apply") || "";
      const root = btn.closest("[data-order-vendor-group]");
      const input = root && root.querySelector("input[data-order-vendor-custom-name]");
      const sel = root && root.querySelector("select[data-order-vendor-pick]");
      let name = input ? String(input.value || "").trim() : "";
      if (!name && sel && sel.value && sel.value !== "__custom__") name = sel.value;
      applyOrderVendorChange_(vendorKey, name);
    });
  });
  document.querySelectorAll("input[data-stock-order-check]").forEach((box) => {
    box.addEventListener("change", () => {
      const key = box.getAttribute("data-stock-order-check") || "";
      if (!key) return;
      if (!state.stockOrderDrafts[key]) state.stockOrderDrafts[key] = { checked: false, orderQty: "", orderQtyEdited: false };
      state.stockOrderDrafts[key].checked = !!box.checked;
      render();
    });
  });
  document.querySelectorAll("input[data-stock-order-qty]").forEach((input) => {
    const commit = () => {
      const key = input.getAttribute("data-stock-order-qty") || "";
      if (!key) return;
      if (!state.stockOrderDrafts[key]) state.stockOrderDrafts[key] = { checked: false, orderQty: "", orderQtyEdited: false };
      state.stockOrderDrafts[key].orderQty = String(input.value ?? "");
      state.stockOrderDrafts[key].orderQtyEdited = true;
    };
    input.addEventListener("input", commit);
    input.addEventListener("change", commit);
  });
  document.querySelectorAll("select[data-stock-order-vendor-mode]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const key = sel.getAttribute("data-stock-order-vendor-mode") || "";
      if (!key) return;
      const row = (state.stockRows || []).find((r) => stockOrderKey_(r) === key);
      const d = row ? ensureStockOrderDraft_(row) : null;
      if (!d) return;
      d.vendorMode = sel.value || "v1";
      document.querySelectorAll("input[data-stock-order-vendor-custom]").forEach((custom) => {
        if (custom.getAttribute("data-stock-order-vendor-custom") !== key) return;
        if (d.vendorMode === "custom") custom.classList.remove("hidden");
        else custom.classList.add("hidden");
      });
    });
  });
  document.querySelectorAll("input[data-stock-order-vendor-custom]").forEach((input) => {
    const commit = () => {
      const key = input.getAttribute("data-stock-order-vendor-custom") || "";
      if (!key) return;
      const row = (state.stockRows || []).find((r) => stockOrderKey_(r) === key);
      const d = row ? ensureStockOrderDraft_(row) : null;
      if (!d) return;
      d.vendorCustom = String(input.value ?? "");
    };
    input.addEventListener("input", commit);
    input.addEventListener("change", commit);
  });
  document.querySelectorAll("select[data-order-modal-delivery]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const idx = Number(sel.getAttribute("data-order-modal-delivery"));
      const it = state.stockOrderModalItems && state.stockOrderModalItems[idx];
      if (!it) return;
      it.deliveryMethod = normalizeDeliveryMethodFront_(sel.value);
      it.expectedDate = defaultExpectedDateFront_(it.deliveryMethod);
      const dateInput = document.querySelector(
        'input[data-order-modal-expected="' + idx + '"]'
      );
      if (dateInput) dateInput.value = it.expectedDate;
      if (it.orderKey && state.stockOrderDrafts[it.orderKey]) {
        const d = state.stockOrderDrafts[it.orderKey];
        d.deliveryMethod = it.deliveryMethod;
        d.expectedDate = it.expectedDate;
        d.expectedEdited = false;
      }
      refreshStockOrderModalFromItems_();
      const ta = document.getElementById("stockOrderKakaoText");
      if (ta) ta.value = state.stockOrderModalText || "";
    });
  });
  document.querySelectorAll("input[data-order-modal-expected]").forEach((input) => {
    input.addEventListener("change", () => {
      const idx = Number(input.getAttribute("data-order-modal-expected"));
      const it = state.stockOrderModalItems && state.stockOrderModalItems[idx];
      if (!it) return;
      const v = String(input.value || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      it.expectedDate = v;
      if (it.orderKey && state.stockOrderDrafts[it.orderKey]) {
        const d = state.stockOrderDrafts[it.orderKey];
        d.expectedDate = v;
        d.expectedEdited = true;
      }
      refreshStockOrderModalFromItems_();
      const ta = document.getElementById("stockOrderKakaoText");
      if (ta) ta.value = state.stockOrderModalText || "";
    });
  });

  document.getElementById("btnBalanceFilter")?.addEventListener("click", () => {
    state.balanceWarnOnly = !state.balanceWarnOnly;
    render();
  });
  document.getElementById("btnBalanceRefresh")?.addEventListener("click", () => loadBalance());
  const balanceSearch = document.getElementById("balanceSearch");
  if (balanceSearch) {
    balanceSearch.oninput = () => {
      state.balanceSearchText = balanceSearch.value;
    };
    balanceSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyBalanceSearch();
      }
    });
  }
  document.getElementById("btnBalanceSearch")?.addEventListener("click", () => applyBalanceSearch());
  document.querySelectorAll("[data-balance-select]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target && e.target.closest && (e.target.closest("input[data-pay]") || e.target.closest("[data-balance-stop]"))) return;
      const row = Number(el.getAttribute("data-balance-select"));
      if (row) selectBalanceRow_(row);
    });
  });
  document.querySelectorAll("input[data-pay]").forEach((input) => {
    const commit = () => {
      const row = Number(input.getAttribute("data-pay"));
      const current = state.balanceRows.find((r) => r.row === row);
      const prev = current && current.payment != null ? String(current.payment) : "";
      if (String(input.value).trim() === prev) return;
      savePayment(row, input.value);
    };
    input.addEventListener("focus", () => {
      const row = Number(input.getAttribute("data-pay"));
      if (row) selectBalanceRow_(row, { focusPay: true });
    });
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
  });

  const dateEl = document.getElementById("filterDate");
  if (dateEl) {
    dateEl.onchange = () => {
      state.filterDate = dateEl.value;
      ensureSelection();
      render();
    };
  }
  const vendorEl = document.getElementById("filterVendor");
  if (vendorEl) {
    vendorEl.onchange = () => {
      state.filterVendor = vendorEl.value;
      ensureSelection();
      render();
    };
  }
  const inspectEl = document.getElementById("filterInspect");
  if (inspectEl) {
    inspectEl.onchange = () => {
      state.filterInspect = inspectEl.value === "all" ? "all" : "pending";
      ensureSelection();
      render();
    };
  }

  const search = document.getElementById("searchInput");
  if (search) {
    // 타이핑만 하고 화면은 다시 그리지 않음 (깜빡임 방지)
    // 단, 검색어를 전부 지우면 Enter 없이도 query 클리어 → 날짜·거래처 콤보만 적용
    search.oninput = () => {
      state.searchText = search.value;
      if (!String(search.value || "").trim() && state.query) {
        state.query = "";
        ensureSelection();
        render();
      }
    };
    search.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applySearch();
      }
    };
  }
  document.getElementById("btnSearch")?.addEventListener("click", () => applySearch());

  document.getElementById("btnOcrOpen")?.addEventListener("click", () => openOcrModal());
  document.getElementById("mobileOcrOpen")?.addEventListener("click", () => openOcrModal());
  document.getElementById("btnToggleFilters")?.addEventListener("click", () => {
    state.mobileFiltersOpen = !state.mobileFiltersOpen;
    render();
  });
  document.getElementById("btnRefresh")?.addEventListener("click", () => loadInspection());
  document.getElementById("mobileRefresh")?.addEventListener("click", () => loadInspection());
  document.getElementById("btnApply")?.addEventListener("click", () => applyDraft());
  document.getElementById("mobileApply")?.addEventListener("click", () => applyDraft());

  document.querySelectorAll("tr[data-row]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest("input, button, label, a")) return;
      state.selectedId = Number(tr.getAttribute("data-row"));
      render();
    };
  });

  document.querySelectorAll("[data-select-row]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.selectedId = Number(btn.getAttribute("data-select-row"));
      render();
    };
  });

  document.querySelectorAll("input[data-check]").forEach((box) => {
    box.onchange = (e) => {
      e.stopPropagation();
      setDraft(Number(box.getAttribute("data-check")), box.checked);
    };
    box.onclick = (e) => e.stopPropagation();
  });

  document.querySelectorAll("input[data-slip-check]").forEach((box) => {
    box.onchange = (e) => {
      e.stopPropagation();
      setSlipDraft(box.getAttribute("data-slip-check"), box.checked);
    };
    box.onclick = (e) => e.stopPropagation();
  });

  // 전표 단위: 입력 시 저장 버튼 활성화, 헤더 저장으로 일괄 반영
  const editSel =
    "input[data-edit-name], input[data-edit-receipt-name], input[data-edit-spec], input[data-edit-qty], input[data-edit-final], input[data-edit-unit], input[data-edit-line], input[data-edit-daily], input[data-edit-month], input[data-edit-trade-date], select[data-edit-vendor]";
  document.querySelectorAll(editSel).forEach((input) => {
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("input", () => refreshSlipSaveButtons_());
    input.addEventListener("change", () => refreshSlipSaveButtons_());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const slip =
          input.getAttribute("data-edit-daily") ||
          input.getAttribute("data-edit-month") ||
          input.getAttribute("data-edit-trade-date") ||
          input.getAttribute("data-edit-vendor") ||
          (input.closest("[data-slip-of]") && input.closest("[data-slip-of]").getAttribute("data-slip-of")) ||
          (input.closest("[data-slip-block]") && input.closest("[data-slip-block]").getAttribute("data-slip-block"));
        if (!slip) return;
        const btn = document.querySelector("button[" + slipAttrSel_("data-save-slip", slip) + "]");
        if (btn && !btn.disabled) btn.click();
      }
    });
  });
  document.querySelectorAll("[data-save-slip]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      saveInspectSlip(btn.getAttribute("data-save-slip"));
    };
  });
  document.querySelectorAll("[data-delete-slip]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteInspectSlipItems(btn.getAttribute("data-delete-slip"));
    };
  });
  refreshSlipSaveButtons_();
}

function render() {
  if (!state.pin) renderPin();
  else renderApp();
}

(async function boot() {
  try {
    if (SKIP_LOGIN) {
      state.pin = DEV_PIN;
      try {
        sessionStorage.setItem("stockPin", DEV_PIN);
      } catch (e0) {}
    }
    render();
    if (state.pin) await loadInspection();
  } catch (err) {
    const r = document.getElementById("root");
    if (r) {
      r.innerHTML =
        '<div style="padding:28px;font-family:Malgun Gothic,sans-serif;color:#b00020">' +
        "<b>시작 오류</b><br/>" +
        String((err && err.message) || err) +
        "</div>";
    }
  }
})();

