import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/ingest
 * Body: { source: string }
 *
 * Triggers re-ingestion of a registered source. Returns progress as JSON
 * for now; v0.2 upgrades to Server-Sent Events for live progress.
 *
 * Stub for v0.1 — full implementation lands next pass.
 */
export async function POST() {
  return NextResponse.json(
    { error: "not_implemented", message: "Ingestion endpoint stub." },
    { status: 501 },
  );
}
