/**
 * `/do` per-conversation state: the selection buffer and the pending-PIN action.
 *
 * The buffer is the producer→consumer bridge (DO.md §4): `/do fs` fills it with
 * numbered absolute paths; `/do rag <sel>` reads it. The pending action parks a
 * write that is waiting for a PIN reply. Both are keyed per conversation
 * (`tg:<chatId>` or `web:<sessionId>`), ephemeral, and last-write-wins — exactly
 * the semantics the architecture calls for. Stored in `mnemos.db` so they survive
 * a restart; tables are created lazily (CREATE TABLE IF NOT EXISTS), no migration.
 */

import { getDb } from "./runtime";

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS do_buffer (
        chat_key   TEXT PRIMARY KEY,
        verb       TEXT NOT NULL,
        items      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS do_pending (
        chat_key   TEXT PRIMARY KEY,
        action     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS do_rag_status (
        chat_key   TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        detail     TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS do_focus (
        chat_key   TEXT PRIMARY KEY,
        files      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    ready = true;
  }
  return d;
}

const PENDING_TTL_MS = 5 * 60_000;

export function setBuffer(key: string, verb: string, items: string[]): void {
  db()
    .prepare(
      `INSERT INTO do_buffer (chat_key, verb, items, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET verb = excluded.verb, items = excluded.items, created_at = excluded.created_at`,
    )
    .run(key, verb, JSON.stringify(items), Date.now());
}

export function getBuffer(key: string): { verb: string; items: string[] } | null {
  const row = db().prepare(`SELECT verb, items FROM do_buffer WHERE chat_key = ?`).get(key) as
    | { verb: string; items: string }
    | undefined;
  if (!row) return null;
  try {
    const items = JSON.parse(row.items) as string[];
    return Array.isArray(items) ? { verb: row.verb, items } : null;
  } catch {
    return null;
  }
}

export type PendingAction = { verb: "rag"; paths: string[] };

export function setPending(key: string, action: PendingAction): void {
  db()
    .prepare(
      `INSERT INTO do_pending (chat_key, action, created_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET action = excluded.action, created_at = excluded.created_at`,
    )
    .run(key, JSON.stringify(action), Date.now());
}

export function getPending(key: string): PendingAction | null {
  const row = db().prepare(`SELECT action, created_at FROM do_pending WHERE chat_key = ?`).get(key) as
    | { action: string; created_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > PENDING_TTL_MS) {
    clearPending(key);
    return null;
  }
  try {
    return JSON.parse(row.action) as PendingAction;
  } catch {
    return null;
  }
}

export function clearPending(key: string): void {
  db().prepare(`DELETE FROM do_pending WHERE chat_key = ?`).run(key);
}

export type RagState = "chunking" | "done" | "error";
export type RagStatus = { state: RagState; detail: Record<string, unknown>; updatedAt: number };

export function setRagStatus(key: string, state: RagState, detail: Record<string, unknown>): void {
  db()
    .prepare(
      `INSERT INTO do_rag_status (chat_key, state, detail, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at`,
    )
    .run(key, state, JSON.stringify(detail), Date.now());
}

export function getRagStatus(key: string): RagStatus | null {
  const row = db().prepare(`SELECT state, detail, updated_at FROM do_rag_status WHERE chat_key = ?`).get(key) as
    | { state: RagState; detail: string; updated_at: number }
    | undefined;
  if (!row) return null;
  try {
    return { state: row.state, detail: JSON.parse(row.detail) as Record<string, unknown>, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

// ── File Focus Mode ────────────────────────────────────────────────────────
// The active file scope for a conversation: subsequent questions answer only
// from these file(s) until `/done`. Persisted so focus survives a restart.
export type FocusFile = { fileId: number; name: string };

export function setFocus(key: string, files: FocusFile[]): void {
  db()
    .prepare(
      `INSERT INTO do_focus (chat_key, files, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET files = excluded.files, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(files), Date.now());
}

export function getFocus(key: string): FocusFile[] | null {
  const row = db().prepare(`SELECT files FROM do_focus WHERE chat_key = ?`).get(key) as { files: string } | undefined;
  if (!row) return null;
  try {
    const files = JSON.parse(row.files) as FocusFile[];
    return Array.isArray(files) && files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/** Clear focus; returns true if a focus was actually active. */
export function clearFocus(key: string): boolean {
  const res = db().prepare(`DELETE FROM do_focus WHERE chat_key = ?`).run(key);
  return res.changes > 0;
}

// The files cited by the LAST normal answer, in display order — so the user can
// reply `/focus <n>` to scope to one of them. Reuses the do_focus table's row by
// a distinct key suffix to avoid another table.
function citedKey(key: string): string {
  return `${key}#cited`;
}

export function setCited(key: string, files: FocusFile[]): void {
  setFocus(citedKey(key), files);
}

export function getCited(key: string): FocusFile[] | null {
  return getFocus(citedKey(key));
}

export function clearCited(key: string): void {
  clearFocus(citedKey(key));
}
