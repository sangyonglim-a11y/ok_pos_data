"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type StockRow = {
  row: number;
  code: string;
  name: string;
  category: string;
  unit: string;
  stock: number | null;
  safety: number | null;
  adjustment: number | null;
  display: string;
};

type InspectRow = {
  row: number;
  date: string;
  vendor: string;
  name: string;
  spec: string;
  qty: string;
  code: string;
  final: string;
  checked: boolean;
};

function qty(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  if (Math.abs(value - Math.round(value)) < 1e-9) return Math.round(value).toLocaleString("ko-KR");
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}

async function api<T>(path: string, pin: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-app-pin": pin,
      ...(init?.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "처리하지 못했습니다.");
  return data as T;
}

export default function HomePage() {
  const [pin, setPin] = useState("");
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<"stock" | "inspect">("stock");
  const [sub, setSub] = useState("핸드폰에서 재고와 검수를 엽니다.");
  const [stock, setStock] = useState<{ month: string; rows: StockRow[] } | null>(null);
  const [inspection, setInspection] = useState<{ month: string; rows: InspectRow[] } | null>(null);
  const [category, setCategory] = useState("전체");
  const [lowOnly, setLowOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingOnly, setPendingOnly] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const saved = sessionStorage.getItem("stockPin") || "";
    if (saved) {
      setPin(saved);
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (!ready || !pin) return;
    if (page === "stock") void loadStock();
    else void loadInspection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, page]);

  async function loadStock() {
    setSub("재고를 불러오는 중...");
    setError("");
    try {
      const data = await api<{ month: string; rows: StockRow[] }>("/api/stock", pin);
      setStock(data);
      const low = data.rows.filter(below).length;
      setSub(`${data.month} · 안전재고 이하 ${low}개 · 전체 ${data.rows.length}개`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "실패");
      setReady(false);
      sessionStorage.removeItem("stockPin");
    }
  }

  async function loadInspection() {
    setSub("검수 목록을 불러오는 중...");
    setError("");
    try {
      const data = await api<{ month: string; rows: InspectRow[] }>("/api/inspect", pin);
      setInspection(data);
      const waiting = data.rows.filter((r) => !r.checked).length;
      setSub(`${data.month} · 검수 대기 ${waiting}건`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "실패");
    }
  }

  function below(item: StockRow) {
    return item.safety !== null && item.stock !== null && item.stock <= item.safety;
  }

  function shortage(item: StockRow) {
    if (!below(item) || item.safety === null || item.stock === null) return null;
    return Math.round((item.safety - item.stock) * 10000) / 10000;
  }

  const categories = useMemo(() => {
    if (!stock) return ["전체"];
    const present: Record<string, boolean> = {};
    stock.rows.forEach((item) => {
      present[item.category || ""] = true;
    });
    const names = ["전체"];
    ["고기", "주류", "하이볼", "식사", "사이드", "음료", "야채", "공산품", "기타"].forEach((name) => {
      if (present[name]) names.push(name);
    });
    Object.keys(present)
      .sort()
      .forEach((name) => {
        if (name && !names.includes(name)) names.push(name);
      });
    if (present[""]) names.push("미분류");
    return names;
  }, [stock]);

  const visibleStock = useMemo(() => {
    if (!stock) return [];
    const keyword = query.trim();
    return stock.rows.filter((item) => {
      const itemCategory = item.category || "";
      if (category === "미분류" && itemCategory) return false;
      if (category !== "전체" && category !== "미분류" && itemCategory !== category) return false;
      if (keyword && !(item.name + " " + item.code + " " + itemCategory).includes(keyword)) return false;
      if (lowOnly && !below(item)) return false;
      return true;
    });
  }, [stock, category, query, lowOnly]);

  async function onPin(event: FormEvent) {
    event.preventDefault();
    const value = pin.trim();
    if (!value) return;
    try {
      await api("/api/stock", value);
      sessionStorage.setItem("stockPin", value);
      setPin(value);
      setReady(true);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "실패");
    }
  }

  async function saveField(rowNumber: number, kind: "safety" | "adjustment", value: string) {
    if (!stock) return;
    try {
      const saved = await api<{ stock: number | null; display: string; safety?: number | null; adjustment?: number | null }>(
        "/api/stock/save",
        pin,
        { method: "POST", body: JSON.stringify({ row: rowNumber, kind, value }) },
      );
      setStock({
        ...stock,
        rows: stock.rows.map((item) =>
          item.row === rowNumber
            ? {
                ...item,
                stock: saved.stock,
                display: saved.display,
                safety: saved.safety !== undefined ? saved.safety : item.safety,
                adjustment: saved.adjustment !== undefined ? saved.adjustment : item.adjustment,
              }
            : item,
        ),
      });
      setSub("저장했습니다.");
    } catch (err) {
      setSub(err instanceof Error ? err.message : "저장 실패");
    }
  }

  async function saveInspect() {
    if (!inspection) return;
    const changes = inspection.rows.map((row) => ({ row: row.row, checked: row.checked }));
    try {
      const result = await api<{ message: string }>("/api/inspect", pin, {
        method: "POST",
        body: JSON.stringify({ changes }),
      });
      setSub(result.message);
      await loadInspection();
    } catch (err) {
      setSub(err instanceof Error ? err.message : "저장 실패");
    }
  }

  if (!ready) {
    return (
      <>
        <header>
          <h1>중계고기파티 재고</h1>
          <p>{sub}</p>
        </header>
        <main>
          <form className="pin" onSubmit={onPin}>
            <h2>재고 열기</h2>
            <p className="note">직원용 비밀번호를 입력하세요. 홈 화면에 추가하면 앱처럼 열립니다.</p>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            {error ? <p className="error">{error}</p> : null}
            <button className="go" type="submit">
              들어가기
            </button>
          </form>
        </main>
      </>
    );
  }

  return (
    <>
      <header>
        <h1>중계고기파티 재고</h1>
        <p>{sub}</p>
      </header>
      <main>
        {page === "stock" && stock ? (
          <>
            <div className="chips">
              {categories.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={name === category ? "on" : ""}
                  onClick={() => setCategory(name)}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="tools">
              <input
                type="text"
                placeholder="품목 또는 코드"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label>
                <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
                이하만
              </label>
            </div>
            {visibleStock.map((item) => {
              const gap = shortage(item);
              const current = item.display || `${qty(item.stock)}${item.unit || ""}`;
              return (
                <article key={item.row} className={`card${below(item) ? " low" : ""}`}>
                  <div className="top">
                    <div>
                      <div className="muted">
                        {item.category || "미분류"} · {item.code}
                      </div>
                      <div className="name">{item.name}</div>
                    </div>
                    <div className="now">
                      <b>{current}</b>
                      <span className="muted">
                        잔여 {qty(item.stock)}
                        {gap === null ? "" : ` · 부족 ${qty(gap)}`}
                      </span>
                    </div>
                  </div>
                  <div className="fields">
                    <label>
                      <span>안전재고</span>
                      <input
                        inputMode="decimal"
                        defaultValue={qty(item.safety)}
                        key={`s-${item.row}-${item.safety}`}
                        onBlur={(e) => saveField(item.row, "safety", e.target.value)}
                      />
                    </label>
                    <label>
                      <span>조정(로스)</span>
                      <input
                        inputMode="decimal"
                        defaultValue={qty(item.adjustment)}
                        key={`a-${item.row}-${item.adjustment}`}
                        onBlur={(e) => saveField(item.row, "adjustment", e.target.value)}
                      />
                    </label>
                  </div>
                </article>
              );
            })}
            {!visibleStock.length ? <p className="note">이 조건에 재고가 없습니다.</p> : null}
            <p className="note">
              안전재고와 조정을 고치면 시트에 바로 저장됩니다. POS 판매 수집은 매장 PC 에이전트가 담당합니다.
            </p>
          </>
        ) : null}

        {page === "inspect" && inspection ? (
          <>
            <div className="tools">
              <button type="button" className="linkish" onClick={() => setPendingOnly((v) => !v)}>
                {pendingOnly
                  ? `전체 ${inspection.rows.length}건`
                  : `대기 ${inspection.rows.filter((r) => !r.checked).length}건만`}
              </button>
            </div>
            {inspection.rows
              .filter((row) => (pendingOnly ? !row.checked : true))
              .map((row) => (
                <label key={row.row} className={`rowcheck${row.code ? "" : " nocode"}`}>
                  <input
                    type="checkbox"
                    checked={row.checked}
                    onChange={(e) => {
                      setInspection({
                        ...inspection,
                        rows: inspection.rows.map((item) =>
                          item.row === row.row ? { ...item, checked: e.target.checked } : item,
                        ),
                      });
                    }}
                  />
                  <span>
                    <b>{row.name || "이름 없음"}</b>
                    <br />
                    <span className="muted">
                      {row.date} {row.vendor} · {row.spec} · 수량 {row.qty} · {row.code || "코드 없음"} · 반영{" "}
                      {row.final}
                    </span>
                  </span>
                </label>
              ))}
            <button className="save" type="button" onClick={() => void saveInspect()}>
              시트에 반영
            </button>
            <p className="note">체크는 검수 표시만 바꿉니다. 재고 수량은 매장/노트북에서 재고 계산 시 반영됩니다.</p>
          </>
        ) : null}
      </main>
      <nav className="tabs">
        <button type="button" className={page === "stock" ? "on" : ""} onClick={() => setPage("stock")}>
          재고
        </button>
        <button type="button" className={page === "inspect" ? "on" : ""} onClick={() => setPage("inspect")}>
          검수
        </button>
      </nav>
    </>
  );
}
