import { readFile } from "node:fs/promises";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

/**
 * PDF loader. Dynamic-imports `pdf-parse` lazily so webpack (used by Next.js
 * dev/build) doesn't statically trace into pdf-parse's package, which ships
 * binary test fixtures that break webpack module parsing.
 */

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
