/**
 * POST /api/reindex — force re-extraction of the focused file (the web mirror of
 * Telegram /reindex). Used to retry a file that came in metadata-only (e.g. a
 * scanned PDF that needs OCR). On success the file is readable, so a fresh thread
 * opens still scoped to it; the new session id is returned for the client.
 */

import { z } from "zod";
import { appendAudit } from "@mnemos/db";
import { getDb } from "@/lib/runtime";
import { sessionKey, getFocus, setFocus } from "@/lib/do-state";
import { META_ONLY_CHARS } from "@/lib/focus-util";
import { freshSession } from "@/lib/web-session";
import { reindexFile } from "@/lib/do-rag";
import type { ReindexResult } from "@/lib/do-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ sessionId: z.string().min(1) });

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ kind: "error", message: "invalid JSON" } satisfies ReindexResult, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ kind: "error", message: "invalid request" } satisfies ReindexResult, { status: 400 });
  }
  const { sessionId } = parsed.data;
  const target = getFocus(sessionKey(sessionId))?.[0];
  if (!target) return Response.json({ kind: "no-focus" } satisfies ReindexResult);

  const res = await reindexFile(target.fileId);
  try {
    appendAudit(getDb(), "do_reindex", {
      channel: "web",
      sessionId,
      fileId: target.fileId,
      ok: res.ok,
      contentChars: res.contentChars,
    });
  } catch {
    /* best effort */
  }

  if (!res.ok) {
    return Response.json({
      kind: "error",
      name: target.name,
      message: res.reason ?? "it failed",
    } satisfies ReindexResult);
  }
  if (res.contentChars >= META_ONLY_CHARS) {
    // Now readable — fresh thread, still scoped to this file.
    const sid = freshSession();
    setFocus(sessionKey(sid), [target]);
    return Response.json({ kind: "readable", name: target.name, sessionId: sid } satisfies ReindexResult);
  }
  const reason = /\.pdf$/i.test(target.name)
    ? "Even OCR couldn't read it — likely a blank or very low-quality scan."
    : "This file type has no extractable text.";
  return Response.json({ kind: "still-empty", name: target.name, reason } satisfies ReindexResult);
}
