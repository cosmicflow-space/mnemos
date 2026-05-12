import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET    /api/folders          List paired folders
 * POST   /api/folders          Pair a new folder { path: string }
 * DELETE /api/folders          Unpair { path: string }
 *
 * Stub for v0.1 — full implementation in @mnemos/core lands next pass.
 */
export async function GET() {
  return NextResponse.json({ folders: [] });
}

export async function POST() {
  return NextResponse.json(
    { error: "not_implemented", message: "Folder pairing endpoint stub." },
    { status: 501 },
  );
}
