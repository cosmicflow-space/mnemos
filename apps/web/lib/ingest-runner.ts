import { ingestFolder } from "@mnemos/core";
import { listSources, tryClaimIngest, releaseIngest, touchSourceScanned } from "@mnemos/db";
import { getDb, getRegistry, getDefaultEmbedder } from "./runtime";
import { applyIngestProgress, markIngestPaused } from "./ingest-status";
import { registerIngestController, unregisterIngestController } from "./ingest-control";

/**
 * Run a source's ingest in the background (no SSE client), feeding the status
 * registry and honoring pause via an AbortController. Used by the resume
 * endpoint — resume is just a re-run, which incrementally skips files already
 * `complete` and reprocesses `pending`/`partial` ones.
 *
 * Returns false if the source is unknown, no embedder is ready, or a run is
 * already in flight (lease held). Fire-and-forget: the ingest itself is detached.
 */
export async function runSourceIngestInBackground(sourceId: number): Promise<boolean> {
  const db = getDb();
  const source = listSources(db).find((s) => s.id === sourceId);
  if (!source) return false;

  let embedder;
  try {
    embedder = await getDefaultEmbedder();
  } catch {
    return false;
  }

  const token = tryClaimIngest(db, sourceId);
  if (token === null) return false; // already ingesting

  const controller = new AbortController();
  registerIngestController(sourceId, controller);

  void (async () => {
    try {
      await ingestFolder(db, getRegistry(), embedder, source, {
        signal: controller.signal,
        onProgress: (p) => {
          // When aborted, drop the trailing 'done' so the status entry survives
          // as 'paused' (with its progress) instead of being cleared to idle.
          if (controller.signal.aborted && p.phase === "done") return;
          applyIngestProgress(sourceId, source.path, p);
        },
      });
      if (controller.signal.aborted) markIngestPaused(sourceId);
      else touchSourceScanned(db, sourceId);
    } catch (err) {
      applyIngestProgress(sourceId, source.path, {
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Unregister our own controller first (instance-aware, so a resume that
      // already re-claimed the slot is untouched), then release the lease.
      unregisterIngestController(sourceId, controller);
      releaseIngest(db, sourceId, token);
    }
  })();

  return true;
}
