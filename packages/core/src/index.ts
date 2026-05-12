/**
 * @mnemos/core
 *
 * The RAG runtime. Provider-agnostic, plugin-driven.
 *
 * Public API:
 *   - Plugin registry: loadBundledPlugins, getChatProvider, getEmbeddingProvider, getDocumentLoader
 *   - Crypto: encrypt/decrypt (AES-GCM for credentials at rest)
 *   - Pipeline: ingest + query (coming in next pass)
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
} from "./registry.js";

// Crypto
export {
  generateEncryptionKey,
  encryptString,
  decryptString,
} from "./crypto.js";

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
  Folder,
  FileRow,
  Chunk,
  Credential,
  Session,
  AuditEvent,
  SearchHit,
} from "@mnemos/db";
