import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET    /api/sources    List registered sources
 * POST   /api/sources    Register a new source { path: string, kind?: 'folder' | 'url' }
 * DELETE /api/sources    Unregister { path: string }
 *
 * A source is anything Mnemos has been granted permission to index:
 * a local folder, a URL prefix, an email mailbox (v0.2+). Registration is
 * the explicit opt-in primitive — Mnemos never indexes anything that hasn't
 * been registered.
 *
 * Stub for v0.1 — full implementation lands in next pass.
 */
export async function GET() {
  return NextResponse.json({ sources: [] });
}

export async function POST() {
  return NextResponse.json(
    { error: "not_implemented", message: "Source registration endpoint stub." },
    { status: 501 },
  );
}
