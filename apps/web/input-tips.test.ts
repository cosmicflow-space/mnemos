import { describe, it, expect } from "vitest";
import { INPUT_TIPS, formatTipsText, formatTipsMarkdown, tipColor } from "./lib/input-tips";

describe("input tips", () => {
  it("has a row for the default and each routing prefix", () => {
    const syntaxes = INPUT_TIPS.map((t) => t.syntax);
    for (const s of ["(no prefix)", "!", "!!", "!!!", "+", "++"]) {
      expect(syntaxes).toContain(s);
    }
  });

  it("every tip carries a full desc and a compact short label (legend renders from short)", () => {
    for (const t of INPUT_TIPS) {
      expect(t.desc.length).toBeGreaterThan(0);
      expect(t.short.length).toBeGreaterThan(0);
    }
  });

  it("tipColor keys off the sigil family", () => {
    expect(tipColor("!")).toBe("amber");
    expect(tipColor("!!!")).toBe("amber");
    expect(tipColor("+")).toBe("sky");
    expect(tipColor("++")).toBe("sky");
    expect(tipColor("(no prefix)")).toBe("muted");
  });

  it("both formatters surface every tip (single source of truth)", () => {
    const text = formatTipsText();
    const md = formatTipsMarkdown();
    for (const t of INPUT_TIPS) {
      expect(text).toContain(t.syntax);
      expect(text).toContain(t.desc);
      expect(md).toContain(t.syntax);
      expect(md).toContain(t.desc);
    }
  });

  it("markdown renders a table; text stays plain (no pipes)", () => {
    expect(formatTipsMarkdown()).toContain("| Prefix | What it does |");
    expect(formatTipsText()).not.toContain("|");
  });
});
