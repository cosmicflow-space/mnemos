/**
 * @mnemos/db
 *
 * SQLite + sqlite-vec storage layer. Single file at `~/.mnemos/mnemos.db`.
 *
 * Public API: typed client + entity types + CRUD operations.
 * Schema lives in schema.sql and is applied via openDb() on first open.
 */

export { openDb, prepared, type MnemosDb } from "./client.js";

export type {
  Source,
  SourceKind,
  FileRow,
  Chunk,
  Credential,
  Session,
  ChatMessage,
  AuditEvent,
} from "./types.js";

export {
  // Sources
  addSource,
  listSources,
  getSourceByPath,
  removeSource,
  // Files
  upsertFile,
  getFile,
  listFilesInSource,
  purgeFileChunks,
  // Chunks + vectors
  insertChunk,
  vecSearch,
  chunkCountBySource,
  getChunk,
  // Credentials
  upsertCredential,
  getCredentialByName,
  listCredentials,
  deleteCredential,
  // Sessions + messages
  createSession,
  getSession,
  listSessions,
  appendMessage,
  getRecentMessages,
  // Audit
  appendAudit,
  listAuditEvents,
  // Input types
  type UpsertFileInput,
  type InsertChunkInput,
  type UpsertCredentialInput,
  type AppendMessageInput,
  type SearchHit,
} from "./crud.js";
