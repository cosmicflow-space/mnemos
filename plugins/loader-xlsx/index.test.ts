import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as XLSX from "xlsx";
import plugin from "./src/index";

describe("loader-xlsx", () => {
  it("renders each sheet to CSV-style text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemos-xlsx-"));
    const file = join(dir, "inv.xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Name", "Code"],
        ["Gadget", "ZZ-42"],
      ]),
      "Inventory",
    );
    XLSX.writeFile(wb, file);
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
