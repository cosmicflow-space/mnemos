import { NextResponse } from "next/server";
import { listAuditEvents } from "@mnemos/db";
import { getDb } from "@/lib/runtime";

export const runtime = "nodejs";

/**
 * GET /api/audit?since=<unix-ms>&limit=<n>&type=<event_type>
 *
 * Returns recent audit events newest-first. Default limit 100.
 * Powers the Inspector pane and the audit-log view that proves data
 * minimization to frontier LLMs.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const since = Number(url.searchParams.get("since") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const eventType = url.searchParams.get("type") ?? undefined;

    const db = getDb();
    const events = listAuditEvents(db, {
      since: Number.isFinite(since) ? since : 0,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 100,
      eventType,
    });

    return NextResponse.json({ events });
  } catch (err) {
    return NextResponse.json(
      {
        error: "audit_query_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
