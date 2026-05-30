import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import plugin from "./src/index";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "sample.docx");

describe("loader-docx", () => {
  it("extracts text from a .docx", async () => {
    const loader = plugin.documentLoaders?.[0];
    expect(loader).toBeDefined();
    const doc = await loader!.load(fixture);
    expect(doc.text).toContain("DOCXFIXTURE2024");
    expect(doc.metadata.loader).toBe("docx");
  });
});
