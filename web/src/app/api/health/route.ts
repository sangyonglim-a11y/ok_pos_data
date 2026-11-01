import { NextResponse } from "next/server";
import { credentials, sheetId, sheetsClient, publicSheetsError } from "@/lib/sheets";

export const runtime = "nodejs";

export async function GET() {
  try {
    const id = sheetId();
    const creds = credentials() as { client_email?: string };
    const sheets = await sheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: id,
      fields: "properties.title",
    });
    return NextResponse.json({
      ok: true,
      sheetId: id,
      title: meta.data.properties?.title || "",
      serviceAccount: creds.client_email || "",
    });
  } catch (err) {
    let id = "";
    let email = "";
    try {
      id = sheetId();
    } catch {
      /* ignore */
    }
    try {
      email = String((credentials() as { client_email?: string }).client_email || "");
    } catch {
      /* ignore */
    }
    return NextResponse.json(
      {
        ok: false,
        sheetId: id,
        serviceAccount: email,
        error: publicSheetsError(err),
      },
      { status: 500 },
    );
  }
}
