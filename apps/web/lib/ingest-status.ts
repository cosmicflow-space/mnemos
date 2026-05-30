/**
 * In-memory ingestion status, observable by the UI (the settings-launcher ring)
 * and any client via GET /api/ingest/status.
 *
 * Pinned to globalThis on purpose: in Next.js the background watcher runs in the
 * `instrumentation` bundle while API route handlers run in a separate bundle, so
 * a plain module-level singleton would be DUPLICATED and the watcher's progress
 * would be invisible to the status route. globalThis is shared across bundles in
 * the one server process (single-user, single-machine trust model).
 *
 * Progress is intentionally ephemeral (not persisted): it describes the live run.
 * The durable record of what's ingested is the file/chunk tables + the
 * `source.ingesting_since` lease. PR-2 adds pause/resume on top of this.
 */

export type IngestState = "running" | "paused" | "error" | "idle";

export type SourceIngestStatus = {
  sourceId: number;
  path: string;
  state: Exclude<IngestState, "idle">;
  filesDone: number;
  filesTotal: number;
  currentPath?: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
};

export type IngestStatusSnapshot = {
  /** Sources currently running, paused, or errored. Idle sources are absent. */
  sources: SourceIngestStatus[];
  /** Single rollup the launcher ring reads: running > paused > error > idle. */
  overall: IngestState;
  running: number;
  paused: number;
  errored: number;
};

type Registry = Map<number, SourceIngestStatus>;

// One instance per process, across webpack bundles.
const registry: Registry = ((
  globalThis as unknown as { __mnemosIngestStatus?: Registry }
).__mnemosIngestStatus ??= new Map());

function now(): number {
  return Date.now();
}

/** A progress event from `ingestFolder`'s onProgress (structurally typed so this
 * module needn't depend on @mnemos/core's IngestProgress union). */
type Progress = {
  phase: string;
  totalFiles?: number;
  supportedFiles?: number;
  filePath?: string;
  current?: number;
  total?: number;
  message?: string;
};

/** Translate one ingest progress event into a registry update. Call alongside
 * streaming the event to clients. */
export function applyIngestProgress(
  sourceId: number,
  sourcePath: string,
  p: Progress,
): void {
  const existing = registry.get(sourceId);
  const base: SourceIngestStatus = existing ?? {
    sourceId,
    path: sourcePath,
    state: "running",
    filesDone: 0,
    filesTotal: 0,
    startedAt: now(),
    updatedAt: now(),
  };

  switch (p.phase) {
    case "scan-start":
      registry.set(sourceId, { ...base, state: "running", error: undefined, startedAt: now(), updatedAt: now() });
      break;
    case "scan-complete":
      registry.set(sourceId, {
        ...base,
        state: "running",
        filesTotal: p.supportedFiles ?? p.totalFiles ?? base.filesTotal,
        updatedAt: now(),
      });
      break;
    case "file-start":
      registry.set(sourceId, {
        ...base,
        state: "running",
        currentPath: p.filePath,
        filesDone: Math.max(0, (p.current ?? 1) - 1),
        filesTotal: p.total ?? base.filesTotal,
        updatedAt: now(),
      });
      break;
    case "file-complete":
    case "file-skipped":
      registry.set(sourceId, {
        ...base,
        state: "running",
        filesDone: p.current ?? base.filesDone,
        filesTotal: p.total ?? base.filesTotal,
        updatedAt: now(),
      });
      break;
    case "done":
      registry.delete(sourceId); // idle = absent
      break;
    case "error":
      registry.set(sourceId, { ...base, state: "error", error: p.message, updatedAt: now() });
      break;
    default:
      // file-chunked / file-embedded etc. — keep alive, refresh timestamp.
      registry.set(sourceId, { ...base, updatedAt: now() });
  }
}

/** Force-clear a source's status (e.g., on remove). */
export function clearIngestStatus(sourceId: number): void {
  registry.delete(sourceId);
}

// Matches the DB ingest-lease stale window (STALE_INGEST_MS). Generous on
// purpose: a slow single-file run (e.g. Whisper on one big audio file) may emit
// no intra-file progress for a while, so we must not drop a legitimately-active
// run. It only evicts a ghost left by a process that died mid-run without
// emitting `done`/`error`.
const STALE_MS = 30 * 60 * 1000;

export function getIngestStatus(): IngestStatusSnapshot {
  const cutoff = now() - STALE_MS;
  for (const [id, s] of registry) {
    if (s.updatedAt < cutoff) registry.delete(id);
  }
  const sources = [...registry.values()];
  const running = sources.filter((s) => s.state === "running").length;
  const paused = sources.filter((s) => s.state === "paused").length;
  const errored = sources.filter((s) => s.state === "error").length;
  // Error first: a failure must surface on the launcher even while another
  // source is still ingesting — otherwise an active run masks a real error.
  const overall: IngestState =
    errored > 0 ? "error" : running > 0 ? "running" : paused > 0 ? "paused" : "idle";
  return { sources, overall, running, paused, errored };
}
