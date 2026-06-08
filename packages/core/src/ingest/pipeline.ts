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
  setFileIngestStatus,
  insertChunk,
  purgeFileChunks,
  getMetadataChunkText,
  deleteMetadataChunk,
  fileContentChars,
  appendAudit,
} from "@mnemos/db";

// Below this many chars of indexed content, a file is "metadata-only" — used by
// repairMetadataOnly to decide which files to re-extract.
const METADATA_ONLY_CHARS = 20;
import type { EmbeddingProvider } from "@mnemos/plugin-sdk";
import { hashFile } from "./hash";
import { chunkText } from "./chunker";
import { scanFolder } from "./scan";
import { shouldExclude, LARGE_FILE_BYTES, type IncludeOverrides } from "./exclude";
import { getDocumentLoader, type PluginRegistry } from "../registry";

export type IngestProgress =
  | { phase: "scan-start"; rootPath: string }
  | { phase: "scan-complete"; totalFiles: number; supportedFiles: number; estimatedChunks: number; estimatedSeconds: number }
  | { phase: "file-start"; filePath: string; current: number; total: number }
  | { phase: "file-skipped"; filePath: string; reason: "unchanged" | "load-error" | "deferred"; current: number; total: number }
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

/**
 * Rough pre-ingest estimate (chunk count + seconds) from scanned files, so the UI
 * can show "~14k chunks · ~30 min" before committing. Bytes→chunks ratios are
 * per-type approximations — PDF/office text is a fraction of file bytes, images
 * OCR to roughly one chunk — and the embed rate is a conservative local-CPU
 * constant. Approximate by design: a planning signal, not a promise.
 */
export function estimateIngest(
  files: Array<{ sizeBytes: number; classification: { kind: string } }>,
): { chunks: number; seconds: number } {
  const CHUNK_BYTES = 700; // ~ chunker output size for plain text
  const EMBED_PER_SEC = 8; // conservative local-CPU embed throughput
  let chunks = 0;
  for (const f of files) {
    if (f.classification.kind === "image") {
      chunks += 2; // OCR ≈ 1 content chunk + 1 metadata chunk
      continue;
    }
    const ratio =
      f.classification.kind === "pdf" ? 0.35 : f.classification.kind === "docx" || f.classification.kind === "xlsx" ? 0.4 : 1;
    chunks += Math.max(1, Math.ceil((f.sizeBytes * ratio) / CHUNK_BYTES)) + 1; // +1 metadata chunk
  }
  return { chunks, seconds: Math.ceil(chunks / EMBED_PER_SEC) };
}

export type IngestFilters = {
  /** Labels (from Classification.label) to skip for this ingest. */
  excludeLabels?: string[];
  /** Default-noise tiers to opt INTO (logs, lockfiles, minified, transient). */
  includeOverrides?: IncludeOverrides;
  /** If false, files > 10 MB are skipped. Default true (include everything). */
  includeLargeFiles?: boolean;
};

export type IngestFolderOptions = {
  /** Batch size for embedding API calls. Default 32. */
  embedBatchSize?: number;
  /**
   * Optional *extra* fixed delay (ms) after each embed batch. After every batch
   * the pipeline always yields one event-loop turn (`setImmediate`) so pending
   * API requests (queries, config save, pause) get serviced before the next
   * batch — adaptive by nature: it costs ~nothing when the queue is empty and
   * lets real requests through when it isn't. This option adds a *deliberate*
   * sleep on top (to throttle CPU, e.g. background ingest while you work).
   * Default 0. Override with the `MNEMOS_INGEST_THROTTLE_MS` env var.
   */
  embedThrottleMs?: number;
  /**
   * Defer files larger than this many bytes — they're skipped in THIS run (with a
   * `file-skipped`/`deferred` event) so small files index fast. The caller then
   * kicks a background run with no limit to pick up the large ones (hash-skipping
   * the small ones already done). Undefined = no deferral.
   */
  deferOverBytes?: number;
  /** Progress callback. Called on every phase change. */
  onProgress?: (progress: IngestProgress) => void;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** User-chosen filters from the scan-result UI. */
  filters?: IngestFilters;
  /** Re-attempt files previously marked `failed` even if unchanged. Set by
   * user-initiated runs (manual re-scan / resume); the background watcher leaves
   * it off so a poison/oversized/offline file isn't re-burned every tick. */
  retryFailed?: boolean;
  /** Force re-extraction even when a file is unchanged AND already complete —
   * bypasses the hash-skip so the loader runs again. Used by `/reindex` to retry
   * a file that ended up metadata-only (e.g. after a loader was improved). */
  force?: boolean;
  /** Re-extract ONLY the files in this source that are currently metadata-only
   * (no readable content) — leaving healthy files hash-skipped. Lets `/reindex`
   * cheaply repair empty files without re-embedding the whole source. */
  repairMetadataOnly?: boolean;
  /** Process ONLY the file at this source-relative path (skip all others in the
   * scan). Lets `/reindex` re-extract a single focused file without touching the
   * rest of a folder source. */
  onlyRelPath?: string;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Natural-language metadata sentence for a file — embedded as its own chunk so
 * metadata questions ("how big", "when modified", "what type") retrieve it. */
function fileMetadataText(
  relativePath: string,
  sizeBytes: number,
  mtimeMs: number,
  loader: string,
): string {
  const name = relativePath.split("/").pop() ?? relativePath;
  const modified = new Date(mtimeMs).toISOString().slice(0, 10);
  return `File metadata for "${name}" (path: ${relativePath}). Size: ${humanSize(sizeBytes)} (${sizeBytes} bytes). Last modified: ${modified}. Type: ${loader}.`;
}

/** Ensure the file's metadata chunk (ordinal -1) reflects its current path,
 * size, mtime, and type. No-ops when the stored chunk already matches (so
 * steady-state re-scans cost one cheap SELECT and zero embeds); refreshes it
 * when the text has drifted (e.g. a touch changed mtime without changing
 * content, which takes the skip path). Also backfills files that predate this
 * feature. Best-effort — never throws into the caller. Returns true only when a
 * NEW chunk was inserted (i.e. there was none before), so callers can count it. */
async function upsertMetadataChunk(
  db: MnemosDb,
  embedder: EmbeddingProvider,
  fileId: number,
  relativePath: string,
  sizeBytes: number,
  mtimeMs: number,
  loader: string,
): Promise<boolean> {
  try {
    const text = fileMetadataText(relativePath, sizeBytes, mtimeMs, loader);
    const existing = getMetadataChunkText(db, fileId);
    if (existing === text) return false; // already current — no embed needed
    const [vec] = await embedder.embed([text]);
    if (!vec) return false;
    // Replace any stale chunk first — ordinal -1 is UNIQUE(file_id, ordinal),
    // so a refresh must delete the old row (and its vector) before inserting.
    if (existing !== undefined) deleteMetadataChunk(db, fileId);
    insertChunk(db, {
      fileId,
      ordinal: -1,
      text,
      startOffset: 0,
      endOffset: text.length,
      embedding: vec,
    });
    return existing === undefined; // count only first-time inserts, not refreshes
  } catch {
    return false;
  }
}

export async function ingestFolder(
  db: MnemosDb,
  registry: PluginRegistry,
  embedder: EmbeddingProvider,
  source: { id: number; path: string },
  opts: IngestFolderOptions = {},
): Promise<IngestResult> {
  const start = Date.now();
  const batchSize = opts.embedBatchSize ?? 32;
  const envThrottle = Number(process.env.MNEMOS_INGEST_THROTTLE_MS);
  const throttleMs = opts.embedThrottleMs ?? (Number.isFinite(envThrottle) ? envThrottle : 0);
  const onProgress = opts.onProgress ?? (() => {});

  const filters = opts.filters ?? {};
  const includeLargeFiles = filters.includeLargeFiles ?? true;
  const excludeLabels = new Set(filters.excludeLabels ?? []);

  onProgress({ phase: "scan-start", rootPath: source.path });
  const scan = await scanFolder(source.path);

  // Apply user filters on top of the scan's default exclusions.
  // scan.files now includes soft-excluded files (tagged with f.exclusion);
  // shouldExclude(relativePath, overrides) re-evaluates whether to keep them
  // given the user's per-tier opt-ins. Hard-locked security files were never
  // in scan.files in the first place.
  const candidates = scan.files.filter((f) => {
    // Single-file targeting (`/reindex` of one focused file): skip everything else.
    if (opts.onlyRelPath != null && f.relativePath !== opts.onlyRelPath) return false;
    if (f.classification.category !== "supported") return false;
    if (excludeLabels.has(f.classification.label)) return false;
    if (!includeLargeFiles && f.sizeBytes > LARGE_FILE_BYTES) return false;
    // Honors per-tier user overrides: if the file was soft-excluded but the
    // user opted that tier in, this returns null (include); otherwise the
    // file is filtered out here.
    return shouldExclude(f.relativePath, filters.includeOverrides) === null;
  });

  // Defer files over the threshold to a later background run (the caller kicks it
  // with no limit, hash-skipping these small ones). `supported` is what we index
  // now; deferred large files are reported as skipped so the UI can say so.
  const deferOverBytes = opts.deferOverBytes;
  const supported =
    deferOverBytes != null ? candidates.filter((f) => f.sizeBytes <= deferOverBytes) : candidates;

  // Ingest smallest-first so quick wins are queryable in seconds instead of being
  // blocked behind a 50-page PDF. Pure ordering — doesn't change what gets indexed.
  supported.sort((a, b) => a.sizeBytes - b.sizeBytes);

  const estimate = estimateIngest(supported);
  onProgress({
    phase: "scan-complete",
    totalFiles: scan.files.length,
    supportedFiles: supported.length,
    estimatedChunks: estimate.chunks,
    estimatedSeconds: estimate.seconds,
  });

  if (deferOverBytes != null) {
    for (const f of candidates) {
      if (f.sizeBytes > deferOverBytes) {
        onProgress({
          phase: "file-skipped",
          filePath: f.relativePath,
          reason: "deferred",
          current: 0,
          total: supported.length,
        });
      }
    }
  }

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

    // A previously-failed file (load-error) is skipped on AUTO re-scans so a
    // poison / oversized / offline-OCR file isn't re-attempted (and re-burned)
    // every watcher tick. A user-initiated run (retryFailed) re-attempts it, as
    // does any content change (hash differs → not skipped here).
    if (
      !upsertResult.changed &&
      upsertResult.ingestStatus === "failed" &&
      !opts.retryFailed &&
      !opts.repairMetadataOnly &&
      !opts.force
    ) {
      filesSkipped += 1;
      onProgress({ phase: "file-skipped", filePath: file.relativePath, reason: "load-error", current, total });
      continue;
    }

    // Skip only when the file is genuinely unchanged AND was previously
    // ingested to completion. Pending/partial states force a re-process even
    // when the hash hasn't moved — this is the atomic-ingest guarantee that
    // prevents mid-file crashes from leaving permanently corrupt indexes.
    // repairMetadataOnly re-extracts only files that are currently empty (so an
    // improved loader can recover them) while leaving healthy files hash-skipped.
    const repairThisFile =
      opts.repairMetadataOnly === true &&
      !upsertResult.changed &&
      upsertResult.ingestStatus === "complete" &&
      fileContentChars(db, upsertResult.fileId) < METADATA_ONLY_CHARS;

    if (!opts.force && !repairThisFile && !upsertResult.changed && upsertResult.ingestStatus === "complete") {
      // Backfill the metadata chunk for files ingested before this feature
      // existed. upsertMetadataChunk no-ops if one is already present, so this
      // re-embeds nothing on steady-state re-scans — it only fills the gap once.
      if (
        await upsertMetadataChunk(
          db,
          embedder,
          upsertResult.fileId,
          file.relativePath,
          fileStat.size,
          fileStat.mtimeMs,
          loaderId,
        )
      ) {
        chunksCreated += 1;
      }
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
      // Mark failed so an AUTO re-scan won't re-attempt (and re-burn on) this
      // file every tick; a user-initiated run (retryFailed) or a content change
      // re-attempts it.
      setFileIngestStatus(db, upsertResult.fileId, "failed");
      onProgress({ phase: "file-skipped", filePath: file.relativePath, reason: "load-error", current, total });
      continue;
    }

    // 3. Chunk + embed + replace. Purge old chunks first for clean re-ingest.
    purgeFileChunks(db, upsertResult.fileId);

    const chunks = chunkText(docText);
    onProgress({ phase: "file-chunked", filePath: file.relativePath, chunkCount: chunks.length, current, total });

    if (chunks.length === 0) {
      // Empty/near-empty file: no content chunks, but it's still a real file the
      // user may ask about ("how big is X"). Give it its metadata chunk so the
      // "every ingested file is retrievable by metadata" contract holds, then
      // mark complete so it's stable on re-scan (purge above already cleared any
      // stale metadata chunk).
      if (
        await upsertMetadataChunk(
          db,
          embedder,
          upsertResult.fileId,
          file.relativePath,
          fileStat.size,
          fileStat.mtimeMs,
          loaderId,
        )
      ) {
        chunksCreated += 1;
      }
      setFileIngestStatus(db, upsertResult.fileId, "complete");
      filesProcessed += 1;
      onProgress({ phase: "file-complete", filePath: file.relativePath, chunkCount: 0, current, total });
      continue;
    }

    // Embed in batches to amortize API round-trips for frontier providers.
    let embeddedSoFar = 0;
    let embedFailed = false;
    for (let b = 0; b < chunks.length; b += batchSize) {
      if (opts.signal?.aborted) break;
      const batch = chunks.slice(b, b + batchSize);
      let vectors: number[][];
      try {
        vectors = await embedder.embed(batch.map((c) => c.text));
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        errors.push({
          filePath: file.relativePath,
          message: `embed failed at chunk ${b}: ${msg}`,
        });
        embedFailed = true;
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
      // Hand the event loop a turn between batches: setImmediate lets the poll
      // phase drain any pending I/O (queued API requests) before we resume, so a
      // large file's embed can't starve queries/config/pause. It's adaptive —
      // ~free when nothing is queued, yields when something is. throttleMs adds
      // an optional deliberate sleep on top for CPU throttling.
      await new Promise((r) => setImmediate(r));
      // Skip the deliberate throttle the moment a pause/cancel lands so it doesn't
      // add to abort latency (the loop's top-of-iteration check then breaks).
      if (throttleMs > 0 && !opts.signal?.aborted) {
        await new Promise((r) => setTimeout(r, throttleMs));
      }
    }

    if (embedFailed || opts.signal?.aborted) {
      // Mid-file failure OR a pause/cancel that landed mid-file: some chunks may
      // have landed in the DB. Mark the file 'partial' so the next ingest (or a
      // resume) re-processes it instead of treating its hash as healthy — never
      // flip a half-embedded file to 'complete'.
      setFileIngestStatus(db, upsertResult.fileId, "partial");
      if (embedFailed) {
        onProgress({ phase: "file-skipped", filePath: file.relativePath, reason: "load-error", current, total });
      }
    } else {
      // Add a per-file metadata chunk so questions like "how big is X" or "when
      // was X modified" retrieve reliably even when no content chunk ranks high.
      // purgeFileChunks above already removed any prior metadata chunk, so this
      // always inserts a fresh one (ordinal -1 marks it as metadata).
      if (
        await upsertMetadataChunk(
          db,
          embedder,
          upsertResult.fileId,
          file.relativePath,
          fileStat.size,
          fileStat.mtimeMs,
          loaderId,
        )
      ) {
        chunksCreated += 1;
      }
      // All chunks for this file landed successfully — flip to 'complete'
      // atomically as the last step. Crash before this line → status stays
      // 'pending'/'partial', next run reprocesses.
      setFileIngestStatus(db, upsertResult.fileId, "complete");
      filesProcessed += 1;
      onProgress({
        phase: "file-complete",
        filePath: file.relativePath,
        chunkCount: embeddedSoFar,
        current,
        total,
      });
    }
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
