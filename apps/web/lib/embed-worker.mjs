/**
 * Embedding worker — runs the local BGE model on a separate thread so the heavy,
 * CPU-bound ONNX inference never blocks the Node main thread (which must stay
 * free to serve queries, config saves, and pause during a large ingest).
 *
 * Plain Node ESM on purpose: worker_threads loads this file through Node's own
 * loader (not Next's webpack), so it can `import("@xenova/transformers")`
 * directly from node_modules — the same package the embed-local plugin uses.
 * It MUST stay byte-for-byte equivalent to that plugin's model + pooling
 * (Xenova/bge-small-en-v1.5, mean pooling, normalized) so vectors are identical
 * to anything embedded inline. Message protocol: { id, texts } -> { id, vectors }
 * or { id, error }.
 */
import { parentPort, workerData } from "node:worker_threads";

if (workerData?.cacheDir) {
  process.env.HF_HOME = workerData.cacheDir;
  process.env.TRANSFORMERS_CACHE = workerData.cacheDir;
}
const MODEL = workerData?.model || "Xenova/bge-small-en-v1.5";

let extractorPromise = null;
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@xenova/transformers");
      return pipeline("feature-extraction", MODEL);
    })();
  }
  return extractorPromise;
}

parentPort.on("message", async (msg) => {
  const { id, texts } = msg ?? {};
  try {
    if (!Array.isArray(texts) || texts.length === 0) {
      parentPort.postMessage({ id, vectors: [] });
      return;
    }
    const extractor = await getExtractor();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    parentPort.postMessage({ id, vectors: output.tolist() });
  } catch (err) {
    parentPort.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
