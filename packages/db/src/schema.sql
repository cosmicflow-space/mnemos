-- Mnemos v0.1 database schema
-- One SQLite file holds: registered sources, ingested files, chunks (with vectors),
-- encrypted credentials, chat sessions, messages, and audit events.

-- Registered sources (the scope authorization primitive).
-- A source is anything Mnemos has been granted permission to index:
-- a local folder path, a single local file, a URL prefix, an email mailbox, etc.
CREATE TABLE IF NOT EXISTS source (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'folder',  -- 'folder' | 'file' | 'url' | 'mailbox' (v0.2+)
  scope       TEXT NOT NULL DEFAULT 'read-only',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- Auto re-scan cadence (ms). Default once daily; 0 = manual only. The web
  -- server's watcher periodically re-ingests due sources (incremental, so only
  -- changed files re-embed). last_scanned_at backs off the next due time.
  watch_interval_ms INTEGER NOT NULL DEFAULT 86400000,
  last_scanned_at   INTEGER,
  -- Ingest lease: epoch ms when a scan claimed this source, NULL when idle. An
  -- atomic conditional UPDATE on this column is the mutual-exclusion lock that
  -- keeps manual + auto (+ multi-process) ingests from running concurrently.
  ingesting_since   INTEGER
);

-- Ingested files (one row per file across all registered sources).
-- ingest_status tracks atomic ingestion: 'pending' before any chunks land,
-- 'partial' if an embed/loader error broke the chunk loop mid-file,
-- 'complete' only after every chunk for this file is inserted, and 'failed'
-- if hashing or loading failed outright. The skip-as-unchanged check
-- (pipeline.ts) requires status='complete' AND matching hash — this prevents
-- partial chunk sets from being treated as healthy on the next ingest.
CREATE TABLE IF NOT EXISTS file (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id         INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  path              TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  mtime             INTEGER NOT NULL,
  loader            TEXT NOT NULL,
  last_ingested_at  INTEGER NOT NULL,
  ingest_status     TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(source_id, path)
);
CREATE INDEX IF NOT EXISTS idx_file_source ON file(source_id);
-- NOTE: idx_file_status is created in client.ts:migrate() after the
-- ingest_status column is ensured to exist via ALTER TABLE. Don't add it
-- here — CREATE INDEX would fail on a pre-existing file table that hasn't
-- had the column added yet, and db.exec() of the schema would throw before
-- migrate() ever runs.

-- Chunks (one row per text chunk; vector lives in vec_chunk)
CREATE TABLE IF NOT EXISTS chunk (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  start_offset  INTEGER NOT NULL,
  end_offset    INTEGER NOT NULL,
  metadata      TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(file_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_chunk_file ON chunk(file_id);

-- Vector storage via sqlite-vec virtual table.
-- Dimension 384 is the v0.1 standard across all bundled embedding providers:
--   - embed-local (BGE-small-en-v1.5): 384 native
--   - Ollama (all-minilm): 384 native
--   - OpenAI (text-embedding-3-small with dimensions=384): Matryoshka truncation
-- Providers that natively use other dimensions adapt via truncation or model choice.
-- v0.2 will support multi-dimension installs via migration.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunk USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[384]
);

-- Encrypted credentials
CREATE TABLE IF NOT EXISTS credential (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  encrypted_data  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Chat sessions
CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  citations   TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  provider    TEXT,
  model       TEXT,
  latency_ms  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_message_session ON chat_message(session_id);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_event(event_type, created_at);

-- Verified answers: operator-confirmed Q→A pairs, injected as a trusted chunk
-- to boost retrieval (esp. for small models). The question embedding lives in
-- vec_verified. `source_hash` is the combined content hash of the chunks the
-- answer was grounded in, used for lazy invalidation when those chunks change.
CREATE TABLE IF NOT EXISTS verified_answer (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  question         TEXT NOT NULL,
  answer           TEXT NOT NULL,
  source_chunk_ids TEXT,
  source_hash      TEXT,
  provider         TEXT,
  model            TEXT,
  created_at       INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_verified USING vec0(
  answer_id INTEGER PRIMARY KEY,
  embedding FLOAT[384]
);

-- Schema version (for future migrations)
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, unixepoch() * 1000);
