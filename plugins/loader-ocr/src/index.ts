import { readFile, stat, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

/**
 * Image OCR loader. Extracts text from raster images via `tesseract.js`
 * (WASM Tesseract — no system binary needed, keeping the Node-only install
 * story intact). On first use it fetches the English trained-data + WASM core
 * and caches them locally — the same one-time-then-offline pattern as the BGE
 * embedding model (Tier 1 stays local after the first run).
 *
 * Lazily imported via a string-built, `webpackIgnore`'d specifier (and
 * externalized in next.config). For tesseract.js this is REQUIRED, not just an
 * optimization: it resolves its own worker/WASM asset paths relative to its
 * node_modules location, which bundling would break.
 *
 * SECURITY: a pre-parse size cap bounds memory on a huge image. OCR is also
 * CPU-heavy and slow — exactly why ingestion runs in the background and is
 * pausable. Scanned PDFs (no text layer) need a PDF→raster step first and are a
 * follow-up; this loader handles raster image files.
 */

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type TesseractWorker = {
  recognize(input: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
};
type TesseractModule = {
  createWorker(lang?: string, oem?: number, options?: { cachePath?: string }): Promise<TesseractWorker>;
};

/** Where tesseract.js caches its trained-data + WASM core. Default is the CWD,
 * which would litter the working dir on every OCR; keep it with Mnemos's state
 * (or the OS temp dir) instead. */
function ocrCacheDir(): string {
  const base = process.env.MNEMOS_STATE_DIR ?? join(homedir(), ".mnemos");
  return join(base || tmpdir(), "ocr-cache");
}

let tesseract: TesseractModule | null = null;
async function getTesseract(): Promise<TesseractModule> {
  if (tesseract) return tesseract;
  const name = ["tesseract", ".js"].join("");
  const mod = (await import(/* webpackIgnore: true */ name)) as
    | { default: TesseractModule }
    | TesseractModule;
  tesseract = "createWorker" in mod ? mod : mod.default;
  return tesseract;
}

const loader: DocumentLoader = {
  id: "ocr",
  extensions: [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"],
  async load(filePath: string): Promise<LoadedDoc> {
    const { size } = await stat(filePath);
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(`image too large to OCR (${size} bytes > ${MAX_IMAGE_BYTES})`);
    }
    const buffer = await readFile(filePath);
    const cachePath = ocrCacheDir();
    await mkdir(cachePath, { recursive: true }).catch(() => {});
    const worker = await (await getTesseract()).createWorker("eng", undefined, { cachePath });
    try {
      const { data } = await worker.recognize(buffer);
      return {
        text: data.text.trim(),
        metadata: { loader: "ocr", ocrEngine: "tesseract", language: "eng" },
      };
    } finally {
      await worker.terminate();
    }
  },
};

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-loader-ocr",
    displayName: "Image OCR Loader",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  documentLoaders: [loader],
};

export default plugin;
