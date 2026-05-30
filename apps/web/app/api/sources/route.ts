import { NextResponse } from "next/server";
import { z } from "zod";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import {
  addSource,
  listSources,
  removeSource,
  chunkCountBySource,
  ingestStatsBySource,
  getSourceByPath,
  setSourceWatchInterval,
  DEFAULT_WATCH_INTERVAL_MS,
} from "@mnemos/db";
import { getDb } from "@/lib/runtime";
import { clearIngestStatus } from "@/lib/ingest-status";

export const runtime = "nodejs";

// Auto re-scan cadence: 0 (manual only) or at least one minute. Guards against
// a pathological sub-second polling loop.
const watchIntervalSchema = z
  .number()
  .int()
  .min(0)
  .refine((v) => v === 0 || v >= 60_000, {
    message: "watchIntervalMs must be 0 (manual) or at least 60000",
  });

const AddRequest = z.object({
  path: z.string().min(1),
  kind: z.enum(["folder", "file", "url", "mailbox"]).optional().default("folder"),
  watchIntervalMs: watchIntervalSchema.optional().default(DEFAULT_WATCH_INTERVAL_MS),
});

const PatchRequest = z.object({
  path: z.string().min(1),
  watchIntervalMs: watchIntervalSchema,
});

/** Local kinds are filesystem paths we expand `~` for; url/mailbox are opaque. */
function isLocalKind(kind: string): boolean {
  return kind === "folder" || kind === "file";
}

const RemoveRequest = z.object({
  path: z.string().min(1),
});

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(p.replace(/^~/, homedir()));
  }
  return resolve(p);
}

/**
 * GET /api/sources
 * Returns registered sources, with chunk counts.
 */
export async function GET() {
  try {
    const db = getDb();
    const sources = listSources(db);
    const counts = chunkCountBySource(db);
    const stats = ingestStatsBySource(db);
    return NextResponse.json({
      sources: sources.map((s) => {
        const stat = stats.get(s.id);
        // Next auto re-scan time: never-scanned → due now; manual (0) → null.
        const nextScanDueAt =
          s.watchIntervalMs > 0
            ? (s.lastScannedAt ?? 0) + s.watchIntervalMs
            : null;
        return {
          id: s.id,
          path: s.path,
          kind: s.kind,
          scope: s.scope,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          chunkCount: counts.get(s.id) ?? 0,
          fileCount: stat?.fileCount ?? 0,
          lastIngestedAt: stat?.lastIngestedAt ?? null,
          watchIntervalMs: s.watchIntervalMs,
          lastScannedAt: s.lastScannedAt,
          nextScanDueAt,
          paused: s.paused,
        };
      }),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "list_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/sources
 * Body: { path: string, kind?: 'folder' | 'file' | 'url' | 'mailbox' }
 * Registers a new source for later ingestion. Idempotent: re-registering
 * an existing path updates its `updated_at` and returns the same row. A local
 * path defaulting to "folder" is auto-detected as "file" when it points at one.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = AddRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const requestedKind = parsed.data.kind;
  const absolutePath = isLocalKind(requestedKind)
    ? expandHome(parsed.data.path)
    : parsed.data.path;

  // Frictionless: when the caller didn't distinguish (the default "folder"),
  // detect whether the path is actually a single file and register it as such,
  // so "drop a file" and "drop a folder" both Just Work from one input. An
  // explicit "file"/"url"/"mailbox" is honored as-is.
  let kind = requestedKind;
  if (requestedKind === "folder") {
    try {
      if ((await stat(absolutePath)).isFile()) kind = "file";
    } catch {
      // Path doesn't exist yet / unreadable — keep "folder"; ingest will report.
    }
  }

  try {
    const db = getDb();
    const source = addSource(db, absolutePath, kind, parsed.data.watchIntervalMs);
    return NextResponse.json({ source });
  } catch (err) {
    return NextResponse.json(
      {
        error: "add_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/sources
 * Body: { path: string, watchIntervalMs: number }
 * Updates a source's auto re-scan cadence (0 = manual only).
 */
export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = PatchRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    // Match the stored path as sent first (covers opaque url/mailbox sources),
    // then fall back to home-expanded for local paths typed with a leading ~.
    const source =
      getSourceByPath(db, parsed.data.path) ??
      getSourceByPath(db, expandHome(parsed.data.path));
    if (!source) {
      return NextResponse.json({ error: "source_not_found" }, { status: 404 });
    }
    setSourceWatchInterval(db, source.id, parsed.data.watchIntervalMs);
    return NextResponse.json({ ok: true, watchIntervalMs: parsed.data.watchIntervalMs });
  } catch (err) {
    return NextResponse.json(
      {
        error: "update_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/sources
 * Body: { path: string }
 * Removes a source and purges all its chunks + vectors.
 */
export async function DELETE(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = RemoveRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    const expanded = expandHome(parsed.data.path);
    // Resolve the id first so we can evict any live ingest status — otherwise a
    // removed source in an error/running state would ghost in /api/ingest/status.
    const existing = getSourceByPath(db, expanded);
    const result = removeSource(db, expanded);
    if (existing) clearIngestStatus(existing.id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: "remove_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
