/**
 * Mnemos SQLite client.
 *
 * Wraps better-sqlite3 with the sqlite-vec extension loaded. Applies the schema
 * on first open. WAL mode + busy_timeout for safe concurrent reads.
 *
 * Synchronous API by design — better-sqlite3 is synchronous, and for personal RAG
 * scale (10K-1M chunks on one machine) sync is faster and simpler than async.
 */

import Database, { type Database as BetterSqliteDb, type Statement } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// NOTE: `better-sqlite3`, `sqlite-vec`, and `bindings` MUST be webpack-external
// — see `webpack.externals` in `apps/web/next.config.js`. The `bindings`
// package walks Error.stack to find its caller's .node addon; webpack-rewritten
// stack frames break that lookup (fileName ends up undefined → `.indexOf`
// crash inside bindings.js:178). Externalizing them sends the require through
// Node's native loader where the stack is intact.

export type MnemosDb = BetterSqliteDb;

export type OpenDbOptions = {
  /** Absolute path to the SQLite file. Created if missing. */
  path: string;
  /** Embedding dimension if creating fresh. Default 1536 (OpenAI text-embedding-3-small). */
  embeddingDim?: number;
  /** If true, apply schema.sql on open. Default true. */
  applySchema?: boolean;
};

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
);

export function openDb(opts: OpenDbOptions): MnemosDb {
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  sqliteVec.load(db);

  if (opts.applySchema !== false) {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    db.exec(schema);
    migrate(db);
  }

  return db;
}

/**
 * Light-touch migration runner. Runs after schema.exec so new tables/indexes
 * created via CREATE IF NOT EXISTS are in place; this function then patches
 * existing rows or columns that the IF-NOT-EXISTS form can't address.
 */
function migrate(db: BetterSqliteDb): void {
  // m1: file.ingest_status column. CREATE TABLE IF NOT EXISTS won't add a
  // column to an already-existing file table, so we ADD it conditionally.
  // The corresponding idx_file_status index also lives here (not in
  // schema.sql) — putting it in schema.sql would make db.exec(schema) throw
  // on first open of a pre-existing DB because the index would reference a
  // column the IF-NOT-EXISTS CREATE TABLE can't add.
  const cols = db
    .prepare("PRAGMA table_info(file)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "ingest_status")) {
    db.exec(
      "ALTER TABLE file ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'pending'",
    );
    db.exec(`
      UPDATE file
      SET ingest_status = 'complete'
      WHERE id IN (SELECT DISTINCT file_id FROM chunk)
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_file_status ON file(ingest_status)");
    // eslint-disable-next-line no-console
    console.log("[mnemos/db migrate] m1: file.ingest_status added; existing rows with chunks marked 'complete'.");
  }

  // m3: source watch columns. Added so existing DBs gain background re-scan
  // scheduling. watch_interval_ms defaults to once daily; last_scanned_at is
  // left NULL so the watcher treats already-registered sources as due once
  // (a cheap incremental re-ingest) on next tick.
  const srcCols = db
    .prepare("PRAGMA table_info(source)")
    .all() as Array<{ name: string }>;
  if (!srcCols.some((c) => c.name === "watch_interval_ms")) {
    db.exec(
      "ALTER TABLE source ADD COLUMN watch_interval_ms INTEGER NOT NULL DEFAULT 86400000",
    );
    // eslint-disable-next-line no-console
    console.log("[mnemos/db migrate] m3: source.watch_interval_ms added (default daily).");
  }
  if (!srcCols.some((c) => c.name === "last_scanned_at")) {
    db.exec("ALTER TABLE source ADD COLUMN last_scanned_at INTEGER");
  }
  if (!srcCols.some((c) => c.name === "ingesting_since")) {
    db.exec("ALTER TABLE source ADD COLUMN ingesting_since INTEGER");
  }

  // m2: backfill session.title from the session's first user message for
  // any pre-existing session that doesn't have a title yet. New sessions get
  // a title server-side at /api/query time; this rescues the legacy ones so
  // the sidebar shows meaningful labels everywhere.
  const titleless = db
    .prepare("SELECT COUNT(*) AS n FROM session WHERE title IS NULL OR title = ''")
    .get() as { n: number };
  if (titleless.n > 0) {
    const rows = db
      .prepare(
        `SELECT s.id AS sessionId,
                (SELECT content FROM chat_message
                  WHERE session_id = s.id AND role = 'user'
                  ORDER BY created_at ASC LIMIT 1) AS firstMsg
         FROM session s
         WHERE s.title IS NULL OR s.title = ''`,
      )
      .all() as Array<{ sessionId: string; firstMsg: string | null }>;
    const update = db.prepare("UPDATE session SET title = ? WHERE id = ?");
    for (const r of rows) {
      if (!r.firstMsg) continue;
      const cleaned = r.firstMsg.replace(/\s+/g, " ").trim();
      if (cleaned.length === 0) continue;
      const truncated = cleaned.length <= 50 ? cleaned : cleaned.slice(0, 50);
      const lastSpace = truncated.lastIndexOf(" ");
      const cut = lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated;
      const title = cleaned.length <= 50 ? cut : cut.replace(/[.,;:!?\-]+$/, "") + "…";
      update.run(title, r.sessionId);
    }
    // eslint-disable-next-line no-console
    console.log(`[mnemos/db migrate] m2: backfilled ${rows.length} session title(s).`);
  }
}

/**
 * Prepared statement cache helper. Avoid re-preparing the same SQL.
 */
export function prepared(db: MnemosDb): (sql: string) => Statement {
  const cache = new Map<string, Statement>();
  return (sql: string) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
}
