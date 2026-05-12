/**
 * @mnemos/core
 *
 * The RAG runtime. Provider-agnostic.
 *
 * Pipeline stages (each is a discrete module):
 *   - ingest/   File loading, hashing, chunking, embedding, upsert
 *   - query/    Embed query, retrieve, assemble prompt, generate, cite
 *   - memory/   Conversation buffer
 *   - audit/    Append-only audit log
 *   - registry/ Plugin loading + provider lookup
 *
 * v0.1 ships skeletons here. Implementation lands incrementally in the next pass.
 */

export const VERSION = "0.1.0";

// Re-export plugin SDK types for convenience
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
} from "@mnemos/plugin-sdk";

// Re-export db types
export type {
  Folder,
  FileRow,
  Chunk,
  Credential,
  Session,
  AuditEvent,
} from "@mnemos/db";

// Stub exports — to be filled in next pass
export const __coming_in_next_pass__ = [
  "ingest.ingestFolder()",
  "query.runQuery()",
  "registry.loadPlugins()",
  "registry.getChatProvider()",
  "registry.getEmbeddingProvider()",
  "audit.append()",
] as const;
