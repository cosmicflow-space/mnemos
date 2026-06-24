/**
 * Wire contract for the web `/do`, `/focus`, and `/reindex` routes.
 *
 * Types ONLY — no Node imports — so the client chat component and the server
 * routes can share the exact same shapes without pulling server code into the
 * browser bundle. The Telegram poller renders the same decisions as text; the
 * web renders these objects as chat bubbles / a PIN modal.
 */

export type CitedFileWire = { fileId: number; name: string };

/** Result of POST /api/do — the verb dispatcher (bare / fs / rag / pin). */
export type DoResult =
  | { kind: "verbs"; verbs: { name: string; summary: string }[] }
  | { kind: "matches"; verb: string; arg: string; count: number; items: string[]; truncated: boolean }
  | { kind: "rag-started"; startedFrom: string } // ingest kicked off — poll status
  | { kind: "rag-pin"; count: number; anomaly: boolean } // a PIN is required
  | { kind: "rag-setup" } // no PIN configured yet — bootstrap one
  | { kind: "rag-locked"; ms: number }
  | { kind: "pin-set" }
  | { kind: "pin-bad"; attemptsLeft?: number; lockedMs?: number }
  | { kind: "message"; text: string } // generic info (empty buffer, nothing selected…)
  | { kind: "dev-confirm"; text: string } // destructive op — needs `--confirmed`
  | { kind: "dev-cleared"; removed: { chunks: number; sources: number; sessions: number }; text: string }
  | { kind: "error"; message: string };

/** rag-status row, plus the session the auto-focus moved to (if any) so the
 * polling client can adopt it. */
export type RagStatusWire = {
  state: "chunking" | "done" | "error";
  detail: Record<string, unknown>;
  updatedAt: number;
  /** Set once ingest completes and auto-focus opened a fresh thread. */
  focusedSessionId?: string;
};

/** Result of POST /api/focus. A focus transition opens a fresh thread, so the
 * client switches to the returned sessionId. */
export type FocusResult =
  | { kind: "focused"; name: string; sessionId: string; metadataOnly: boolean; metaText?: string }
  | { kind: "choose"; matches: string[]; more: number }
  | { kind: "none"; message: string }
  | { kind: "current"; files: CitedFileWire[] | null }
  | { kind: "off"; sessionId: string | null; wasFocused: boolean }
  | { kind: "error"; message: string };

/** Result of POST /api/reindex. */
export type ReindexResult =
  | { kind: "readable"; name: string; sessionId: string } // re-extracted — fresh focused thread
  | { kind: "still-empty"; name: string; reason: string }
  | { kind: "no-focus" }
  | { kind: "error"; name?: string; message: string };
