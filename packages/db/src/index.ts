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
  TelegramChat,
  TelegramState,
} from "./types";

export {
  // Sources
  addSource,
  listSources,
  getSourceByPath,
  removeSource,
  setSourceWatchInterval,
  setSourcePaused,
  touchSourceScanned,
  listDueSources,
  tryClaimIngest,
  releaseIngest,
  DEFAULT_WATCH_INTERVAL_MS,
  STALE_INGEST_MS,
  // Files
  upsertFile,
  setFileIngestStatus,
  getFile,
  listFilesInSource,
  purgeFileChunks,
  // Chunks + vectors
  insertChunk,
  vecSearch,
  getContentChunksForFile,
  findIndexedFilesByName,
  fileContentChars,
  getFileLocation,
  getCorpusStats,
  getChunksByIds,
  type ChunkDetail,
  // Verified answers
  saveVerifiedAnswer,
  searchVerifiedAnswers,
  listVerifiedAnswers,
  deleteVerifiedAnswer,
  type SaveVerifiedAnswerInput,
  type VerifiedMatch,
  type VerifiedAnswerRow,
  chunkCountBySource,
  countChunksForFile,
  getMetadataChunkText,
  deleteMetadataChunk,
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
  getSessionUsage,
  type SessionUsageRow,
  getModelLatencyStats,
  type ModelLatencyStat,
  // Audit
  appendAudit,
  listAuditEvents,
  // Telegram channel
  getTelegramState,
  setTelegramEnabled,
  setTelegramOffset,
  setTelegramPairingCode,
  consumeTelegramPairingCode,
  addTelegramChat,
  isTelegramChatPaired,
  listTelegramChats,
  removeTelegramChat,
  getTelegramChatSession,
  setTelegramChatSession,
  // Input types
  type UpsertFileInput,
  type InsertChunkInput,
  type UpsertCredentialInput,
  type AppendMessageInput,
  type SearchHit,
  type IndexedFile,
  type FileLocation,
} from "./crud";
