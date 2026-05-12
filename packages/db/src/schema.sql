-- Mnemos v0.1 database schema
-- One SQLite file holds: paired folders, ingested files, chunks (with vectors),
-- encrypted credentials, chat sessions, messages, and audit events.

-- Paired folders (the scope authorization primitive)
CREATE TABLE IF NOT EXISTS folder (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,
  scope       TEXT NOT NULL DEFAULT 'read-only',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Ingested files (one row per file across all paired folders)
CREATE TABLE IF NOT EXISTS file (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id         INTEGER NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
  path              TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  mtime             INTEGER NOT NULL,
  loader            TEXT NOT NULL,
  last_ingested_at  INTEGER NOT NULL,
  UNIQUE(folder_id, path)
);
CREATE INDEX IF NOT EXISTS idx_file_folder ON file(folder_id);

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

-- Schema version (for future migrations)
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, unixepoch() * 1000);
