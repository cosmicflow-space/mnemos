import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { normalizeUserPath } from "./lib/user-path";

describe("normalizeUserPath", () => {
  it("strips single quotes Finder adds around paths with spaces (the iCloud bug)", () => {
    // macOS Finder copies this iCloud path single-quoted because of the spaces.
    // Un-stripped, the leading ' made it relative → resolved under cwd → a path
    // that doesn't exist, so the source silently ingested nothing.
    const quoted = "'/Users/sam/Library/Mobile Documents/com~apple~CloudDocs/DriverLicense'";
    expect(normalizeUserPath(quoted)).toBe(
      "/Users/sam/Library/Mobile Documents/com~apple~CloudDocs/DriverLicense",
    );
  });

  it("strips matching double quotes too", () => {
    expect(normalizeUserPath('"/Users/sam/My Files"')).toBe("/Users/sam/My Files");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeUserPath("  /Users/sam/docs  ")).toBe("/Users/sam/docs");
  });

  it("leaves an already-clean absolute path unchanged", () => {
    expect(normalizeUserPath("/Users/sam/docs")).toBe("/Users/sam/docs");
  });

  it("expands a leading ~ to the home directory", () => {
    expect(normalizeUserPath("~/Documents")).toBe(resolve(homedir(), "Documents"));
  });

  it("expands ~ even inside a quoted path", () => {
    expect(normalizeUserPath("'~/My Notes'")).toBe(resolve(homedir(), "My Notes"));
  });

  it("does NOT strip an unmatched leading quote (only matched pairs)", () => {
    // A lone leading quote isn't a paste artifact we recognize; leave it so the
    // result is honest rather than silently fabricating a different path.
    expect(normalizeUserPath("'/Users/sam/docs")).toContain("'");
  });
});
