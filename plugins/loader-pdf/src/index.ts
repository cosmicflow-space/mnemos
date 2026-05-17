import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

// pdf-parse has no published TS types and ships as CommonJS.
// Use createRequire so we get a CJS require in ESM scope.
const require = createRequire(import.meta.url);
type PdfParseResult = {
  text: string;
  numpages: number;
  info: Record<string, unknown>;
};
const pdfParse = require("pdf-parse") as (
  buffer: Buffer,
) => Promise<PdfParseResult>;

const loader: DocumentLoader = {
  id: "pdf",
  extensions: [".pdf"],
  async load(filePath: string): Promise<LoadedDoc> {
    const buffer = await readFile(filePath);
    const parsed = await pdfParse(buffer);
    return {
      text: parsed.text,
      metadata: {
        loader: "pdf",
        numPages: parsed.numpages,
        pdfInfo: parsed.info,
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
