import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/query
 * Body: { q: string, sessionId?: string }
 *
 * Streaming chat response with citations.
 * Stub for v0.1 — full implementation in @mnemos/core lands next pass.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "not_implemented",
      message: "Query endpoint stub. Implementation lands in next build pass.",
    },
    { status: 501 },
  );
}
