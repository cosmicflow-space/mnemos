import { NextResponse } from "next/server";
import { getIngestStatus } from "@/lib/ingest-status";

export const runtime = "nodejs";

/**
 * Live ingestion status for the settings-launcher ring and any polling client.
 * Cheap (reads an in-memory snapshot — no DB), so it's safe to poll on a short
 * interval. Auth is handled by middleware (loopback is trusted).
 */
export async function GET() {
  return NextResponse.json(getIngestStatus());
}
