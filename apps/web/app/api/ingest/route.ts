import { z } from "zod";
import { ingestFolder } from "@mnemos/core";
import {
  getSourceByPath,
  touchSourceScanned,
  tryClaimIngest,
  releaseIngest,
} from "@mnemos/db";
import { getDb, getRegistry, getDefaultEmbedder } from "@/lib/runtime";
import { applyIngestProgress, markIngestPaused } from "@/lib/ingest-status";
import { registerIngestController, unregisterIngestController } from "@/lib/ingest-control";
import { runSourceIngestInBackground } from "@/lib/ingest-runner";
import { normalizeUserPath } from "@/lib/user-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IngestRequest = z.object({
  path: z.string().min(1),
  filters: z
    .object({
      excludeLabels: z.array(z.string()).optional(),
      includeOverrides: z
        .object({
          log: z.boolean().optional(),
          lockfile: z.boolean().optional(),
          minified: z.boolean().optional(),
          transient: z.boolean().optional(),
          hidden: z.boolean().optional(),
        })
        .optional(),
      includeLargeFiles: z.boolean().optional(),
    })
    .optional(),
  /** Defer files larger than this many bytes to a background run (smallest-first
   * foreground now; the big ones index off the streamed connection after). */
  deferOverBytes: z.number().int().positive().optional(),
});

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

  let absolutePath: string;
  try {
    absolutePath = normalizeUserPath(parsed.data.path);
  } catch {
    return Response.json({ error: "invalid_request", message: "path is empty" }, { status: 400 });
  }
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
      // Acquire the same lease the watcher uses, so a manual ↻ Re-scan and a
      // background tick can't ingest this source concurrently.
      const token = tryClaimIngest(db, source.id);
      if (token === null) {
        send({
          phase: "error",
          message: "An ingest is already in progress for this source — try again in a moment.",
        });
        controller.close();
        return;
      }
      // Register an abort handle so POST /api/ingest/pause can stop this run.
      const abort = new AbortController();
      registerIngestController(source.id, abort);
      let kickBackground = false;
      try {
        await ingestFolder(db, registry, embedder, source, {
          signal: abort.signal,
          // User-initiated re-scan: re-attempt files previously marked failed.
          retryFailed: true,
          onProgress: (progress) => {
            // When paused mid-run, drop the trailing 'done' entirely (both to the
            // client and the status registry) so the terminal event the client
            // sees is 'paused' — not a misleading success — and the status entry
            // survives as 'paused' (with progress) rather than clearing to idle.
            if (abort.signal.aborted && progress.phase === "done") return;
            send(progress);
            applyIngestProgress(source.id, source.path, progress);
          },
          filters: parsed.data.filters,
          deferOverBytes: parsed.data.deferOverBytes,
        });
        if (abort.signal.aborted) {
          markIngestPaused(source.id);
          send({ phase: "paused" });
        } else {
          // Manual scan resets the auto re-scan cadence for this source.
          touchSourceScanned(db, source.id);
          // If large files were deferred, hand them to a background run (no limit,
          // hash-skips the small ones just done) once we release the lease below.
          if (parsed.data.deferOverBytes != null) kickBackground = true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ phase: "error", message });
        applyIngestProgress(source.id, source.path, { phase: "error", message });
      } finally {
        unregisterIngestController(source.id, abort);
        releaseIngest(db, source.id, token);
        controller.close();
        // Fire-and-forget: lease is now free, so the background run can claim it.
        if (kickBackground) void runSourceIngestInBackground(source.id);
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
