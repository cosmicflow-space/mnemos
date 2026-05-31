/**
 * Shared runtime singleton.
 *
 * The plugin registry, DB connection, and default embedder are created once
 * per process and cached here. API routes import these getters; they pay the
 * construction cost on the first call and reuse on subsequent calls.
 *
 * In Next.js dev mode the module is re-evaluated on hot reload, so handles
 * may be re-opened. better-sqlite3 handles this fine.
 */

import {
  loadBundledPlugins,
  getEmbeddingProvider,
  DEFAULT_EMBEDDING_PROVIDER_ID,
  type PluginRegistry,
} from "@mnemos/core";
import { openDb, type MnemosDb } from "@mnemos/db";
import type { EmbeddingProvider } from "@mnemos/plugin-sdk";
import { createWorkerEmbedder, terminateWorkerEmbedder } from "./worker-embedder";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

let cachedRegistry: PluginRegistry | null = null;
let cachedDb: MnemosDb | null = null;
let cachedEmbedder: EmbeddingProvider | null = null;
let cachedEmbedderInit: Promise<EmbeddingProvider> | null = null;

export function getRegistry(): PluginRegistry {
  if (!cachedRegistry) {
    cachedRegistry = loadBundledPlugins();
  }
  return cachedRegistry;
}

export function getStateDir(): string {
  const dir = process.env.MNEMOS_STATE_DIR ?? join(homedir(), ".mnemos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDb(): MnemosDb {
  if (!cachedDb) {
    const path = process.env.MNEMOS_DB_PATH ?? join(getStateDir(), "mnemos.db");
    cachedDb = openDb({ path });
  }
  return cachedDb;
}

/**
 * Returns an initialized default embedding provider. v0.1 default is
 * embed-local (BGE-small via ONNX, no external services). The first call
 * triggers model-weights download (~130MB, cached in HF transformers dir);
 * subsequent calls return the same initialized instance.
 *
 * Override the default by setting MNEMOS_DEFAULT_EMBEDDING in env.
 */
export async function getDefaultEmbedder(): Promise<EmbeddingProvider> {
  if (cachedEmbedder) return cachedEmbedder;
  if (cachedEmbedderInit) return cachedEmbedderInit;

  cachedEmbedderInit = (async () => {
    const registry = getRegistry();
    const id =
      process.env.MNEMOS_DEFAULT_EMBEDDING ?? DEFAULT_EMBEDDING_PROVIDER_ID;
    const provider = getEmbeddingProvider(registry, id);
    // Bundled local provider takes no credentials; frontier providers need
    // an API key. For v0.1 we initialize with empty creds and let the
    // provider throw if it needs them.
    const credentials: Record<string, string> = {};
    if (id === "openai" && process.env.OPENAI_API_KEY) {
      credentials.apiKey = process.env.OPENAI_API_KEY;
    }
    if (id === "ollama" && process.env.OLLAMA_BASE_URL) {
      credentials.baseURL = process.env.OLLAMA_BASE_URL;
    }
    // Local embedding is CPU-bound and blocks the event loop when run inline,
    // starving the API during a large ingest. Offload it to a worker thread so
    // the main thread stays responsive. Frontier embedders are network I/O —
    // they don't block — so they run inline as before. Escape hatch:
    // MNEMOS_EMBED_INLINE=1 forces the in-process provider.
    const embedder =
      id === "embed-local" && process.env.MNEMOS_EMBED_INLINE !== "1"
        ? createWorkerEmbedder(provider.credentialSchema)
        : provider;
    await embedder.initialize(credentials);
    cachedEmbedder = embedder;
    return embedder;
  })();

  return cachedEmbedderInit;
}

/** For tests: reset all singletons. */
export function __resetRuntimeForTests(): void {
  if (cachedDb) cachedDb.close();
  cachedDb = null;
  cachedRegistry = null;
  cachedEmbedder = null;
  cachedEmbedderInit = null;
  terminateWorkerEmbedder(); // tear down the globalThis-pinned worker too
}
