import { NextResponse } from "next/server";
import { scanCredentials } from "@/lib/credential-scan";

export const runtime = "nodejs";

/**
 * GET /api/credentials/scan
 *
 * Walks the user's home directory for known credential locations and reports
 * which providers have a usable credential already on disk. Returns only
 * locations and provider tags — never the credential values themselves.
 * Use POST /api/credentials/import to actually pull a value into Mnemos.
 */
export async function GET() {
  try {
    const scan = await scanCredentials();
    return NextResponse.json(scan);
  } catch (err) {
    return NextResponse.json(
      {
        error: "scan_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
