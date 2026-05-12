/**
 * @mnemos/db
 *
 * SQLite + sqlite-vec storage layer. Single file at `~/.mnemos/mnemos.db`.
 *
 * Public API exports the typed client + entity types. Schema lives in schema.sql
 * and is applied via initSchema() on first open.
 */

export { openDb, type MnemosDb } from "./client.js";
export type {
  Folder,
  FileRow,
  Chunk,
  Credential,
  Session,
  ChatMessage,
  AuditEvent,
} from "./types.js";
