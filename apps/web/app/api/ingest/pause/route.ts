import { NextResponse } from "next/server";
import { z } from "zod";
import { pauseIngest, pauseAllIngest } from "@/lib/ingest-control";

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
  if (parsed.data.sourceId === undefined) {
    return NextResponse.json({ scope: "all", paused: pauseAllIngest() });
  }
  return NextResponse.json({
    scope: "source",
    sourceId: parsed.data.sourceId,
    paused: pauseIngest(parsed.data.sourceId) ? 1 : 0,
  });
}
