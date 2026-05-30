/**
 * CRUD operations for Mnemos data model.
 *
 * Sync API — better-sqlite3 is sync, and at personal-RAG scale this is faster
 * and simpler than async. Prepared statements are cached per-database.
 *
 * Functions are grouped by entity. Each takes the db handle as first arg so
 * callers can hold a single handle and reuse it across operations.
 */

import type { MnemosDb } from "./client";
import { prepared } from "./client";
import type {
  Source,
  SourceKind,
  FileRow,
  IngestStatus,
  Chunk,
  Credential,
  Session,
  ChatMessage,
  AuditEvent,
} from "./types";

// ============================================================================
// Sources (registered folders, URLs, etc.)
// ============================================================================

export function addSource(
  db: MnemosDb,
  path: string,
  kind: SourceKind = "folder",
): Source {
  const p = prepared(db);
  const now = Date.now();
  const result = p(
    `INSERT INTO source (path, kind, scope, created_at, updated_at)
     VALUES (?, ?, 'read-only', ?, ?)
     ON CONFLICT(path) DO UPDATE SET updated_at = excluded.updated_at
     RETURNING id, path, kind, scope, created_at, updated_at`,
  ).get(path, kind, now, now) as {
    id: number;
    path: string;
    kind: SourceKind;
    scope: "read-only";
    created_at: number;
    updated_at: number;
  };
  return {
    id: result.id,
    path: result.path,
    kind: result.kind,
    scope: result.scope,
    createdAt: result.created_at,
    updatedAt: result.updated_at,
  };
}

export function listSources(db: MnemosDb): Source[] {
  const rows = prepared(db)(
    `SELECT id, path, kind, scope, created_at, updated_at FROM source ORDER BY path`,
  ).all() as Array<{
    id: number;
    path: string;
    kind: SourceKind;
    scope: "read-only";
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    kind: r.kind,
    scope: r.scope,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getSourceByPath(db: MnemosDb, path: string): Source | null {
  const row = prepared(db)(
    `SELECT id, path, kind, scope, created_at, updated_at FROM source WHERE path = ?`,
  ).get(path) as
    | {
        id: number;
        path: string;
        kind: SourceKind;
        scope: "read-only";
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    scope: row.scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Remove a source and cascade-delete its files + chunks + vectors.
 * Returns the number of chunks purged from vec_chunk.
 */
export function removeSource(db: MnemosDb, path: string): { chunksPurged: number } {
  return db.transaction(() => {
    const source = getSourceByPath(db, path);
    if (!source) return { chunksPurged: 0 };

    // Purge vectors first (no foreign key on the virtual table)
    const purgeResult = prepared(db)(
      `DELETE FROM vec_chunk WHERE chunk_id IN (
         SELECT c.id FROM chunk c
         JOIN file f ON c.file_id = f.id
         WHERE f.source_id = ?
       )`,
    ).run(source.id);

    // Cascade-delete via foreign keys removes file + chunk rows
    prepared(db)(`DELETE FROM source WHERE id = ?`).run(source.id);

    return { chunksPurged: Number(purgeResult.changes) };
  })();
}

// ============================================================================
// Files
// ============================================================================

export type UpsertFileInput = {
  sourceId: number;
  path: string; // relative to source.path
  contentHash: string;
  sizeBytes: number;
  mtime: number;
  loader: string;
};

/**
 * Upsert a file row. Returns {fileId, changed, ingestStatus} where `changed`
 * is true if the content hash is new or different from what was last
 * ingested, and `ingestStatus` is the row's current status (used by the
 * pipeline to decide whether to skip).
 *
 * Note: when content has changed, status is reset to 'pending' so a
 * subsequent crash mid-ingest is correctly recoverable. A new file row is
 * inserted with status 'pending' by default (per schema DEFAULT).
 */
export function upsertFile(
  db: MnemosDb,
  input: UpsertFileInput,
): { fileId: number; changed: boolean; ingestStatus: IngestStatus } {
  const p = prepared(db);
  const existing = p(
    `SELECT id, content_hash, ingest_status FROM file WHERE source_id = ? AND path = ?`,
  ).get(input.sourceId, input.path) as
    | { id: number; content_hash: string; ingest_status: IngestStatus }
    | undefined;

  const now = Date.now();

  if (existing) {
    const changed = existing.content_hash !== input.contentHash;
    if (changed) {
      // Content changed → reset to pending; previous chunks will be purged
      // by the pipeline before re-chunking.
      p(
        `UPDATE file
         SET content_hash = ?, size_bytes = ?, mtime = ?, loader = ?,
             last_ingested_at = ?, ingest_status = 'pending'
         WHERE id = ?`,
      ).run(
        input.contentHash,
        input.sizeBytes,
        input.mtime,
        input.loader,
        now,
        existing.id,
      );
      return { fileId: existing.id, changed: true, ingestStatus: "pending" };
    } else {
      // Touch last_ingested_at even if unchanged so we know we checked
      p(`UPDATE file SET last_ingested_at = ? WHERE id = ?`).run(now, existing.id);
      return { fileId: existing.id, changed: false, ingestStatus: existing.ingest_status };
    }
  }

  const result = p(
    `INSERT INTO file (source_id, path, content_hash, size_bytes, mtime, loader, last_ingested_at, ingest_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    input.sourceId,
    input.path,
    input.contentHash,
    input.sizeBytes,
    input.mtime,
    input.loader,
    now,
  );
  return { fileId: Number(result.lastInsertRowid), changed: true, ingestStatus: "pending" };
}

/** Update a file's ingest_status. Called by the pipeline at status transitions. */
export function setFileIngestStatus(
  db: MnemosDb,
  fileId: number,
  status: IngestStatus,
): void {
  prepared(db)(`UPDATE file SET ingest_status = ? WHERE id = ?`).run(status, fileId);
}

type RawFileRow = {
  id: number;
  source_id: number;
  path: string;
  content_hash: string;
  size_bytes: number;
  mtime: number;
  loader: string;
  last_ingested_at: number;
  ingest_status: IngestStatus;
};

function mapFileRow(r: RawFileRow): FileRow {
  return {
    id: r.id,
    sourceId: r.source_id,
    path: r.path,
    contentHash: r.content_hash,
    sizeBytes: r.size_bytes,
    mtime: r.mtime,
    loader: r.loader,
    lastIngestedAt: r.last_ingested_at,
    ingestStatus: r.ingest_status,
  };
}

export function getFile(db: MnemosDb, fileId: number): FileRow | null {
  const row = prepared(db)(
    `SELECT id, source_id, path, content_hash, size_bytes, mtime, loader, last_ingested_at, ingest_status
     FROM file WHERE id = ?`,
  ).get(fileId) as RawFileRow | undefined;
  return row ? mapFileRow(row) : null;
}

export function listFilesInSource(db: MnemosDb, sourceId: number): FileRow[] {
  const rows = prepared(db)(
    `SELECT id, source_id, path, content_hash, size_bytes, mtime, loader, last_ingested_at, ingest_status
     FROM file WHERE source_id = ? ORDER BY path`,
  ).all(sourceId) as RawFileRow[];
  return rows.map(mapFileRow);
}

/** How many chunks exist for a file. Used by the pipeline to detect partial
 * ingestions (file row written but chunking crashed) so they re-process on
 * the next run instead of being silently treated as "unchanged". */
export function countChunksForFile(db: MnemosDb, fileId: number): number {
  const row = prepared(db)(
    `SELECT COUNT(*) AS n FROM chunk WHERE file_id = ?`,
  ).get(fileId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** The file's metadata chunk text (ordinal -1), or undefined if none exists.
 * Returning the text — not just existence — lets ingest detect when the chunk
 * is stale (e.g. mtime changed) and refresh it, while no-op'ing when unchanged. */
export function getMetadataChunkText(db: MnemosDb, fileId: number): string | undefined {
  const row = prepared(db)(
    `SELECT text FROM chunk WHERE file_id = ? AND ordinal = -1 LIMIT 1`,
  ).get(fileId) as { text: string } | undefined;
  return row?.text;
}

/** Delete a file's metadata chunk (ordinal -1) and its vector row. Used to
 * replace a stale metadata chunk before inserting a refreshed one. */
export function deleteMetadataChunk(db: MnemosDb, fileId: number): void {
  db.transaction(() => {
    prepared(db)(
      `DELETE FROM vec_chunk WHERE chunk_id IN (SELECT id FROM chunk WHERE file_id = ? AND ordinal = -1)`,
    ).run(fileId);
    prepared(db)(`DELETE FROM chunk WHERE file_id = ? AND ordinal = -1`).run(fileId);
  })();
}

/** Delete chunks belonging to a file before re-ingesting changed content. */
export function purgeFileChunks(db: MnemosDb, fileId: number): { chunksPurged: number } {
  return db.transaction(() => {
    const purgeResult = prepared(db)(
      `DELETE FROM vec_chunk WHERE chunk_id IN (SELECT id FROM chunk WHERE file_id = ?)`,
    ).run(fileId);
    prepared(db)(`DELETE FROM chunk WHERE file_id = ?`).run(fileId);
    return { chunksPurged: Number(purgeResult.changes) };
  })();
}

// ============================================================================
// Chunks + vectors
// ============================================================================

export type InsertChunkInput = {
  fileId: number;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, unknown>;
  embedding: number[]; // dimension must match vec_chunk schema (default 384)
};

/** Insert a chunk and its vector in one transaction. */
export function insertChunk(db: MnemosDb, input: InsertChunkInput): number {
  return db.transaction(() => {
    const now = Date.now();
    const result = prepared(db)(
      `INSERT INTO chunk (file_id, ordinal, text, start_offset, end_offset, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.fileId,
      input.ordinal,
      input.text,
      input.startOffset,
      input.endOffset,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    );
    const chunkId = Number(result.lastInsertRowid);
    // sqlite-vec's vec0 virtual table strictly requires BigInt for the primary
    // key binding — plain JS number fails with "Only integers are allows for
    // primary key values" even when the value IS an integer. The embedding
    // goes in as a JSON array literal.
    prepared(db)(
      `INSERT INTO vec_chunk (chunk_id, embedding) VALUES (?, ?)`,
    ).run(BigInt(chunkId), JSON.stringify(input.embedding));
    return chunkId;
  })();
}

export type SearchHit = {
  chunkId: number;
  fileId: number;
  filePath: string;
  sourceId: number;
  sourcePath: string;
  text: string;
  startOffset: number;
  endOffset: number;
  /** File modification time (epoch ms). Surfaced in the RAG prompt so the
   * model can answer "when" questions about indexed content. */
  fileMtime: number;
  /** Document loader used at ingest time (e.g. "pdf", "markdown"). Surfaced
   * in the prompt so the model knows the file kind without inferring from
   * the extension. */
  loader: string;
  fileSizeBytes: number;
  distance: number; // smaller = closer (cosine)
};

/** Vector search top-K with file + source metadata joined in. */
export function vecSearch(
  db: MnemosDb,
  queryEmbedding: number[],
  k = 8,
): SearchHit[] {
  const rows = prepared(db)(
    `SELECT
       v.chunk_id     AS chunkId,
       c.file_id      AS fileId,
       f.path         AS filePath,
       f.source_id    AS sourceId,
       s.path         AS sourcePath,
       c.text         AS text,
       c.start_offset AS startOffset,
       c.end_offset   AS endOffset,
       f.mtime        AS fileMtime,
       f.loader       AS loader,
       f.size_bytes   AS fileSizeBytes,
       v.distance     AS distance
     FROM vec_chunk v
     JOIN chunk c    ON v.chunk_id = c.id
     JOIN file  f    ON c.file_id  = f.id
     JOIN source s   ON f.source_id = s.id
     WHERE v.embedding MATCH ? AND k = ?
     ORDER BY v.distance`,
  ).all(JSON.stringify(queryEmbedding), k) as SearchHit[];
  return rows;
}

export type ChunkDetail = {
  chunkId: number;
  filePath: string;
  sourcePath: string;
  text: string;
  startOffset: number;
  endOffset: number;
  fileMtime: number;
};

/** Resolve chunk IDs (e.g. a chat message's stored citations) back to file +
 * location + text + mtime — powers the response-transparency panels (Sources /
 * Data sent) for chats reloaded from history. Returned in the order requested;
 * IDs that no longer exist (purged source) are dropped. */
export function getChunksByIds(db: MnemosDb, ids: number[]): ChunkDetail[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = prepared(db)(
    `SELECT c.id          AS chunkId,
            f.path        AS filePath,
            s.path        AS sourcePath,
            c.text        AS text,
            c.start_offset AS startOffset,
            c.end_offset   AS endOffset,
            f.mtime       AS fileMtime
       FROM chunk c
       JOIN file f   ON c.file_id   = f.id
       JOIN source s ON f.source_id = s.id
      WHERE c.id IN (${placeholders})`,
  ).all(...ids) as ChunkDetail[];
  const byId = new Map(rows.map((r) => [r.chunkId, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is ChunkDetail => Boolean(r));
}

// ============================================================================
// Verified answers (operator-confirmed Q→A memory)
// ============================================================================

export type SaveVerifiedAnswerInput = {
  question: string;
  answer: string;
  embedding: number[];
  sourceChunkIds: number[];
  /** Combined content hash of the grounding chunks (for lazy invalidation). */
  sourceHash: string;
  provider?: string | null;
  model?: string | null;
};

export function saveVerifiedAnswer(db: MnemosDb, input: SaveVerifiedAnswerInput): number {
  return db.transaction(() => {
    const now = Date.now();
    const result = prepared(db)(
      `INSERT INTO verified_answer
         (question, answer, source_chunk_ids, source_hash, provider, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.question,
      input.answer,
      JSON.stringify(input.sourceChunkIds),
      input.sourceHash,
      input.provider ?? null,
      input.model ?? null,
      now,
    );
    const id = Number(result.lastInsertRowid);
    // vec0 requires BigInt for the primary key; embedding goes in as JSON.
    prepared(db)(
      `INSERT INTO vec_verified (answer_id, embedding) VALUES (?, ?)`,
    ).run(BigInt(id), JSON.stringify(input.embedding));
    return id;
  })();
}

export type VerifiedMatch = {
  id: number;
  question: string;
  answer: string;
  sourceChunkIds: number[];
  sourceHash: string | null;
  provider: string | null;
  model: string | null;
  distance: number;
};

/** Nearest verified answers to a query embedding (cosine distance, ascending). */
export function searchVerifiedAnswers(
  db: MnemosDb,
  queryEmbedding: number[],
  k = 1,
): VerifiedMatch[] {
  const rows = prepared(db)(
    `SELECT va.id               AS id,
            va.question         AS question,
            va.answer           AS answer,
            va.source_chunk_ids AS sourceChunkIds,
            va.source_hash      AS sourceHash,
            va.provider         AS provider,
            va.model            AS model,
            v.distance          AS distance
       FROM vec_verified v
       JOIN verified_answer va ON v.answer_id = va.id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance`,
  ).all(JSON.stringify(queryEmbedding), k) as Array<{
    id: number;
    question: string;
    answer: string;
    sourceChunkIds: string | null;
    sourceHash: string | null;
    provider: string | null;
    model: string | null;
    distance: number;
  }>;
  return rows.map((r) => ({
    ...r,
    sourceChunkIds: r.sourceChunkIds ? (JSON.parse(r.sourceChunkIds) as number[]) : [],
  }));
}

export type VerifiedAnswerRow = {
  id: number;
  question: string;
  answer: string;
  provider: string | null;
  model: string | null;
  createdAt: number;
};

/** All verified answers, newest first (for the management UI). */
export function listVerifiedAnswers(db: MnemosDb): VerifiedAnswerRow[] {
  const rows = prepared(db)(
    `SELECT id, question, answer, provider, model, created_at
       FROM verified_answer ORDER BY created_at DESC`,
  ).all() as Array<{
    id: number;
    question: string;
    answer: string;
    provider: string | null;
    model: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    answer: r.answer,
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
  }));
}

export function deleteVerifiedAnswer(db: MnemosDb, id: number): void {
  db.transaction(() => {
    prepared(db)(`DELETE FROM vec_verified WHERE answer_id = ?`).run(BigInt(id));
    prepared(db)(`DELETE FROM verified_answer WHERE id = ?`).run(id);
  })();
}

/** Count chunks per source (UI status indicator). */
export function chunkCountBySource(db: MnemosDb): Map<number, number> {
  const rows = prepared(db)(
    `SELECT f.source_id AS sourceId, COUNT(c.id) AS count
     FROM chunk c JOIN file f ON c.file_id = f.id
     GROUP BY f.source_id`,
  ).all() as Array<{ sourceId: number; count: number }>;
  const map = new Map<number, number>();
  for (const row of rows) map.set(row.sourceId, row.count);
  return map;
}

/** Per-source ingestion stats — used by the UI to surface "last ingested 5
 * min ago" and "123 files indexed" without separately querying per row. */
export type SourceIngestStats = { fileCount: number; lastIngestedAt: number | null };

export function ingestStatsBySource(db: MnemosDb): Map<number, SourceIngestStats> {
  const rows = prepared(db)(
    `SELECT source_id AS sourceId,
            COUNT(*) AS fileCount,
            MAX(last_ingested_at) AS lastIngestedAt
     FROM file
     GROUP BY source_id`,
  ).all() as Array<{ sourceId: number; fileCount: number; lastIngestedAt: number | null }>;
  const map = new Map<number, SourceIngestStats>();
  for (const row of rows) {
    map.set(row.sourceId, {
      fileCount: row.fileCount,
      lastIngestedAt: row.lastIngestedAt,
    });
  }
  return map;
}

export function getChunk(db: MnemosDb, chunkId: number): Chunk | null {
  const row = prepared(db)(
    `SELECT id, file_id, ordinal, text, start_offset, end_offset, metadata, created_at
     FROM chunk WHERE id = ?`,
  ).get(chunkId) as
    | {
        id: number;
        file_id: number;
        ordinal: number;
        text: string;
        start_offset: number;
        end_offset: number;
        metadata: string | null;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    fileId: row.file_id,
    ordinal: row.ordinal,
    text: row.text,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}

// ============================================================================
// Credentials (encrypted)
// ============================================================================

export type UpsertCredentialInput = {
  name: string;
  type: string;
  encryptedData: string;
};

export function upsertCredential(db: MnemosDb, input: UpsertCredentialInput): Credential {
  const now = Date.now();
  const result = prepared(db)(
    `INSERT INTO credential (name, type, encrypted_data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       type = excluded.type,
       encrypted_data = excluded.encrypted_data,
       updated_at = excluded.updated_at
     RETURNING id, name, type, encrypted_data, created_at, updated_at`,
  ).get(input.name, input.type, input.encryptedData, now, now) as {
    id: number;
    name: string;
    type: string;
    encrypted_data: string;
    created_at: number;
    updated_at: number;
  };
  return {
    id: result.id,
    name: result.name,
    type: result.type,
    encryptedData: result.encrypted_data,
    createdAt: result.created_at,
    updatedAt: result.updated_at,
  };
}

export function getCredentialByName(db: MnemosDb, name: string): Credential | null {
  const row = prepared(db)(
    `SELECT id, name, type, encrypted_data, created_at, updated_at
     FROM credential WHERE name = ?`,
  ).get(name) as
    | {
        id: number;
        name: string;
        type: string;
        encrypted_data: string;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    encryptedData: row.encrypted_data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCredentials(db: MnemosDb): Credential[] {
  const rows = prepared(db)(
    `SELECT id, name, type, encrypted_data, created_at, updated_at
     FROM credential ORDER BY name`,
  ).all() as Array<{
    id: number;
    name: string;
    type: string;
    encrypted_data: string;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    encryptedData: r.encrypted_data,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function deleteCredential(db: MnemosDb, name: string): boolean {
  const result = prepared(db)(`DELETE FROM credential WHERE name = ?`).run(name);
  return Number(result.changes) > 0;
}

// ============================================================================
// Sessions + chat messages
// ============================================================================

export function createSession(db: MnemosDb, id: string, title?: string): Session {
  const now = Date.now();
  prepared(db)(
    `INSERT INTO session (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, title ?? null, now, now);
  return { id, title: title ?? null, createdAt: now, updatedAt: now };
}

export function getSession(db: MnemosDb, id: string): Session | null {
  const row = prepared(db)(
    `SELECT id, title, created_at, updated_at FROM session WHERE id = ?`,
  ).get(id) as
    | { id: string; title: string | null; created_at: number; updated_at: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Set a session's title. Called by /api/query after the first user message
 * lands so the sidebar shows "Stripe job description" instead of a raw
 * timestamp. */
export function setSessionTitle(db: MnemosDb, id: string, title: string): void {
  prepared(db)(`UPDATE session SET title = ? WHERE id = ?`).run(title, id);
}

export function listSessions(db: MnemosDb, limit = 50): Session[] {
  const rows = prepared(db)(
    `SELECT id, title, created_at, updated_at FROM session
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(limit) as Array<{
    id: string;
    title: string | null;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export type AppendMessageInput = {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  citations?: number[];
  tokensIn?: number;
  tokensOut?: number;
  provider?: string;
  model?: string;
  latencyMs?: number;
};

export function appendMessage(db: MnemosDb, input: AppendMessageInput): number {
  const now = Date.now();
  return db.transaction(() => {
    const result = prepared(db)(
      `INSERT INTO chat_message
         (session_id, role, content, citations, tokens_in, tokens_out, provider, model, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.role,
      input.content,
      input.citations ? JSON.stringify(input.citations) : null,
      input.tokensIn ?? null,
      input.tokensOut ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.latencyMs ?? null,
      now,
    );
    prepared(db)(`UPDATE session SET updated_at = ? WHERE id = ?`).run(
      now,
      input.sessionId,
    );
    return Number(result.lastInsertRowid);
  })();
}

export function getRecentMessages(
  db: MnemosDb,
  sessionId: string,
  n = 10,
): ChatMessage[] {
  const rows = prepared(db)(
    `SELECT id, session_id, role, content, citations, tokens_in, tokens_out, provider, model, latency_ms, created_at
     FROM chat_message
     WHERE session_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(sessionId, n) as Array<{
    id: number;
    session_id: string;
    role: "user" | "assistant";
    content: string;
    citations: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    provider: string | null;
    model: string | null;
    latency_ms: number | null;
    created_at: number;
  }>;
  return rows
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      citations: r.citations ? (JSON.parse(r.citations) as number[]) : null,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      provider: r.provider,
      model: r.model,
      latencyMs: r.latency_ms,
      createdAt: r.created_at,
    }))
    .reverse(); // oldest first for prompt-assembly convenience
}

export type UsageTotal = {
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  messages: number;
};

/** All-time token totals grouped by (provider, model), summed across every
 * session. The caller multiplies by per-model pricing to show cumulative cost
 * — kept as raw tokens here so pricing stays in the provider plugins. */
export function getUsageTotals(db: MnemosDb): UsageTotal[] {
  const rows = prepared(db)(
    `SELECT provider, model,
            COALESCE(SUM(tokens_in), 0)  AS tin,
            COALESCE(SUM(tokens_out), 0) AS tout,
            COUNT(*)                     AS n
       FROM chat_message
      WHERE role = 'assistant'
      GROUP BY provider, model`,
  ).all() as Array<{
    provider: string | null;
    model: string | null;
    tin: number;
    tout: number;
    n: number;
  }>;
  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    tokensIn: r.tin,
    tokensOut: r.tout,
    messages: r.n,
  }));
}

// ============================================================================
// Audit
// ============================================================================

export function appendAudit(
  db: MnemosDb,
  eventType: string,
  data: Record<string, unknown>,
): number {
  const now = Date.now();
  const result = prepared(db)(
    `INSERT INTO audit_event (event_type, data, created_at) VALUES (?, ?, ?)`,
  ).run(eventType, JSON.stringify(data), now);
  return Number(result.lastInsertRowid);
}

export function listAuditEvents(
  db: MnemosDb,
  opts: { since?: number; limit?: number; eventType?: string } = {},
): AuditEvent[] {
  const limit = opts.limit ?? 100;
  const since = opts.since ?? 0;
  let sql =
    `SELECT id, event_type, data, created_at FROM audit_event WHERE created_at >= ?`;
  const params: Array<number | string> = [since];
  if (opts.eventType) {
    sql += ` AND event_type = ?`;
    params.push(opts.eventType);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = prepared(db)(sql).all(...params) as Array<{
    id: number;
    event_type: string;
    data: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    data: JSON.parse(r.data) as Record<string, unknown>,
    createdAt: r.created_at,
  }));
}
