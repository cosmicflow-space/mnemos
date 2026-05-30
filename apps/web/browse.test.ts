import { describe, it, expect } from "vitest";
import { filterBrowseEntries } from "./lib/browse";

describe("filterBrowseEntries", () => {
  it("drops hidden dotfiles and dotdirs (keeps credential config dirs off-screen)", () => {
    const out = filterBrowseEntries("/home/sam", [
      { name: ".ssh", isDir: true },
      { name: ".aws", isDir: true },
      { name: ".bashrc", isDir: false },
      { name: "Documents", isDir: true },
    ]);
    expect(out.map((e) => e.name)).toEqual(["Documents"]);
  });

  it("drops security hard-locked credential entries even when not hidden", () => {
    const out = filterBrowseEntries("/home/sam", [
      { name: "id_rsa", isDir: false },
      { name: "server.pem", isDir: false },
      { name: "private.key", isDir: false },
      { name: "site.crt", isDir: false },
      { name: "credentials", isDir: true },
      { name: "notes.txt", isDir: false },
    ]);
    expect(out.map((e) => e.name)).toEqual(["notes.txt"]);
  });

  it("sorts directories first, then case-insensitive alphabetical", () => {
    const out = filterBrowseEntries("/home/sam", [
      { name: "zebra.txt", isDir: false },
      { name: "Apple", isDir: true },
      { name: "banana", isDir: true },
      { name: "Beta.md", isDir: false },
    ]);
    expect(out.map((e) => `${e.isDir ? "d" : "f"}:${e.name}`)).toEqual([
      "d:Apple",
      "d:banana",
      "f:Beta.md",
      "f:zebra.txt",
    ]);
  });

  it("returns absolute paths joined to the directory", () => {
    const out = filterBrowseEntries("/home/sam/docs", [{ name: "report.pdf", isDir: false }]);
    expect(out[0]).toEqual({
      name: "report.pdf",
      absPath: "/home/sam/docs/report.pdf",
      isDir: false,
    });
  });
});
