import { z } from "zod";
import { ingestFolder } from "@mnemos/core";
import { getSourceByPath } from "@mnemos/db";
import { getDb, getRegistry, getDefaultEmbedder } from "@/lib/runtime";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IngestRequest = z.object({
  path: z.string().min(1),
});

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(p.replace(/^~/, homedir()));
  }
  return resolve(p);
}

/**
 * POST /api/ingest
 * Body: { path: string }
 *
 * Streams progress as Server-Sent Events. Each event is one line of JSON
 * preceded by `data: ` and followed by a blank line, per the SSE spec.
 *
 * Event types come from IngestProgress in @mnemos/core/ingest/pipeline:
 *   scan-start, scan-complete, file-start, file-skipped, file-chunked,
 *   file-embedded, file-complete, done
 *
 * The UI subscribes via EventSource (or fetch + ReadableStream) and
 * surfaces per-file progress in real time.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = IngestRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const absolutePath = expandHome(parsed.data.path);
  const db = getDb();
  const source = getSourceByPath(db, absolutePath);
  if (!source) {
    return Response.json(
      {
        error: "source_not_registered",
        message: `Source ${absolutePath} is not registered. Add it via POST /api/sources first.`,
      },
      { status: 404 },
    );
  }

  const registry = getRegistry();
  let embedder;
  try {
    embedder = await getDefaultEmbedder();
  } catch (err) {
    return Response.json(
      {
        error: "embedder_init_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await ingestFolder(db, registry, embedder, source, {
          onProgress: (progress) => send(progress),
        });
      } catch (err) {
        send({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
