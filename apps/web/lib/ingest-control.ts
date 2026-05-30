/**
 * Live ingest controllers, keyed by sourceId — the handle the pause/resume API
 * uses to abort an in-flight ingest. Pause is cooperative: aborting the signal
 * makes `ingestFolder` stop at a file boundary, leaving completed files
 * `complete` and the rest `pending`/`partial`, so a resume (a plain re-ingest)
 * continues from where it left off (incremental hash-skip).
 *
 * globalThis-pinned for the same reason as the status registry: the watcher
 * (instrumentation bundle) and API routes are separate bundles in one process.
 */

type Controllers = Map<number, AbortController>;

const controllers: Controllers = ((
  globalThis as unknown as { __mnemosIngestControllers?: Controllers }
).__mnemosIngestControllers ??= new Map());

export function registerIngestController(sourceId: number, controller: AbortController): void {
  controllers.set(sourceId, controller);
}

export function unregisterIngestController(sourceId: number): void {
  controllers.delete(sourceId);
}

export function isIngesting(sourceId: number): boolean {
  return controllers.has(sourceId);
}

/** Abort one source's ingest. Returns true if a run was actually in flight. */
export function pauseIngest(sourceId: number): boolean {
  const c = controllers.get(sourceId);
  if (!c) return false;
  c.abort();
  return true;
}

/** Abort every in-flight ingest (the "pause all / before bed" control). Returns
 * how many were running. */
export function pauseAllIngest(): number {
  let n = 0;
  for (const c of controllers.values()) {
    c.abort();
    n += 1;
  }
  return n;
}
