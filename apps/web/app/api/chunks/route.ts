import { NextResponse } from "next/server";
import { getChunksByIds } from "@mnemos/db";
import { getDb } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/chunks?ids=1,2,3
 *
 * Resolves chunk IDs (a chat message's stored citations) to their file path,
 * source path, full text, and file mtime — powering the response-transparency
 * panels (Sources / Data sent) when a past chat is reloaded from history.
 * Bearer-gated by middleware like all /api/* routes.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    // Strict digits-only — reject malformed tokens like "12x" / "7e2" / "1.9"
    // that Number.parseInt would otherwise truncate to a valid-looking ID.
    .filter((s) => /^\d+$/.test(s))
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => n > 0);
  if (ids.length === 0) {
    return NextResponse.json({ chunks: [] });
  }
  try {
    const db = getDb();
    return NextResponse.json({ chunks: getChunksByIds(db, ids.slice(0, 64)) });
  } catch (err) {
    return NextResponse.json(
      {
        error: "chunks_query_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
