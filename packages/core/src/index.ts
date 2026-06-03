/**
 * @mnemos/core
 *
 * The RAG runtime. Provider-agnostic, plugin-driven.
 *
 * Public API:
 *   - Plugin registry: loadBundledPlugins, getChatProvider, getEmbeddingProvider, getDocumentLoader
 *   - Crypto: encrypt/decrypt (AES-GCM for credentials at rest)
 *   - Ingest: scanFolder, ingestFolder, chunkText, hashFile, classifyFile
 *
 * Re-exports types from plugin-sdk and db for caller convenience.
 */

export const VERSION = "0.1.0";

// Registry
export {
  loadBundledPlugins,
  getChatProvider,
  getEmbeddingProvider,
  getDocumentLoader,
  PluginValidationError,
  DEFAULT_EMBEDDING_PROVIDER_ID,
  MNEMOS_EMBEDDING_DIM,
  type PluginRegistry,
} from "./registry";

// Crypto
export {
  generateEncryptionKey,
  encryptString,
  decryptString,
} from "./crypto";

// Ingestion
export { hashFile, hashString } from "./ingest/hash";
export { chunkText, type ChunkResult, type ChunkerOptions } from "./ingest/chunker";
export {
  classifyFile,
  listSupportedExtensions,
  type Classification,
  type FileCategory,
  type FileKind,
} from "./ingest/classify";
export {
  scanFolder,
  type ScanResult,
  type ScanSummary,
  type ScannedFile,
  type ScanOptions,
  type ExcludedFile,
  type ExclusionSummary,
  type LargeFileSummary,
} from "./ingest/scan";
export {
  checkExclusion,
  checkSecurityExclusion,
  shouldExclude,
  LARGE_FILE_BYTES,
  type ExclusionReason,
  type ExclusionVerdict,
  type IncludeOverrides,
} from "./ingest/exclude";
export {
  ingestFolder,
  estimateIngest,
  type IngestResult,
  type IngestProgress,
  type IngestFolderOptions,
} from "./ingest/pipeline";

// Query
export { runQuery, type QueryEvent, type RunQueryOptions } from "./query/runQuery";
export { assemblePrompt, wrapUntrusted, type AssembledPrompt, type UntrustedBlock } from "./query/prompt";

// Agent (mnemos-agent branch — bounded read-only loop, Phase 3). No command
// execution at this phase; tools only read. Provider-agnostic ReAct protocol.
export {
  runAgentLoop,
  parseModelTurn,
  type AgentEvent,
  type AgentLoopOptions,
} from "./agent/loop";
export {
  READ_ONLY_TOOLS,
  getTool,
  type AgentTool,
  type ToolContext,
  type ToolResult,
  type WorkspaceFs,
  type DirEntry,
  type GrepMatch,
} from "./agent/tools";
export { buildWorkspaceFs } from "./agent/workspace";

// Re-export plugin SDK types
export type {
  ChatProvider,
  EmbeddingProvider,
  DocumentLoader,
  Plugin,
  PluginManifest,
  ChatMessage,
  ChatOptions,
  ChatChunk,
  ModelInfo,
  CredentialSchema,
  CredentialField,
} from "@mnemos/plugin-sdk";

// Re-export db types
export type {
  Source,
  SourceKind,
  FileRow,
  Chunk,
  Credential,
  Session,
  AuditEvent,
  SearchHit,
} from "@mnemos/db";
