/**
 * POST /api/do — the web surface of the `/do` verb dispatcher (bare discovery,
 * read-tier finders like `fs`, the PIN-gated `rag` write, and PIN bootstrap).
 * GET  /api/do?sessionId=… — poll the current rag-ingest status (the web mirror
 * of Telegram's "I'll say when they're ready" follow-up).
 *
 * The security-relevant decisions (selection→paths, the PIN/anomaly write-gate)
 * come from lib/do-commands, shared verbatim with the Telegram poller — neither
 * surface can widen what the other allows.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { appendAudit, createSession, clearDevIndex } from "@mnemos/db";
import { getDb } from "@/lib/runtime";
import { listVerbs, runVerb } from "@/lib/do-runner";
import { resolveRag, ragGate } from "@/lib/do-commands";
import {
  sessionKey,
  setBuffer,
  setPending,
  getPending,
  clearPending,
  setRagStatus,
  getRagStatus,
  setFocus,
} from "@/lib/do-state";
import { pinExists, setPin, verify as verifyPin } from "@/lib/do-pin";
import { addPathsToRag } from "@/lib/do-rag";
import type { DoResult, RagStatusWire } from "@/lib/do-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DO_WEB_LIMIT = 200; // the web can render a longer match list than Telegram

const Body = z.object({
  sessionId: z.string().min(1),
  /** Text after "/do " — e.g. "fs land rover", "rag 1-3", "pin 123456", "". */
  input: z.string().max(2000).optional(),
  /** A 6-digit reply answering a pending PIN gate (the web PIN modal). */
  pin: z.string().regex(/^\d{6}$/).optional(),
});

function audit(sessionId: string, event: string, data: Record<string, unknown>): void {
  try {
    appendAudit(getDb(), event, { channel: "web", sessionId, ...data });
  } catch {
    /* audit must not break the action */
  }
}

/**
 * Kick the ingest in the BACKGROUND and return immediately (Mnemos runs as a
 * persistent Node server, so the fire-and-forget promise resolves on the event
 * loop after the response — same pattern as the Telegram poller). On completion,
 * auto-focus opens a fresh thread; its id is recorded in the status row so the
 * polling client adopts it. Status stays under the ORIGINATING session's key.
 */
function startWebRag(sessionId: string, paths: string[]): void {
  const key = sessionKey(sessionId);
  const names = paths.map((p) => p.split("/").pop() ?? p);
  setRagStatus(key, "chunking", { files: names });

  void addPathsToRag(paths)
    .then((outcome) => {
      let focusedSessionId: string | undefined;
      let focusName: string | undefined;
      if (outcome.focus.length > 0) {
        // A freshly-added file starts its own clean thread (focus on a new session).
        focusedSessionId = randomUUID();
        createSession(getDb(), focusedSessionId);
        setFocus(sessionKey(focusedSessionId), outcome.focus);
        focusName =
          outcome.focus.length === 1 && outcome.focus[0]
            ? outcome.focus[0].name
            : `${outcome.focus.length} files`;
        audit(sessionId, "do_focus", { count: outcome.focus.length, via: "rag" });
      }
      setRagStatus(key, "done", {
        added: outcome.added.length,
        updated: outcome.updated.length,
        unchanged: outcome.unchanged.length,
        failed: outcome.failed.length,
        chunks: outcome.chunks,
        files: names,
        focusedSessionId,
        focusName,
      });
      audit(sessionId, "do_rag_done", {
        added: outcome.added.length,
        updated: outcome.updated.length,
        unchanged: outcome.unchanged.length,
        failed: outcome.failed.length,
        chunks: outcome.chunks,
      });
    })
    .catch((err) => {
      setRagStatus(key, "error", { message: err instanceof Error ? err.message : String(err) });
    });
}

function handleRag(sessionId: string, arg: string): DoResult {
  const key = sessionKey(sessionId);
  const sel = resolveRag(key, arg);
  if (sel.kind === "empty") {
    return { kind: "message", text: "Nothing to add yet — run /do fs <name> first, then /do rag <n>." };
  }
  if (sel.kind === "error") return { kind: "error", message: sel.message };
  if (sel.kind === "none") return { kind: "message", text: "No files selected." };

  const { paths } = sel;
  const gate = ragGate(paths);
  const anomaly = gate.kind === "pin" || gate.kind === "ready" ? gate.anomaly : false;
  audit(sessionId, "do_rag_attempt", { count: paths.length, anomaly, prompted: gate.kind === "pin" });

  if (gate.kind === "setup") return { kind: "rag-setup" };
  if (gate.kind === "locked") return { kind: "rag-locked", ms: gate.ms };
  if (gate.kind === "ready") {
    startWebRag(sessionId, paths);
    return { kind: "rag-started", startedFrom: sessionId };
  }
  // A PIN is required — park the write for the modal reply.
  setPending(key, { verb: "rag", paths });
  return { kind: "rag-pin", count: paths.length, anomaly: gate.anomaly };
}

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ kind: "error", message: "invalid JSON" } satisfies DoResult, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ kind: "error", message: "invalid request" } satisfies DoResult, { status: 400 });
  }
  const { sessionId } = parsed.data;
  const key = sessionKey(sessionId);

  // ── A 6-digit reply answering a parked write (the PIN modal) ──────────────
  if (parsed.data.pin) {
    const pending = getPending(key);
    if (!pending) {
      return Response.json({ kind: "message", text: "Nothing is waiting for a PIN." } satisfies DoResult);
    }
    const res = verifyPin(parsed.data.pin);
    audit(sessionId, "do_pin", {
      ok: res.ok,
      locked: !res.ok && res.lockedMs != null,
      attemptsLeft: !res.ok ? (res.attemptsLeft ?? null) : null,
    });
    if (!res.ok) {
      clearPending(key);
      return Response.json({
        kind: "pin-bad",
        attemptsLeft: res.attemptsLeft,
        lockedMs: res.lockedMs,
      } satisfies DoResult);
    }
    clearPending(key);
    startWebRag(sessionId, pending.paths);
    return Response.json({ kind: "rag-started", startedFrom: sessionId } satisfies DoResult);
  }

  const input = (parsed.data.input ?? "").trim();

  // ── Bare /do → discovery ──────────────────────────────────────────────────
  if (!input) {
    const verbs = await listVerbs();
    return Response.json({
      kind: "verbs",
      verbs: verbs.map((v) => ({ name: v.name, summary: v.summary })),
    } satisfies DoResult);
  }

  const sp = input.indexOf(" ");
  const verb = (sp === -1 ? input : input.slice(0, sp)).trim().toLowerCase();
  const arg = sp === -1 ? "" : input.slice(sp + 1).trim();

  if (verb === "rag") return Response.json(handleRag(sessionId, arg));

  // ── /do pin <6 digits> — one-time bootstrap (web is the recommended place) ──
  if (verb === "pin") {
    const digits = arg.trim();
    if (!/^\d{6}$/.test(digits)) {
      return Response.json({ kind: "message", text: "Usage: /do pin <6 digits> — e.g. /do pin 246810" } satisfies DoResult);
    }
    if (pinExists()) {
      return Response.json({ kind: "message", text: "A PIN is already set. Change it in Settings → Telegram." } satisfies DoResult);
    }
    setPin(digits);
    audit(sessionId, "do_pin_set", { via: "web" });
    return Response.json({ kind: "pin-set" } satisfies DoResult);
  }

  if (verb === "status") {
    const status = getRagStatus(key);
    return Response.json({ kind: "message", text: statusText(status) } satisfies DoResult);
  }

  // ── /do dev … — DEV-mode maintenance (web-only; never over Telegram) ────────
  if (verb === "dev") return Response.json(handleDev(sessionId, arg));

  // ── A read-tier script verb (e.g. fs) — its output fills the buffer ─────────
  const res = await runVerb(verb, arg);
  if (!res.ok) return Response.json({ kind: "error", message: res.error } satisfies DoResult);
  if (res.lines.length === 0) {
    return Response.json({ kind: "message", text: `No files match "${arg}".` } satisfies DoResult);
  }
  setBuffer(key, verb, res.lines);
  audit(sessionId, "do_verb", { verb, arg, resultCount: res.lines.length, truncated: res.truncated });
  return Response.json({
    kind: "matches",
    verb,
    arg,
    count: res.lines.length,
    items: res.lines.slice(0, DO_WEB_LIMIT),
    truncated: res.truncated || res.lines.length > DO_WEB_LIMIT,
  } satisfies DoResult);
}

/**
 * `/do dev <sub>` — destructive DEV-mode maintenance, guarded by a two-step
 * `--confirmed`. Web-only (the dispatcher for Telegram never routes here), and
 * it never touches source files on disk. The `dev` namespace is intentionally
 * open for future subcommands (e.g. `dev remove <file>` to drop one file).
 *
 * Scope note: a `/do rag` ingest already running in the background when `clear`
 * is confirmed can re-add sources after the wipe (the worker is fire-and-forget,
 * not cancellable). This is acceptable for a deliberate single-operator DEV reset
 * — don't fire a clear mid-ingest — and avoids threading a cancellation token
 * through the ingest path for a maintenance command. Re-run clear if it happens.
 */
function handleDev(sessionId: string, arg: string): DoResult {
  const parts = arg.split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "").toLowerCase();
  const confirmed = parts.slice(1).includes("--confirmed");

  if (sub === "clear") {
    if (!confirmed) {
      return {
        kind: "dev-confirm",
        text:
          "⚠️ This will remove ALL your chat history, every chunk in the RAG, and all source/file references in the database. " +
          "Use this only when experimenting in DEV mode. It will NOT delete your source files.\n\n" +
          "Reply with  --confirmed  to proceed.",
      } satisfies DoResult;
    }
    const before = clearDevIndex(getDb());
    audit(sessionId, "do_dev_clear", { ...before, via: "web" });
    return {
      kind: "dev-cleared",
      removed: { chunks: before.chunks, sources: before.sources, sessions: before.sessions },
      text: `✅ Cleared the DEV index — removed ${before.chunks} chunks, ${before.sources} source${before.sources === 1 ? "" : "s"}, and ${before.sessions} chat session${before.sessions === 1 ? "" : "s"}. Your source files were not touched.`,
    } satisfies DoResult;
  }

  return {
    kind: "message",
    text: "Usage: /do dev clear — wipes the DEV index (chunks, sources, history) after you confirm with --confirmed. Source files are never deleted.",
  } satisfies DoResult;
}

function statusText(status: ReturnType<typeof getRagStatus>): string {
  if (!status) return "Nothing added yet. Use /do fs <name>, then /do rag <n>.";
  const ago = Math.max(0, Math.round((Date.now() - status.updatedAt) / 1000));
  if (status.state === "chunking") return `Chunking now (started ${ago}s ago).`;
  if (status.state === "error") return `Last add failed: ${String(status.detail.message ?? "unknown")}`;
  const chunks = typeof status.detail.chunks === "number" ? status.detail.chunks : 0;
  return `Ready (${ago}s ago) — ${chunks} chunk(s) embedded, searchable now.`;
}

/** GET /api/do?sessionId=… → the current rag-ingest status row, for polling. */
export function GET(req: Request): Response {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return Response.json({ status: null });
  const status = getRagStatus(sessionKey(sessionId));
  return Response.json({ status: (status as RagStatusWire) ?? null });
}
