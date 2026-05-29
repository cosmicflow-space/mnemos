import { NextResponse } from "next/server";
import { getUsageTotals } from "@mnemos/db";
import { getDb } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/usage
 *
 * All-time token totals grouped by (provider, model), summed across every
 * session. Returns raw token counts only — the client multiplies by the
 * per-model pricing from /api/providers to render cumulative cost. Pricing
 * lives in the provider plugins, not here, so this route stays provider-agnostic.
 */
export async function GET() {
  try {
    const db = getDb();
    return NextResponse.json({ totals: getUsageTotals(db) });
  } catch (err) {
    return NextResponse.json(
      {
        error: "usage_query_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
