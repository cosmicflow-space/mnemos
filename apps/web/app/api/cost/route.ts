import { NextResponse } from "next/server";
import { getDb, getRegistry } from "@/lib/runtime";
import { computeCostReport, formatCostMarkdown } from "@/lib/cost-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cost
 *
 * Estimated frontier spend + usage breakdown for the `/cost` command. Returns
 * both the structured report and a pre-rendered markdown string (the web chat
 * renders the markdown in a bubble). Cost = provider-reported tokens × per-model
 * pricing from the plugins.
 */
export async function GET() {
  try {
    const db = getDb();
    const registry = getRegistry();
    const report = await computeCostReport(db, registry);
    return NextResponse.json({ report, markdown: formatCostMarkdown(report) });
  } catch (err) {
    return NextResponse.json(
      { error: "cost_query_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
