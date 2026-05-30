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
} from "@mnemos/db";
import { getDb } from "@/lib/runtime";

export const runtime = "nodejs";

const AddRequest = z.object({
  path: z.string().min(1),
  kind: z.enum(["folder", "file", "url", "mailbox"]).optional().default("folder"),
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
    const source = addSource(db, absolutePath, kind);
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
    const result = removeSource(db, expandHome(parsed.data.path));
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
