import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/audit?since=<unix-ms>&limit=<n>
 *
 * Tail the audit log. Default returns last 100 events.
 *
 * Stub for v0.1 — full implementation lands next pass.
 */
export async function GET() {
  return NextResponse.json({ events: [] });
}
