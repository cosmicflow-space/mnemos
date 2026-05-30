import { NextResponse } from "next/server";
import { z } from "zod";
import { setSourcePaused } from "@mnemos/db";
import { getDb } from "@/lib/runtime";
import { pauseIngest, pauseAllIngest, ingestingSourceIds } from "@/lib/ingest-control";

export const runtime = "nodejs";

const Body = z.object({ sourceId: z.number().int().optional() });

/**
 * Pause an in-flight ingest. Body `{ sourceId }` pauses one source; an empty
 * body (or omitted sourceId) pauses ALL running ingests — the "pause everything
 * before bed / heavy CPU" control. Cooperative: aborts the run at a file
 * boundary, leaving it resumable.
 */
export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // Empty/no body → pause all.
  }
  const parsed = Body.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const db = getDb();
  if (parsed.data.sourceId === undefined) {
    // Persist paused for every in-flight source first (durable — the watcher
    // skips paused sources), then abort them.
    for (const id of ingestingSourceIds()) setSourcePaused(db, id, true);
    return NextResponse.json({ scope: "all", paused: pauseAllIngest() });
  }
  // Persist paused even if no run is in flight, so the watcher won't (re)start it.
  setSourcePaused(db, parsed.data.sourceId, true);
  return NextResponse.json({
    scope: "source",
    sourceId: parsed.data.sourceId,
    paused: pauseIngest(parsed.data.sourceId) ? 1 : 0,
  });
}
