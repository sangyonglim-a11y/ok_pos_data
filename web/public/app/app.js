/* =========================================================
   중계고기파티 재고 SPA
   - API URL 만 바꾸면 Apps Script / 로컬 목업 전환
   ========================================================= */

const API_URL = ""; // 예: "https://script.google.com/macros/s/XXXX/exec"
const USE_MOCK_WHEN_EMPTY = true;

const MENUS = [
  { id: "inspect", label: "실물 검수", icon: "fa-clipboard-check", badge: "count" },
  { id: "balance", label: "거래처 금액 검증", icon: "fa-scale-balanced", badge: "warn" },
  { id: "price", label: "단가 추이", icon: "fa-chart-line", badge: null },
  { id: "stock", label: "재고 및 발주 관리", icon: "fa-boxes-stacked", badge: null },
];

const state = {
  pin: sessionStorage.getItem("stockPin") || "",
  menu: "inspect",
  query: "",
  month: "",
  rows: [],
  selectedId: null,
  loading: false,
  error: "",
  toast: "",
  pendingOnly: true,
};

const root = document.getElementById("root");

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

async function api(action, payload = {}) {
  if (!API_URL) {
    if (!USE_MOCK_WHEN_EMPTY) throw new Error("API_URL 을 설정해 주세요.");
    return mockApi(action, payload);
  }

  const body = { action, pin: state.pin, ...payload };
  const res = await fetch(API_URL, {
    method: "POST",
    // Apps Script CORS 단순화: text/plain 으로 preflight 회피
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
      { row: 12, date: "2026-10-28", vendor: "(주)회승", name: "이베리코 목살", spec: "1 Box / 11.96kg", qty: "1", code: "M0015", final: "11.96", checked: false, biz: "123-45-67890", amount: "233220", imageUrl: "" },
      { row: 13, date: "2026-10-28", vendor: "(주)회승", name: "삼겹살", spec: "1 Box / 9.40kg", qty: "1", code: "M0012", final: "9.40", checked: false, biz: "123-45-67890", amount: "168000", imageUrl: "" },
      { row: 18, date: "2026-10-29", vendor: "신선농산", name: "양파", spec: "망 / 20kg", qty: "2", code: "V003", final: "40", checked: true, biz: "211-88-12345", amount: "48000", imageUrl: "" },
      { row: 21, date: "2026-10-30", vendor: "백두주류", name: "하이볼 베이스", spec: "1.5L × 6", qty: "3", code: "D010", final: "18", checked: false, biz: "101-81-99999", amount: "96000", imageUrl: "" },
      { row: 25, date: "2026-10-31", vendor: "대한공산", name: "위생장갑", spec: "100매", qty: "10", code: "G002", final: "10", checked: false, biz: "312-86-55555", amount: "35000", imageUrl: "" },
    ];
    // 배지용 더미 20건처럼 보이게 복제
    while (mockApi._rows.length < 20) {
      const base = mockApi._rows[mockApi._rows.length % 5];
      mockApi._rows.push({
        ...base,
        row: 100 + mockApi._rows.length,
        name: base.name + " #" + (mockApi._rows.length + 1),
        checked: mockApi._rows.length % 4 === 0,
      });
    }
  }

  if (action === "login" || action === "inspectionList") {
    if (payload.pin && payload.pin !== "9338892" && state.pin !== "9338892" && payload.pin !== state.pin) {
      // pin checked at login UI against whatever user set; mock accepts any non-empty after session
    }
    return Promise.resolve({
      month: "2026-10",
      warnCount: 3,
      rows: JSON.parse(JSON.stringify(mockApi._rows)),
    });
  }
  if (action === "setInspection") {
    const row = mockApi._rows.find((r) => r.row === Number(payload.row));
    if (row) row.checked = !!payload.checked;
    return Promise.resolve({ ok: true, row: Number(payload.row), checked: !!payload.checked });
  }
  if (action === "setInspectionBulk") {
    const ids = new Set((payload.rows || []).map(Number));
    mockApi._rows.forEach((r) => {
      if (ids.has(r.row)) r.checked = true;
    });
    return Promise.resolve({ ok: true, count: ids.size });
  }
  return Promise.reject(new Error("알 수 없는 요청입니다."));
}

function waitingCount() {
  return state.rows.filter((r) => !r.checked).length;
}

function visibleRows() {
  const q = state.query.trim();
  return state.rows.filter((r) => {
    if (state.pendingOnly && r.checked) return false;
    if (!q) return true;
    const hay = `${r.date} ${r.vendor} ${r.name} ${r.spec} ${r.code}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });
}

function selectedRow() {
  return state.rows.find((r) => r.row === state.selectedId) || null;
}

async function loadInspection() {
  state.loading = true;
  state.error = "";
  render();
  try {
    const data = await api("inspectionList", {});
    state.month = data.month || "";
    state.rows = data.rows || [];
    state.warnCount = data.warnCount || 0;
    if (!state.selectedId && state.rows.length) {
      const first = state.rows.find((r) => !r.checked) || state.rows[0];
      state.selectedId = first.row;
    }
  } catch (err) {
    state.error = err.message || "불러오지 못했습니다.";
  } finally {
    state.loading = false;
    render();
  }
}

async function toggleCheck(rowNumber, checked) {
  const target = state.rows.find((r) => r.row === rowNumber);
  if (!target) return;
  const prev = target.checked;
  target.checked = checked; // 낙관적 업데이트
  render();
  try {
    await api("setInspection", { row: rowNumber, checked });
    toast(checked ? "검수완료로 반영했습니다." : "검수대기로 되돌렸습니다.");
  } catch (err) {
    target.checked = prev;
    render();
    toast(err.message || "저장에 실패했습니다.");
  }
}

async function bulkComplete() {
  const targets = visibleRows().filter((r) => !r.checked);
  if (!targets.length) {
    toast("검수할 항목이 없습니다.");
    return;
  }
  const ids = targets.map((r) => r.row);
  targets.forEach((r) => { r.checked = true; });
  render();
  try {
    await api("setInspectionBulk", { rows: ids });
    toast(`일괄 검수완료 ${ids.length}건`);
  } catch (err) {
    await loadInspection();
    toast(err.message || "일괄 저장에 실패했습니다.");
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
        <p class="text-sm text-black/60 mb-3">직원용 비밀번호를 입력하세요. 홈 화면에 추가하면 앱처럼 열립니다.</p>
        <input id="pinInput" type="password" inputmode="numeric" autocomplete="current-password"
          class="w-full tap rounded-xl border border-paper-line px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-brand/30" />
        ${state.error ? `<p class="text-red-700 text-sm mt-2">${esc(state.error)}</p>` : ""}
        <button class="mt-4 w-full tap rounded-xl bg-brand text-white font-semibold hover:bg-brand-soft transition">들어가기</button>
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

function sidebarHtml() {
  const wait = waitingCount();
  return `
    <aside class="desktop-only w-64 shrink-0 bg-brand text-white flex flex-col min-h-0">
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
          if (m.badge === "warn") badge = `<span class="ml-auto text-[10px] font-bold bg-[#ffd9a8] text-[#8a4b00] rounded-full px-2 py-0.5">확인요망</span>`;
          return `<button data-menu="${m.id}" class="nav-item w-full tap flex items-center gap-3 rounded-xl px-3 py-3 text-left ${on ? "bg-white/15" : "hover:bg-white/10"}">
            <i class="fa-solid ${m.icon} w-5 text-center opacity-90"></i>
            <span class="text-sm font-medium">${m.label}</span>${badge}
          </button>`;
        }).join("")}
      </nav>
      <div class="p-4 text-xs text-white/50 border-t border-white/10">매장 PC 수집 · 시트 동기화</div>
    </aside>`;
}

function mobileHeaderHtml() {
  return `
    <header class="mobile-only sticky top-0 z-20 bg-brand text-white px-4 py-3 flex items-center gap-3">
      <div class="w-9 h-9 rounded-lg bg-white/10 grid place-items-center"><i class="fa-solid fa-store"></i></div>
      <div class="min-w-0">
        <div class="font-bold truncate">중계고기파티</div>
        <div class="text-[11px] text-white/65 truncate">${esc(state.month)} 실물 검수</div>
      </div>
      <button id="mobileRefresh" class="ml-auto tap rounded-lg px-3 hover:bg-white/10"><i class="fa-solid fa-rotate-right"></i></button>
    </header>`;
}

function mobileTabsHtml() {
  return `
    <nav class="mobile-only fixed bottom-0 inset-x-0 z-20 bg-brand text-white grid grid-cols-4 border-t border-white/10 pb-[env(safe-area-inset-bottom)]">
      ${MENUS.map((m) => {
        const on = state.menu === m.id;
        return `<button data-menu="${m.id}" class="tap py-2 text-[11px] ${on ? "text-white" : "text-white/55"}">
          <div class="text-base mb-0.5"><i class="fa-solid ${m.icon}"></i></div>${m.label.split(" ")[0]}
        </button>`;
      }).join("")}
    </nav>`;
}

function toolbarHtml() {
  return `
    <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-4">
      <h2 class="text-xl font-bold tracking-tight">${esc(state.month || "—")} 실물 검수</h2>
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative flex-1 min-w-[180px]">
          <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-black/35 text-sm"></i>
          <input id="searchInput" value="${esc(state.query)}" placeholder="거래처·품목·코드 검색"
            class="w-full tap rounded-xl border border-paper-line bg-white pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/25" />
        </div>
        <button id="btnRefresh" class="tap rounded-xl border border-paper-line bg-white px-3 hover:bg-black/[.03]"><i class="fa-solid fa-rotate-right"></i></button>
        <button id="btnPending" class="tap rounded-xl border border-paper-line bg-white px-3 text-sm hover:bg-black/[.03]">
          ${state.pendingOnly ? "대기만" : "전체"}
        </button>
        <button id="btnBulk" class="tap rounded-xl bg-ok text-white px-4 text-sm font-semibold hover:brightness-110 shadow-sm">
          일괄 검수완료
        </button>
      </div>
    </div>`;
}

function tableHtml(rows) {
  if (state.loading) return `<div class="p-8 text-sm text-black/50">불러오는 중…</div>`;
  if (!rows.length) return `<div class="p-8 text-sm text-black/50">표시할 입고가 없습니다.</div>`;
  return `
    <div class="desktop-only overflow-auto scroll-thin rounded-2xl border border-paper-line bg-white shadow-panel">
      <table class="min-w-full text-sm">
        <thead class="bg-[#f3f6f3] text-black/55 sticky top-0">
          <tr class="text-left">
            <th class="px-3 py-3 w-12"></th>
            <th class="px-3 py-3 font-medium">거래일자</th>
            <th class="px-3 py-3 font-medium">거래처</th>
            <th class="px-3 py-3 font-medium">품목명</th>
            <th class="px-3 py-3 font-medium">단위/규격</th>
            <th class="px-3 py-3 font-medium text-right">수량</th>
            <th class="px-3 py-3 font-medium">검수상태</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const on = r.row === state.selectedId;
            return `<tr data-row="${r.row}" class="row-hover border-t border-paper-line cursor-pointer ${on ? "bg-[#eef6f1]" : ""}">
              <td class="px-3 py-2.5">
                <input type="checkbox" class="w-4 h-4 accent-ok" data-check="${r.row}" ${r.checked ? "checked" : ""} />
              </td>
              <td class="px-3 py-2.5 whitespace-nowrap">${esc(r.date)}</td>
              <td class="px-3 py-2.5">${esc(r.vendor)}</td>
              <td class="px-3 py-2.5 font-medium">${esc(r.name)}</td>
              <td class="px-3 py-2.5 text-black/60">${esc(r.spec)}</td>
              <td class="px-3 py-2.5 text-right tabular-nums">${esc(r.final || r.qty)}</td>
              <td class="px-3 py-2.5">
                <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${r.checked ? "badge-ok" : "badge-wait"}">
                  ${r.checked ? "검수완료" : "검수대기"}
                </span>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function cardsHtml(rows) {
  if (state.loading) return `<div class="mobile-only p-6 text-sm text-black/50">불러오는 중…</div>`;
  if (!rows.length) return `<div class="mobile-only p-6 text-sm text-black/50">표시할 입고가 없습니다.</div>`;
  return `
    <div class="mobile-only space-y-3 pb-24">
      ${rows.map((r) => `
        <article data-row="${r.row}" class="card-press bg-white border border-paper-line rounded-2xl p-4 shadow-sm flex gap-3 items-stretch">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.checked ? "badge-ok" : "badge-wait"}">
                ${r.checked ? "검수완료" : "검수대기"}
              </span>
              <span class="text-xs text-black/45">${esc(r.date)}</span>
            </div>
            <div class="font-bold text-[17px] leading-snug">${esc(r.name)}</div>
            <div class="text-sm text-black/55 mt-1">${esc(r.vendor)}</div>
            <div class="text-sm text-black/45 mt-1">${esc(r.spec)} · 수량 <b class="text-brand-ink">${esc(r.final || r.qty)}</b></div>
          </div>
          <button data-orb="${r.row}" class="check-orb shrink-0 self-center ${r.checked ? "bg-ok text-white" : "bg-[#fff7ee] text-wait border border-[#f0d2b0]"}" aria-label="검수 체크">
            <i class="fa-solid ${r.checked ? "fa-check" : "fa-circle"} text-lg"></i>
          </button>
        </article>
      `).join("")}
    </div>`;
}

function detailHtml() {
  const row = selectedRow();
  if (!row) {
    return `
      <aside class="desktop-only w-80 shrink-0 border-l border-paper-line bg-paper-card p-5 overflow-y-auto scroll-thin">
        <h3 class="font-bold text-lg mb-2">선택 전표 상세</h3>
        <p class="text-sm text-black/50">왼쪽 목록에서 전표를 선택하세요.</p>
      </aside>`;
  }
  return `
    <aside class="desktop-only w-80 shrink-0 border-l border-paper-line bg-paper-card p-5 overflow-y-auto scroll-thin">
      <h3 class="font-bold text-lg mb-4">선택 전표 상세</h3>
      <div class="rounded-2xl border border-paper-line bg-white p-4 shadow-sm mb-4">
        <div class="text-xs text-black/45 mb-1">거래처</div>
        <div class="font-bold text-lg">${esc(row.vendor)}</div>
        <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div><div class="text-xs text-black/45">거래일</div><div class="font-medium">${esc(row.date)}</div></div>
          <div><div class="text-xs text-black/45">상태</div>
            <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${row.checked ? "badge-ok" : "badge-wait"}">${row.checked ? "검수완료" : "검수대기"}</span>
          </div>
          <div class="col-span-2"><div class="text-xs text-black/45">품목</div><div class="font-medium">${esc(row.name)}</div></div>
          <div><div class="text-xs text-black/45">규격</div><div>${esc(row.spec)}</div></div>
          <div><div class="text-xs text-black/45">반영수량</div><div class="font-semibold">${esc(row.final || row.qty)}</div></div>
          <div class="col-span-2"><div class="text-xs text-black/45">코드</div><div>${esc(row.code || "코드 없음")}</div></div>
          ${row.biz ? `<div class="col-span-2"><div class="text-xs text-black/45">사업자번호</div><div>${esc(row.biz)}</div></div>` : ""}
          ${row.amount ? `<div class="col-span-2"><div class="text-xs text-black/45">금액</div><div class="font-semibold">${esc(row.amount)}</div></div>` : ""}
        </div>
        <button id="detailToggle" class="mt-4 w-full tap rounded-xl ${row.checked ? "bg-black/5 text-brand" : "bg-ok text-white"} font-semibold">
          ${row.checked ? "검수대기로 되돌리기" : "검수완료 처리"}
        </button>
      </div>
      <div class="text-sm font-semibold mb-2">영수증 / 명세서 미리보기</div>
      <div class="receipt-frame rounded-2xl border border-dashed border-paper-line overflow-hidden min-h-[280px] grid place-items-center text-center p-4">
        ${row.imageUrl
          ? `<img src="${esc(row.imageUrl)}" alt="명세서" class="max-h-[360px] w-full object-contain bg-white" />`
          : `<div class="text-black/45 text-sm leading-relaxed">
              <i class="fa-regular fa-image text-3xl mb-3 block text-brand/40"></i>
              이미지 첨부 전입니다.<br/>구글 드라이브 연동 후 여기에 표시됩니다.
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
        <p class="text-sm text-black/50">이 메뉴는 다음 단계에서 연결됩니다.</p>
      </div>
    </div>`;
}

function renderApp() {
  const rows = visibleRows();
  const inspectMain = `
    <section class="flex-1 min-w-0 min-h-0 flex flex-col p-4 lg:p-6 overflow-hidden">
      ${toolbarHtml()}
      ${state.error ? `<div class="mb-3 text-sm text-red-700">${esc(state.error)}</div>` : ""}
      <div class="flex-1 min-h-0 overflow-y-auto scroll-thin">
        ${tableHtml(rows)}
        ${cardsHtml(rows)}
      </div>
    </section>`;

  let main = inspectMain;
  if (state.menu === "balance") main = placeholderMenu("거래처 금액 검증");
  if (state.menu === "price") main = placeholderMenu("단가 추이");
  if (state.menu === "stock") main = placeholderMenu("재고 및 발주 관리");

  root.innerHTML = `
    <div class="h-full flex flex-col lg:flex-row min-h-0">
      ${sidebarHtml()}
      <div class="flex-1 min-w-0 min-h-0 flex flex-col">
        ${mobileHeaderHtml()}
        <div class="flex-1 min-h-0 flex">
          ${main}
          ${state.menu === "inspect" ? detailHtml() : `<aside class="desktop-only w-80 shrink-0 border-l border-paper-line bg-paper-card"></aside>`}
        </div>
        ${mobileTabsHtml()}
      </div>
      ${state.toast ? `<div class="fixed left-1/2 -translate-x-1/2 bottom-24 lg:bottom-8 z-50 bg-brand text-white text-sm px-4 py-2.5 rounded-full shadow-lg">${esc(state.toast)}</div>` : ""}
    </div>`;

  bindAppEvents();
}

function bindAppEvents() {
  document.querySelectorAll("[data-menu]").forEach((btn) => {
    btn.onclick = () => {
      state.menu = btn.getAttribute("data-menu");
      render();
    };
  });

  const search = document.getElementById("searchInput");
  if (search) {
    search.oninput = () => {
      state.query = search.value;
      // 입력 중 전체 리렌더 대신 목록만 다시 — 단순화를 위해 debounce render
      clearTimeout(bindAppEvents._q);
      bindAppEvents._q = setTimeout(render, 120);
    };
  }

  const refresh = () => loadInspection();
  document.getElementById("btnRefresh")?.addEventListener("click", refresh);
  document.getElementById("mobileRefresh")?.addEventListener("click", refresh);
  document.getElementById("btnPending")?.addEventListener("click", () => {
    state.pendingOnly = !state.pendingOnly;
    render();
  });
  document.getElementById("btnBulk")?.addEventListener("click", () => bulkComplete());

  document.querySelectorAll("tr[data-row]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.matches("input[type=checkbox]")) return;
      state.selectedId = Number(tr.getAttribute("data-row"));
      render();
    };
  });
  document.querySelectorAll("input[data-check]").forEach((box) => {
    box.onchange = () => toggleCheck(Number(box.getAttribute("data-check")), box.checked);
  });
  document.querySelectorAll("button[data-orb]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = Number(btn.getAttribute("data-orb"));
      const row = state.rows.find((r) => r.row === id);
      if (row) toggleCheck(id, !row.checked);
    };
  });
  document.querySelectorAll("article[data-row]").forEach((card) => {
    card.onclick = () => {
      state.selectedId = Number(card.getAttribute("data-row"));
      // 모바일은 상세 패널 없음 — 선택만 유지
    };
  });
  document.getElementById("detailToggle")?.addEventListener("click", () => {
    const row = selectedRow();
    if (row) toggleCheck(row.row, !row.checked);
  });
}

function render() {
  if (!state.pin) renderPin();
  else renderApp();
}

(async function boot() {
  render();
  if (state.pin) await loadInspection();
})();
