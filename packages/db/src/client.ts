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
  }

  return db;
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
