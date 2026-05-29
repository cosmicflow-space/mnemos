/**
 * @mnemos/db
 *
 * SQLite + sqlite-vec storage layer. Single file at `~/.mnemos/mnemos.db`.
 *
 * Public API: typed client + entity types + CRUD operations.
 * Schema lives in schema.sql and is applied via openDb() on first open.
 */

export { openDb, prepared, type MnemosDb } from "./client";

export type {
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

export {
  // Sources
  addSource,
  listSources,
  getSourceByPath,
  removeSource,
  // Files
  upsertFile,
  setFileIngestStatus,
  getFile,
  listFilesInSource,
  purgeFileChunks,
  // Chunks + vectors
  insertChunk,
  vecSearch,
  chunkCountBySource,
  countChunksForFile,
  ingestStatsBySource,
  type SourceIngestStats,
  getChunk,
  // Credentials
  upsertCredential,
  getCredentialByName,
  listCredentials,
  deleteCredential,
  // Sessions + messages
  createSession,
  getSession,
  setSessionTitle,
  listSessions,
  appendMessage,
  getRecentMessages,
  getUsageTotals,
  type UsageTotal,
  // Audit
  appendAudit,
  listAuditEvents,
  // Input types
  type UpsertFileInput,
  type InsertChunkInput,
  type UpsertCredentialInput,
  type AppendMessageInput,
  type SearchHit,
} from "./crud";
