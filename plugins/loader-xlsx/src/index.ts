import { readFile, stat } from "node:fs/promises";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

/**
 * Excel (.xlsx) loader. Renders each sheet to CSV-style text (embeds well for
 * tabular data). Uses `exceljs` — actively maintained on npm — rather than
 * SheetJS `xlsx@0.18.5`, whose only npm line carries unpatched ReDoS /
 * prototype-pollution advisories (CVE-2024-22363, GHSA-5pgg-2g8v-p4x9).
 *
 * Lazily imported via a string-built, `webpackIgnore`'d specifier (and
 * externalized in next.config) so the parser's internals stay out of the
 * webpack bundle; must be a direct dependency of @mnemos/web to resolve in dev.
 *
 * SECURITY: a pre-parse size cap bounds OOM from a legitimately-huge workbook.
 * It does NOT defend against a small crafted zip-bomb / pathological OOXML that
 * expands or back-tracks during parse — acceptable under Mnemos's single-user
 * trust model (you register your own folders); sandboxed-worker isolation is a
 * future hardening.
 */

const MAX_OFFICE_BYTES = 50 * 1024 * 1024;

type Cell = { text?: string; value?: unknown };
type Row = { eachCell(cb: (cell: Cell) => void): void };
type Worksheet = { name: string; eachRow(cb: (row: Row) => void): void };
type Workbook = { worksheets: Worksheet[]; xlsx: { load(buf: Buffer): Promise<unknown> } };
type ExcelJSModule = { Workbook: new () => Workbook };

let exceljs: ExcelJSModule | null = null;
async function getExcelJS(): Promise<ExcelJSModule> {
  if (exceljs) return exceljs;
  const name = ["excel", "js"].join("");
  const mod = (await import(/* webpackIgnore: true */ name)) as
    | { default: ExcelJSModule }
    | ExcelJSModule;
  exceljs = "Workbook" in mod ? mod : mod.default;
  return exceljs;
}

function cellText(cell: Cell): string {
  if (typeof cell.text === "string") return cell.text;
  const v = cell.value;
  return v === null || v === undefined ? "" : String(v);
}

const loader: DocumentLoader = {
  id: "xlsx",
  extensions: [".xlsx"],
  async load(filePath: string): Promise<LoadedDoc> {
    const { size } = await stat(filePath);
    if (size > MAX_OFFICE_BYTES) {
      throw new Error(`xlsx too large to parse safely (${size} bytes > ${MAX_OFFICE_BYTES})`);
    }
    const buffer = await readFile(filePath);
    const { Workbook } = await getExcelJS();
    const wb = new Workbook();
    await wb.xlsx.load(buffer);
    const parts = wb.worksheets.map((ws) => {
      const rows: string[] = [];
      ws.eachRow((row) => {
        const cells: string[] = [];
        row.eachCell((cell) => cells.push(cellText(cell)));
        rows.push(cells.join(","));
      });
      return `# Sheet: ${ws.name}\n${rows.join("\n")}`;
    });
    return {
      text: parts.join("\n\n"),
      metadata: { loader: "xlsx", sheets: wb.worksheets.map((w) => w.name) },
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
