import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

const execFileP = promisify(execFile);

/**
 * PDF loader. Dynamic-imports `pdf-parse` lazily so webpack (used by Next.js
 * dev/build) doesn't statically trace into pdf-parse's package, which ships
 * binary test fixtures that break webpack module parsing.
 *
 * `pdf-parse` is pure-JS and cross-platform, but it silently returns empty text
 * on some PDFs (certain encodings / producers) whose text layer `pdftotext`
 * (poppler) reads fine. So when pdf-parse comes back near-empty, we fall back to
 * `pdftotext` if it's on the system — recovering real text without OCR. The
 * fallback is best-effort: if poppler isn't installed it's a no-op, and a truly
 * scanned PDF (no text layer at all) still yields nothing and is handled upstream.
 */

const MIN_USABLE_CHARS = 20;

/** Extract text via `pdftotext` (poppler), or null if it's unavailable/failed. */
async function pdftotextFallback(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("pdftotext", ["-q", "-enc", "UTF-8", filePath, "-"], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  } catch {
    return null; // not installed, or this PDF defeated it too
  }
}

// ── OCR fallback for scanned PDFs (no text layer) ───────────────────────────
// Render pages to images with `pdftoppm` (poppler), then OCR them with the same
// tesseract.js engine the image loader uses. Bounded to the first OCR_MAX_PAGES.

const OCR_MAX_PAGES = 20;
const OCR_DPI = 200;

type TesseractWorker = {
  recognize(input: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
};
type TesseractModule = {
  createWorker(lang?: string, oem?: number, options?: { cachePath?: string }): Promise<TesseractWorker>;
};

let tesseract: TesseractModule | null = null;
async function getTesseract(): Promise<TesseractModule> {
  if (tesseract) return tesseract;
  // String-built + webpackIgnore so the bundler leaves it external (it resolves
  // its own worker/WASM asset paths relative to node_modules).
  const name = ["tesseract", ".js"].join("");
  const mod = (await import(/* webpackIgnore: true */ name)) as { default: TesseractModule } | TesseractModule;
  tesseract = "createWorker" in mod ? mod : mod.default;
  return tesseract;
}

function ocrCacheDir(): string {
  const base = process.env.MNEMOS_STATE_DIR ?? join(homedir(), ".mnemos");
  return join(base || tmpdir(), "ocr-cache");
}

/** OCR a scanned PDF: pdftoppm → PNG pages → tesseract. "" if it can't (e.g. no
 * poppler). CPU-heavy and slow by nature — ingestion runs in the background. */
async function ocrScannedPdf(filePath: string): Promise<string> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "mnemos-pdfocr-"));
  } catch {
    return "";
  }
  try {
    // -png raster, first OCR_MAX_PAGES pages only, at OCR_DPI. Output: dir/page-N.png
    await execFileP(
      "pdftoppm",
      ["-png", "-r", String(OCR_DPI), "-f", "1", "-l", String(OCR_MAX_PAGES), filePath, join(dir, "page")],
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const pngs = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    if (pngs.length === 0) return "";

    const cachePath = ocrCacheDir();
    await mkdir(cachePath, { recursive: true }).catch(() => {});
    const worker = await (await getTesseract()).createWorker("eng", undefined, { cachePath });
    try {
      const pages: string[] = [];
      for (const png of pngs) {
        const { data } = await worker.recognize(await readFile(join(dir, png)));
        pages.push(data.text.trim());
      }
      return pages.join("\n\n").trim();
    } finally {
      await worker.terminate();
    }
  } catch {
    return ""; // pdftoppm/tesseract unavailable or failed → stays metadata-only
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

type PdfParseResult = {
  text: string;
  numpages: number;
  info: Record<string, unknown>;
};
type PdfParseFn = (buffer: Buffer) => Promise<PdfParseResult>;

let pdfParseFn: PdfParseFn | null = null;
async function getPdfParse(): Promise<PdfParseFn> {
  if (pdfParseFn) return pdfParseFn;
  // Webpack can't statically analyze a string-built import path, so it won't
  // try to bundle pdf-parse's binary fixtures during the route compile.
  const name = ["pdf", "parse"].join("-");
  const mod = (await import(/* webpackIgnore: true */ name)) as
    | { default: PdfParseFn }
    | PdfParseFn;
  pdfParseFn = "default" in mod ? mod.default : mod;
  return pdfParseFn;
}

const loader: DocumentLoader = {
  id: "pdf",
  extensions: [".pdf"],
  async load(filePath: string): Promise<LoadedDoc> {
    const buffer = await readFile(filePath);
    const pdfParse = await getPdfParse();

    // pdf-parse can EITHER throw OR return empty on PDFs that actually have a text
    // layer (certain encodings/producers). Treat a throw as empty and recover via
    // pdftotext in both cases. A truly scanned PDF (no text layer) still yields
    // nothing here and is handled upstream as metadata-only.
    let parsed: PdfParseResult;
    try {
      parsed = await pdfParse(buffer);
    } catch {
      parsed = { text: "", numpages: 0, info: {} };
    }

    // Three-tier extraction: pdf-parse → pdftotext (text layer pdf-parse missed)
    // → OCR (scanned pages with no text layer at all).
    let text = parsed.text;
    let via = "pdf-parse";

    if (text.trim().length < MIN_USABLE_CHARS) {
      const fallback = await pdftotextFallback(filePath);
      if (fallback && fallback.trim().length > text.trim().length) {
        text = fallback;
        via = "pdftotext";
      }
    }
    if (text.trim().length < MIN_USABLE_CHARS) {
      const ocr = await ocrScannedPdf(filePath);
      if (ocr.trim().length > text.trim().length) {
        text = ocr;
        via = "ocr";
      }
    }

    return {
      text,
      metadata: {
        loader: "pdf",
        numPages: parsed.numpages,
        pdfInfo: parsed.info,
        extractedVia: via,
      },
    };
  },
};

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-loader-pdf",
    displayName: "PDF Loader",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  documentLoaders: [loader],
};

export default plugin;
