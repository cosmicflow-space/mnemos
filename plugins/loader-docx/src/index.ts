import { readFile, stat } from "node:fs/promises";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

/**
 * Word (.docx) loader. Extracts raw text via `mammoth`. Lazily imported through
 * a string-built, `webpackIgnore`'d specifier (and externalized in next.config)
 * so webpack never bundles mammoth's jszip/XML internals — the same treatment
 * as the PDF loader. Externalized server packages must be a direct dependency
 * of @mnemos/web to resolve in `next dev` (see apps/web/loader-externals.test).
 *
 * SECURITY: a pre-parse size cap bounds OOM from a legitimately-huge document.
 * It does NOT defend against a small crafted zip-bomb / pathological OOXML —
 * acceptable under Mnemos's single-user trust model; sandboxed-worker isolation
 * is a future hardening.
 */

const MAX_OFFICE_BYTES = 50 * 1024 * 1024;

type MammothModule = {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>;
};

let mammoth: MammothModule | null = null;
async function getMammoth(): Promise<MammothModule> {
  if (mammoth) return mammoth;
  const name = ["mam", "moth"].join("");
  const mod = (await import(/* webpackIgnore: true */ name)) as
    | { default: MammothModule }
    | MammothModule;
  mammoth = "default" in mod ? mod.default : mod;
  return mammoth;
}

const loader: DocumentLoader = {
  id: "docx",
  extensions: [".docx"],
  async load(filePath: string): Promise<LoadedDoc> {
    const { size } = await stat(filePath);
    if (size > MAX_OFFICE_BYTES) {
      throw new Error(`docx too large to parse safely (${size} bytes > ${MAX_OFFICE_BYTES})`);
    }
    const buffer = await readFile(filePath);
    const { value } = await (await getMammoth()).extractRawText({ buffer });
    return {
      text: value,
      metadata: { loader: "docx" },
    };
  },
};

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-loader-docx",
    displayName: "Word (.docx) Loader",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  documentLoaders: [loader],
};

export default plugin;
