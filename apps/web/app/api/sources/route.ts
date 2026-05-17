import { NextResponse } from "next/server";
import { z } from "zod";
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  addSource,
  listSources,
  removeSource,
  chunkCountBySource,
} from "@mnemos/db";
import { getDb } from "@/lib/runtime";

export const runtime = "nodejs";

const AddRequest = z.object({
  path: z.string().min(1),
  kind: z.enum(["folder", "url", "mailbox"]).optional().default("folder"),
});

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
    return NextResponse.json({
      sources: sources.map((s) => ({
        id: s.id,
        path: s.path,
        kind: s.kind,
        scope: s.scope,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        chunkCount: counts.get(s.id) ?? 0,
      })),
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
 * Body: { path: string, kind?: 'folder' | 'url' | 'mailbox' }
 * Registers a new source for later ingestion. Idempotent: re-registering
 * an existing path updates its `updated_at` and returns the same row.
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

  const absolutePath =
    parsed.data.kind === "folder"
      ? expandHome(parsed.data.path)
      : parsed.data.path;

  try {
    const db = getDb();
    const source = addSource(db, absolutePath, parsed.data.kind);
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
