import { NextResponse } from "next/server";
import { z } from "zod";
import { setSourcePaused } from "@mnemos/db";
import { getDb } from "@/lib/runtime";
import { runSourceIngestInBackground } from "@/lib/ingest-runner";

export const runtime = "nodejs";

const Body = z.object({ sourceId: z.number().int() });

/**
 * Resume a paused source — a plain background re-ingest. Incremental: files
 * already `complete` are hash-skipped, so it picks up where the pause left off.
 * Returns `{ started: false }` if the source is unknown, no embedder is ready,
 * or a run is already in flight.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  // Clear the durable paused flag first so the watcher won't see it paused and
  // so the UI flips off "Resume" immediately, then kick the (incremental) re-ingest.
  setSourcePaused(getDb(), parsed.data.sourceId, false);
  const started = await runSourceIngestInBackground(parsed.data.sourceId);
  return NextResponse.json({ started });
}
