import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { EmbeddingProvider, CredentialSchema } from "@mnemos/plugin-sdk";

/**
 * A local EmbeddingProvider that runs ONNX inference on a worker thread instead
 * of the main thread. Local embedding is CPU-bound and onnxruntime pegs every
 * core, so running it inline starves the event loop — during a large ingest the
 * whole API (queries, config save, pause) hangs. Offloading to a worker keeps
 * the main thread free; `embed()` just posts a batch and awaits the result.
 *
 * The worker (lib/embed-worker.mjs) is pinned on globalThis so every Next bundle
 * (route handlers, the instrumentation watcher) shares ONE warm model rather than
 * each spawning its own ~130MB load.
 */

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";
const DIMENSIONS = 384;

type Pending = { resolve: (v: number[][]) => void; reject: (e: Error) => void };
type WorkerState = { worker: Worker; pending: Map<number, Pending>; seq: number };

const GLOBAL_KEY = "__mnemos_embed_worker__";
function globalSlot(): { state?: WorkerState } {
  const g = globalThis as unknown as Record<string, { state?: WorkerState }>;
  return (g[GLOBAL_KEY] ??= {});
}

/** worker .mjs lives beside this file in source and is NOT bundled (it's loaded
 * by Node via worker_threads). Resolve against cwd — `next dev` runs from
 * apps/web — with a repo-root fallback. */
function workerPath(): string {
  const fromWeb = join(process.cwd(), "lib", "embed-worker.mjs");
  const fromRoot = join(process.cwd(), "apps", "web", "lib", "embed-worker.mjs");
  if (existsSync(fromWeb)) return fromWeb;
  if (existsSync(fromRoot)) return fromRoot;
  return fromWeb;
}

function spawn(model: string, cacheDir: string | undefined): WorkerState {
  const worker = new Worker(workerPath(), { workerData: { model, cacheDir } });
  const state: WorkerState = { worker, pending: new Map(), seq: 0 };
  worker.on("message", (m: { id: number; vectors?: number[][]; error?: string }) => {
    const p = state.pending.get(m.id);
    if (!p) return;
    state.pending.delete(m.id);
    if (m.error) p.reject(new Error(`embed worker: ${m.error}`));
    else p.resolve(m.vectors ?? []);
  });
  const failAll = (err: Error) => {
    for (const p of state.pending.values()) p.reject(err);
    state.pending.clear();
    if (globalSlot().state === state) globalSlot().state = undefined;
  };
  worker.on("error", failAll);
  worker.on("exit", (code) => {
    if (code !== 0) failAll(new Error(`embed worker exited (code ${code})`));
    else if (globalSlot().state === state) globalSlot().state = undefined;
  });
  return state;
}

export function createWorkerEmbedder(credentialSchema: CredentialSchema): EmbeddingProvider {
  let model = DEFAULT_MODEL;
  let cacheDir: string | undefined;

  function ensure(): WorkerState {
    const slot = globalSlot();
    if (!slot.state) slot.state = spawn(model, cacheDir);
    return slot.state;
  }

  return {
    id: "embed-local",
    displayName: "Local (BGE-small, worker thread)",
    dimensions: DIMENSIONS,
    credentialSchema,
    async initialize(credentials: Record<string, string>): Promise<void> {
      if (credentials.model) model = credentials.model;
      cacheDir = credentials.cacheDir ?? process.env.MNEMOS_TRANSFORMERS_CACHE;
      ensure(); // start loading the model off-thread now
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const state = ensure();
      const id = ++state.seq;
      return new Promise<number[][]>((resolve, reject) => {
        state.pending.set(id, { resolve, reject });
        state.worker.postMessage({ id, texts });
      });
    },
  };
}
