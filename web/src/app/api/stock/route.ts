import { NextRequest, NextResponse } from "next/server";
import { assertPin } from "@/lib/auth";
import { loadLiveStock } from "@/lib/sheets";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    assertPin(req.headers.get("x-app-pin") || req.nextUrl.searchParams.get("pin"));
    const data = await loadLiveStock();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "불러오지 못했습니다.";
    const status = message.includes("비밀번호") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
