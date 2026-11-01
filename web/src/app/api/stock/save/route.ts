import { NextRequest, NextResponse } from "next/server";
import { assertPin } from "@/lib/auth";
import { publicSheetsError, saveLiveStockCell } from "@/lib/sheets";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    assertPin(req.headers.get("x-app-pin") || body.pin);
    const kind = body.kind === "safety" ? "safety" : "adjustment";
    const saved = await saveLiveStockCell(Number(body.row), kind, String(body.value ?? ""));
    return NextResponse.json(saved);
  } catch (err) {
    const raw = err instanceof Error ? err.message : "";
    const message = raw.includes("비밀번호") ? raw : publicSheetsError(err);
    const status = message.includes("비밀번호") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
