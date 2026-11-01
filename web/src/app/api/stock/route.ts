import { NextRequest, NextResponse } from "next/server";
import { assertPin } from "@/lib/auth";
import { loadLiveStock, publicSheetsError } from "@/lib/sheets";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    assertPin(req.headers.get("x-app-pin") || req.nextUrl.searchParams.get("pin"));
    const data = await loadLiveStock();
    return NextResponse.json(data);
  } catch (err) {
    const raw = err instanceof Error ? err.message : "";
    const message = raw.includes("비밀번호") ? raw : publicSheetsError(err);
    const status = message.includes("비밀번호") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
