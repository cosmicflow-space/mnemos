import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import plugin from "./src/index";

describe("loader-xlsx", () => {
  it("renders each sheet to CSV-style text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemos-xlsx-"));
    const file = join(dir, "inv.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Inventory");
    ws.addRow(["Name", "Code"]);
    ws.addRow(["Gadget", "ZZ-42"]);
    await wb.xlsx.writeFile(file);
    try {
      const loader = plugin.documentLoaders?.[0];
      expect(loader).toBeDefined();
      const doc = await loader!.load(file);
      expect(doc.text).toContain("# Sheet: Inventory");
      expect(doc.text).toContain("Gadget");
      expect(doc.text).toContain("ZZ-42");
      expect(doc.metadata.loader).toBe("xlsx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
