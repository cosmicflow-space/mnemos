import { describe, it, expect } from "vitest";
import { classifyContainment } from "./lib/path-containment";

const existing = [
  { path: "/Users/me/Documents", real: "/Users/me/Documents" },
  { path: "/Users/me/Projects/app", real: "/Users/me/Projects/app" },
];

describe("classifyContainment", () => {
  it("flags a subfolder of an existing source as 'inside' its parent", () => {
    const c = classifyContainment("/Users/me/Documents/ipostal", existing);
    expect(c).toEqual({ kind: "inside", parentPath: "/Users/me/Documents" });
  });

  it("treats an exact match as inside (fold into the same source)", () => {
    const c = classifyContainment("/Users/me/Documents", existing);
    expect(c).toEqual({ kind: "inside", parentPath: "/Users/me/Documents" });
  });

  it("flags a parent of existing sources as 'contains'", () => {
    const c = classifyContainment("/Users/me", existing);
    expect(c.kind).toBe("contains");
    if (c.kind === "contains") {
      expect(c.childPaths.sort()).toEqual(
        ["/Users/me/Documents", "/Users/me/Projects/app"].sort(),
      );
    }
  });

  it("returns 'none' for a disjoint path", () => {
    expect(classifyContainment("/Users/me/Music", existing)).toEqual({ kind: "none" });
  });

  it("does NOT treat a sibling sharing a name prefix as inside (boundary test)", () => {
    // /Users/me/Documents-old must not be considered inside /Users/me/Documents
    expect(classifyContainment("/Users/me/Documents-old", existing)).toEqual({ kind: "none" });
  });

  it("detects nesting in Windows-style backslash paths", () => {
    const win = [{ path: "C:\\Users\\me\\Docs", real: "C:\\Users\\me\\Docs" }];
    expect(classifyContainment("C:\\Users\\me\\Docs\\child", win)).toEqual({
      kind: "inside",
      parentPath: "C:\\Users\\me\\Docs",
    });
    expect(classifyContainment("C:\\Users\\me\\Docs-old", win)).toEqual({ kind: "none" });
  });
});
