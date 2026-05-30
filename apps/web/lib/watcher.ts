/**
 * Background source watcher.
 *
 * Periodic re-scan (not a live filesystem watcher): every tick, any source
 * whose auto re-scan is due gets an incremental re-ingest. Because ingest is
 * incremental, only changed/new files are re-embedded, so polling is cheap even
 * for large archives. Each source carries its own cadence (`watch_interval_ms`,
 * default once daily, 0 = manual only) so static archives stay quiet while hot
 * folders refresh often.
 *
 * Single instance per server process — started once from instrumentation.ts.
 * Disable with MNEMOS_DISABLE_WATCHER=1; tune the tick with MNEMOS_WATCH_TICK_MS.
 */

import { ingestFolder } from "@mnemos/core";
import {
  listDueSources,
  touchSourceScanned,
  tryClaimIngest,
  releaseIngest,
} from "@mnemos/db";
import { getDb, getRegistry, getDefaultEmbedder } from "./runtime";
import { applyIngestProgress, markIngestPaused } from "./ingest-status";
import { registerIngestController, unregisterIngestController } from "./ingest-control";

let started = false;
let ticking = false;

// Clamp the tick: a NaN/0/negative env value would otherwise make setInterval
// fire immediately in a hot loop. Floor at 1s.
const RAW_TICK = Number(process.env.MNEMOS_WATCH_TICK_MS);
const TICK_MS = Number.isFinite(RAW_TICK) && RAW_TICK >= 1000 ? RAW_TICK : 60_000;
const FIRST_TICK_DELAY_MS = 10_000;

export function startWatcher(): void {
  if (started) return;
  if (process.env.MNEMOS_DISABLE_WATCHER === "1") return;
  started = true;

  // Defer the first tick so it doesn't compete with server startup / first
  // request; then poll on the configured interval.
  setTimeout(() => void tick(), FIRST_TICK_DELAY_MS).unref?.();
  const handle = setInterval(() => void tick(), TICK_MS);
  // The watcher must not keep the process alive on its own.
  handle.unref?.();

  // eslint-disable-next-line no-console
  console.log(`[mnemos/watcher] started (tick ${TICK_MS}ms)`);
}

async function tick(): Promise<void> {
  if (ticking) return; // ticks never overlap
  ticking = true;
  try {
    const db = getDb();
    const due = listDueSources(db, Date.now());
    if (due.length === 0) return;

    let embedder;
    try {
      embedder = await getDefaultEmbedder();
    } catch {
      // No embedder ready yet (e.g. model still downloading / not configured).
      // Leave sources due and retry next tick.
      return;
    }
    const registry = getRegistry();

    for (const source of due) {
      // Atomic DB claim: the single source of truth for "who's ingesting this".
      // Protects against another tick, a concurrent manual ingest, and other
      // server processes — all of which respect the same lease.
      const token = tryClaimIngest(db, source.id);
      if (token === null) continue;
      // Register an abort handle so a background re-scan is pausable too.
      const abort = new AbortController();
      registerIngestController(source.id, abort);
      try {
        const res = await ingestFolder(db, registry, embedder, source, {
          signal: abort.signal,
          onProgress: (p) => {
            if (abort.signal.aborted && p.phase === "done") return;
            applyIngestProgress(source.id, source.path, p);
          },
        });
        if (abort.signal.aborted) {
          markIngestPaused(source.id);
        } else {
          // Back off the cadence only on success — a failed scan stays due and
          // retries next tick rather than going quiet for a full interval.
          touchSourceScanned(db, source.id);
          if (res.filesProcessed > 0 || res.chunksCreated > 0) {
            // eslint-disable-next-line no-console
            console.log(
              `[mnemos/watcher] ${source.path}: ${res.filesProcessed} files, ${res.chunksCreated} chunks`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        applyIngestProgress(source.id, source.path, { phase: "error", message });
        // eslint-disable-next-line no-console
        console.warn(`[mnemos/watcher] re-scan failed for ${source.path}: ${message}`);
      } finally {
        unregisterIngestController(source.id);
        releaseIngest(db, source.id, token);
      }
    }
  } finally {
    ticking = false;
  }
}
