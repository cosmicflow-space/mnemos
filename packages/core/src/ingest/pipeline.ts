/**
 * Ingestion pipeline orchestrator.
 *
 * Walks a registered source, for each supported file:
 *   1. Compute SHA-256 hash; upsert file row
 *   2. If content unchanged since last ingest, skip (incremental ingestion)
 *   3. Otherwise: pick loader by extension, load text, chunk, embed (batched),
 *      purge old chunks for this file, insert new chunks + vectors
 *
 * Emits progress events via an optional callback so the UI can show
 * "Embedding chunk 247/1,847 from notes/2024-q3.md..." in real time.
 */

import { stat } from "node:fs/promises";
import {
  type MnemosDb,
  upsertFile,
  insertChunk,
  purgeFileChunks,
  appendAudit,
} from "@mnemos/db";
import type { EmbeddingProvider } from "@mnemos/plugin-sdk";
import { hashFile } from "./hash";
import { chunkText } from "./chunker";
import { scanFolder } from "./scan";
import { getDocumentLoader, type PluginRegistry } from "../registry";

export type IngestProgress =
  | { phase: "scan-start"; rootPath: string }
  | { phase: "scan-complete"; totalFiles: number; supportedFiles: number }
  | { phase: "file-start"; filePath: string; current: number; total: number }
  | { phase: "file-skipped"; filePath: string; reason: "unchanged" | "load-error"; current: number; total: number }
  | { phase: "file-chunked"; filePath: string; chunkCount: number; current: number; total: number }
  | { phase: "file-embedded"; filePath: string; chunkCount: number; current: number; total: number }
  | { phase: "file-complete"; filePath: string; chunkCount: number; current: number; total: number }
  | { phase: "done"; filesProcessed: number; chunksCreated: number; filesSkipped: number; durationMs: number };

export type IngestResult = {
  filesProcessed: number;
  filesSkipped: number;
  chunksCreated: number;
  durationMs: number;
  errors: Array<{ filePath: string; message: string }>;
};

export type IngestFolderOptions = {
  /** Batch size for embedding API calls. Default 32. */
  embedBatchSize?: number;
  /** Progress callback. Called on every phase change. */
  onProgress?: (progress: IngestProgress) => void;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
};

export async function ingestFolder(
  db: MnemosDb,
  registry: PluginRegistry,
  embedder: EmbeddingProvider,
  source: { id: number; path: string },
  opts: IngestFolderOptions = {},
): Promise<IngestResult> {
  const start = Date.now();
  const batchSize = opts.embedBatchSize ?? 32;
  const onProgress = opts.onProgress ?? (() => {});

  onProgress({ phase: "scan-start", rootPath: source.path });
  const scan = await scanFolder(source.path);
  const supported = scan.files.filter(
    (f) => f.classification.category === "supported",
  );
  onProgress({
    phase: "scan-complete",
    totalFiles: scan.files.length,
    supportedFiles: supported.length,
  });

  const errors: Array<{ filePath: string; message: string }> = [];
  let filesProcessed = 0;
  let filesSkipped = 0;
  let chunksCreated = 0;

  for (let i = 0; i < supported.length; i += 1) {
    if (opts.signal?.aborted) break;

    const file = supported[i];
    if (!file) continue;
    const current = i + 1;
    const total = supported.length;
    onProgress({ phase: "file-start", filePath: file.relativePath, current, total });

    // 1. Hash + upsert file metadata. Skip embedding if unchanged.
    let contentHash: string;
    try {
      contentHash = await hashFile(file.absolutePath);
    } catch (err) {
      errors.push({
        filePath: file.relativePath,
        message: `hash failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      onProgress({ phase: "file-skipped", filePath: file.relativePath, reason: "load-error", current, total });
      continue;
    }

    const loaderId = file.classification.loaderId;
    if (!loaderId) {
      filesSkipped += 1;
      onProgress({ phase: "file-skipped", filePath: file.relativePath, reason: "load-error", current, total });
      continue;
    }

    const fileStat = await stat(file.absolutePath);
    const upsertResult = upsertFile(db, {
      sourceId: source.id,
      path: file.relativePath,
      contentHash,
      sizeBytes: fileStat.size,
      mtime: fileStat.mtimeMs,
      loader: loaderId,
    });

    if (!upsertResult.changed) {
      filesSkipped += 1;
      onProgress({ phase: "file-skipped", filePath: file.relativePath, reason: "unchanged", current, total });
      continue;
    }

    // 2. Load file via the appropriate loader plugin.
    let docText: string;
    try {
      const loader = getDocumentLoader(registry, loaderId);
      const loaded = await loader.load(file.absolutePath);
      docText = loaded.text;
    } catch (err) {
      errors.push({
        filePath: file.relativePath,
        message: `load failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      onProgress({ phase: "file-skipped", filePath: file.relativePath, reason: "load-error", current, total });
      continue;
    }

    // 3. Chunk + embed + replace. Purge old chunks first for clean re-ingest.
    purgeFileChunks(db, upsertResult.fileId);

    const chunks = chunkText(docText);
    onProgress({ phase: "file-chunked", filePath: file.relativePath, chunkCount: chunks.length, current, total });

    if (chunks.length === 0) {
      filesProcessed += 1;
      onProgress({ phase: "file-complete", filePath: file.relativePath, chunkCount: 0, current, total });
      continue;
    }

    // Embed in batches to amortize API round-trips for frontier providers.
    let embeddedSoFar = 0;
    for (let b = 0; b < chunks.length; b += batchSize) {
      if (opts.signal?.aborted) break;
      const batch = chunks.slice(b, b + batchSize);
      let vectors: number[][];
      try {
        vectors = await embedder.embed(batch.map((c) => c.text));
      } catch (err) {
        errors.push({
          filePath: file.relativePath,
          message: `embed failed at chunk ${b}: ${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }
      for (let k = 0; k < batch.length; k += 1) {
        const chunk = batch[k];
        const vector = vectors[k];
        if (!chunk || !vector) continue;
        insertChunk(db, {
          fileId: upsertResult.fileId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          embedding: vector,
        });
        chunksCreated += 1;
        embeddedSoFar += 1;
      }
      onProgress({
        phase: "file-embedded",
        filePath: file.relativePath,
        chunkCount: embeddedSoFar,
        current,
        total,
      });
    }

    filesProcessed += 1;
    onProgress({
      phase: "file-complete",
      filePath: file.relativePath,
      chunkCount: embeddedSoFar,
      current,
      total,
    });
  }

  const durationMs = Date.now() - start;
  appendAudit(db, "ingest", {
    sourceId: source.id,
    sourcePath: source.path,
    filesProcessed,
    filesSkipped,
    chunksCreated,
    errors: errors.length,
    durationMs,
  });

  onProgress({
    phase: "done",
    filesProcessed,
    chunksCreated,
    filesSkipped,
    durationMs,
  });

  return { filesProcessed, filesSkipped, chunksCreated, durationMs, errors };
}
