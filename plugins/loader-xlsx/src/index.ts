import { readFile } from "node:fs/promises";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

/**
 * Excel (.xlsx) loader. Renders each sheet to CSV-style text via SheetJS, which
 * embeds well for retrieval over tabular data. Lazily imported through a
 * string-built, `webpackIgnore`'d specifier (and externalized in next.config):
 * SheetJS does conditional requires (codepage, fs) that webpack chokes on, so we
 * keep it out of the bundle. Externalized server packages must be a direct
 * dependency of @mnemos/web to resolve in `next dev`.
 */

type WorkBook = { SheetNames: string[]; Sheets: Record<string, unknown> };
type XlsxModule = {
  read(data: Buffer, opts: { type: "buffer" }): WorkBook;
  utils: { sheet_to_csv(sheet: unknown): string };
};

let xlsx: XlsxModule | null = null;
async function getXlsx(): Promise<XlsxModule> {
  if (xlsx) return xlsx;
  const name = ["x", "lsx"].join("");
  const mod = (await import(/* webpackIgnore: true */ name)) as
    | { default: XlsxModule }
    | XlsxModule;
  xlsx = "default" in mod ? mod.default : mod;
  return xlsx;
}

const loader: DocumentLoader = {
  id: "xlsx",
  extensions: [".xlsx"],
  async load(filePath: string): Promise<LoadedDoc> {
    const buffer = await readFile(filePath);
    const x = await getXlsx();
    const wb = x.read(buffer, { type: "buffer" });
    const parts = wb.SheetNames.map(
      (name) => `# Sheet: ${name}\n${x.utils.sheet_to_csv(wb.Sheets[name])}`,
    );
    return {
      text: parts.join("\n\n"),
      metadata: { loader: "xlsx", sheets: wb.SheetNames },
    };
  },
};

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-loader-xlsx",
    displayName: "Excel (.xlsx) Loader",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  documentLoaders: [loader],
};

export default plugin;
