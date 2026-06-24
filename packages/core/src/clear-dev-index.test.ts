/**
 * `clearDevIndex` — the DEV-mode "/do dev clear" wipe.
 *
 * Guards the two things partner review flagged as critical: the lazily-created
 * `do_*` working-set tables must be swept (no FK to `session`, so the cascade
 * never reaches them), and the wipe must NOT touch the Telegram pairing,
 * credentials, or run when those `do_*` tables were never created.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDb,
  type MnemosDb,
  addSource,
  upsertFile,
  insertChunk,
  createSession,
  appendMessage,
  addTelegramChat,
  setTelegramChatSession,
  upsertCredential,
  getCredentialByName,
  clearDevIndex,
} from "@mnemos/db";

/** Mirror the web layer's lazy `do_*` tables (apps/web/lib/do-state.ts). */
function createDoTables(db: MnemosDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS do_buffer (chat_key TEXT PRIMARY KEY, verb TEXT NOT NULL, items TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS do_pending (chat_key TEXT PRIMARY KEY, action TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS do_rag_status (chat_key TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS do_focus (chat_key TEXT PRIMARY KEY, files TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
}

function seedIndex(db: MnemosDb, sessionId: string): void {
  const source = addSource(db, "/tmp/corpus", "folder");
  const { fileId } = upsertFile(db, {
    sourceId: source.id,
    path: "a.txt",
    contentHash: "h1",
    sizeBytes: 10,
    mtime: 1,
    loader: "plaintext",
  });
  insertChunk(db, {
    fileId,
    ordinal: 0,
    text: "hello world",
    startOffset: 0,
    endOffset: 11,
    embedding: new Array(384).fill(0.1),
  });
  createSession(db, sessionId);
  appendMessage(db, { sessionId, role: "user", content: "hi" });
}

describe("clearDevIndex", () => {
  let tempDir: string;
  let db: MnemosDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mnemos-devclear-"));
    db = openDb({ path: join(tempDir, "test.db") });
  });
  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("wipes index + history and reports the before-counts", () => {
    createDoTables(db);
    seedIndex(db, "sess-1");

    const before = clearDevIndex(db);
    expect(before.chunks).toBe(1);
    expect(before.sources).toBe(1);
    expect(before.sessions).toBe(1);
    expect(before.messages).toBe(1);

    const count = (sql: string) => Number((db.prepare(sql).get() as { c: number }).c);
    expect(count("SELECT COUNT(*) c FROM chunk")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM source")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM file")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM session")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM chat_message")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM vec_chunk")).toBe(0);
  });

  it("sweeps the lazily-created do_* working-set tables (orphan fix)", () => {
    createDoTables(db);
    db.prepare("INSERT INTO do_buffer (chat_key, verb, items, created_at) VALUES (?,?,?,?)").run("sess:sess-1", "fs", "[]", 1);
    db.prepare("INSERT INTO do_focus (chat_key, files, updated_at) VALUES (?,?,?)").run("sess:sess-1", "[]", 1);
    db.prepare("INSERT INTO do_rag_status (chat_key, state, detail, updated_at) VALUES (?,?,?,?)").run("sess:sess-1", "done", "{}", 1);
    db.prepare("INSERT INTO do_pending (chat_key, action, created_at) VALUES (?,?,?)").run("sess:sess-1", "{}", 1);

    clearDevIndex(db);

    const count = (t: string) => Number((db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c);
    expect(count("do_buffer")).toBe(0);
    expect(count("do_focus")).toBe(0);
    expect(count("do_rag_status")).toBe(0);
    expect(count("do_pending")).toBe(0);
  });

  it("does not throw when the do_* tables were never created", () => {
    seedIndex(db, "sess-1");
    expect(() => clearDevIndex(db)).not.toThrow();
  });

  it("preserves the Telegram pairing (nulls the session link) and credentials", () => {
    createDoTables(db);
    seedIndex(db, "sess-1");
    addTelegramChat(db, 12345, "phone");
    setTelegramChatSession(db, 12345, "sess-1");
    upsertCredential(db, { name: "anthropic", type: "api_key", encryptedData: "enc-blob" });

    clearDevIndex(db);

    const tg = db.prepare("SELECT chat_id, session_id FROM telegram_chat WHERE chat_id = 12345").get() as
      | { chat_id: number; session_id: string | null }
      | undefined;
    expect(tg).toBeDefined();
    expect(tg?.session_id).toBeNull();
    expect(getCredentialByName(db, "anthropic")?.encryptedData).toBe("enc-blob");
  });
});
