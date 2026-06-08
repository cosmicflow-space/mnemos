/**
 * POST /api/focus — File Focus Mode for the web chat (mirrors Telegram /focus
 * and /done). A focus transition opens a FRESH thread (so the new scope can't
 * leak the prior file's discussion), and the new session id is returned for the
 * client to adopt. GET /api/focus?sessionId=… → the current focus (for the chip).
 */

import { z } from "zod";
import { appendAudit, findIndexedFilesByName } from "@mnemos/db";
import { getDb } from "@/lib/runtime";
import { sessionKey, getFocus, getCited, setFocus, type FocusFile } from "@/lib/do-state";
import { isMetadataOnly, metadataOnlyText } from "@/lib/focus-util";
import { freshSession } from "@/lib/web-session";
import type { FocusResult } from "@/lib/do-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  sessionId: z.string().min(1),
  arg: z.string().max(500).optional(),
  done: z.boolean().optional(),
});

function audit(sessionId: string, data: Record<string, unknown>): void {
  try {
    appendAudit(getDb(), "do_focus", { channel: "web", sessionId, ...data });
  } catch {
    /* best effort */
  }
}

/** Transition to a fresh thread scoped to the picked file. Returns the new id. */
function focusOn(prevSessionId: string, file: FocusFile, via: string): FocusResult {
  const sid = freshSession();
  setFocus(sessionKey(sid), [file]);
  audit(prevSessionId, { fileId: file.fileId, name: file.name, via });
  const metadataOnly = isMetadataOnly(file.fileId);
  return {
    kind: "focused",
    name: file.name,
    sessionId: sid,
    metadataOnly,
    metaText: metadataOnly ? metadataOnlyText(file.fileId, file.name) : undefined,
  };
}

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ kind: "error", message: "invalid JSON" } satisfies FocusResult, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ kind: "error", message: "invalid request" } satisfies FocusResult, { status: 400 });
  }
  const { sessionId } = parsed.data;
  const key = sessionKey(sessionId);

  // /done — leave focus. The focused thread stays in history (resumable); a
  // fresh global thread starts only if we were actually focused.
  if (parsed.data.done) {
    const wasFocused = getFocus(key) !== null;
    return Response.json({
      kind: "off",
      wasFocused,
      sessionId: wasFocused ? freshSession() : null,
    } satisfies FocusResult);
  }

  const arg = (parsed.data.arg ?? "").trim();

  // Bare /focus → report the current scope.
  if (!arg) {
    return Response.json({ kind: "current", files: getFocus(key) } satisfies FocusResult);
  }

  // Numeric → pick from the last answer's cited sources of the CURRENT session.
  if (/^\d+$/.test(arg)) {
    const cited = getCited(key);
    const n = Number(arg);
    const pick = cited && n >= 1 && n <= cited.length ? cited[n - 1] : undefined;
    if (!pick) {
      return Response.json({
        kind: "none",
        message: "Ask a question first, then /focus <n> to scope to one of its listed sources.",
      } satisfies FocusResult);
    }
    return Response.json(focusOn(sessionId, pick, "focus-n"));
  }

  // By name → fuzzy-match indexed files.
  const matches = findIndexedFilesByName(getDb(), arg, 25);
  if (matches.length === 0) {
    return Response.json({
      kind: "none",
      message: `No indexed file matches "${arg}". Find and add it with /do fs ${arg}.`,
    } satisfies FocusResult);
  }
  if (matches.length > 1) {
    // Show full PATHS, not basenames — duplicate basenames (two `notes.md`) are
    // otherwise indistinguishable, and the matcher also matches on path, so the
    // user can retype with a folder segment to narrow.
    return Response.json({
      kind: "choose",
      matches: matches.slice(0, 8).map((m) => m.path),
      more: Math.max(0, matches.length - 8),
    } satisfies FocusResult);
  }
  const [first] = matches;
  if (!first) {
    return Response.json({ kind: "none", message: `No indexed file matches "${arg}".` } satisfies FocusResult);
  }
  return Response.json(focusOn(sessionId, { fileId: first.fileId, name: first.name }, "focus"));
}

/** GET /api/focus?sessionId=… → the current focus, for the chat's focus chip. */
export function GET(req: Request): Response {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return Response.json({ files: null });
  return Response.json({ files: getFocus(sessionKey(sessionId)) });
}
