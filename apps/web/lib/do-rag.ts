/**
 * The `rag` write verb — add files the user selected to the index, on demand.
 *
 * It reuses the existing ingest pipeline, so the upsert/hash behavior is free:
 * a file not in the index is added; an indexed-but-unchanged file is skipped
 * (hash match); a changed file is re-indexed. Each selected file is registered
 * as a single-file source (the per-file access grant), then ingested.
 *
 * Boundary re-check at write time (DO.md §4): every path is realpath-resolved and
 * must be a regular file under $HOME and not a symlink — a path swapped after the
 * search cannot cross the boundary.
 */

import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestFolder } from "@mnemos/core";
import {
  addSource,
  getSourceByPath,
  listFilesInSource,
  getFileLocation,
  fileContentChars,
  releaseIngest,
  touchSourceScanned,
  tryClaimIngest,
} from "@mnemos/db";
import { getDb, getRegistry, getDefaultEmbedder } from "./runtime";

export type RagOutcome = {
  added: string[];
  updated: string[];
  unchanged: string[];
  failed: { path: string; reason: string }[];
  chunks: number;
  /** Files now in the index from this call — the auto-focus targets (DO.md). */
  focus: { fileId: number; name: string }[];
};

/** realpath under $HOME, a regular file, not a symlink — else null. */
function safeResolve(p: string): string | null {
  try {
    if (lstatSync(p).isSymbolicLink()) return null;
    const real = realpathSync(p);
    const home = os.homedir();
    if (real !== home && !real.startsWith(home + path.sep)) return null;
    if (!lstatSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Force re-extraction of a single indexed file (its source re-runs the loader,
 * bypassing the hash-skip). Used by `/reindex` when a file ended up metadata-only.
 * Returns the content-char count after — still ~0 means no extractable text
 * (e.g. a scanned PDF that needs OCR), which the caller reports honestly.
 */
export async function reindexFile(fileId: number): Promise<{ ok: boolean; contentChars: number; reason?: string }> {
  const db = getDb();
  const loc = getFileLocation(db, fileId);
  if (!loc) return { ok: false, contentChars: 0, reason: "file not found in the index" };

  const registry = getRegistry();
  let embedder: Awaited<ReturnType<typeof getDefaultEmbedder>>;
  try {
    embedder = await getDefaultEmbedder();
  } catch (err) {
    return {
      ok: false,
      contentChars: fileContentChars(db, fileId),
      reason: err instanceof Error ? err.message : "the local embedder isn't ready",
    };
  }
  const token = tryClaimIngest(db, loc.sourceId);
  if (token === null) {
    return { ok: false, contentChars: fileContentChars(db, fileId), reason: "an ingest is already running for this source" };
  }
  try {
    // Re-extract ONLY this one file (force, targeted by its source-relative path) —
    // so /reindex of a focused file never touches the rest of a folder source.
    await ingestFolder(
      db,
      registry,
      embedder,
      { id: loc.sourceId, path: loc.sourcePath },
      { force: true, onlyRelPath: loc.relPath },
    );
    touchSourceScanned(db, loc.sourceId);
  } catch (err) {
    return { ok: false, contentChars: fileContentChars(db, fileId), reason: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseIngest(db, loc.sourceId, token);
  }
  return { ok: true, contentChars: fileContentChars(db, fileId) };
}

export async function addPathsToRag(paths: string[]): Promise<RagOutcome> {
  const db = getDb();
  const registry = getRegistry();
  const embedder = await getDefaultEmbedder();
  const out: RagOutcome = { added: [], updated: [], unchanged: [], failed: [], chunks: 0, focus: [] };

  for (const raw of paths) {
    const real = safeResolve(raw);
    if (!real) {
      out.failed.push({ path: raw, reason: "not a regular file under your home directory" });
      continue;
    }

    const existing = getSourceByPath(db, real);
    const src = existing ?? addSource(db, real, "file");

    const token = tryClaimIngest(db, src.id);
    if (token === null) {
      out.failed.push({ path: real, reason: "an ingest is already running for this file" });
      continue;
    }

    try {
      const result = await ingestFolder(db, registry, embedder, { id: src.id, path: real });
      touchSourceScanned(db, src.id);
      out.chunks += result.chunksCreated;
      if (result.errors.length > 0) {
        out.failed.push({ path: real, reason: result.errors[0]?.message ?? "ingest error" });
      } else {
        if (result.filesProcessed === 0 && result.filesSkipped > 0) out.unchanged.push(real);
        else if (existing) out.updated.push(real);
        else out.added.push(real);
        // The file is now in the index — record it as an auto-focus target.
        const fileId = listFilesInSource(db, src.id)[0]?.id;
        if (fileId !== undefined) out.focus.push({ fileId, name: real.split("/").pop() ?? real });
      }
    } catch (err) {
      out.failed.push({ path: real, reason: err instanceof Error ? err.message : String(err) });
    } finally {
      releaseIngest(db, src.id, token);
    }
  }

  return out;
}
