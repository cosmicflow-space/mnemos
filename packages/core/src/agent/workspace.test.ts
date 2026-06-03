/**
 * Phase 3 — confined read-only workspace.
 *
 * The security-critical property is containment: the agent may read inside
 * registered source roots and NOWHERE else. These tests build a real temp tree,
 * prove find/read/grep/list work, prove counting works (the "how many X" case),
 * and prove that `../`, absolute-path, and outside-root reads are rejected.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceFs } from "./workspace";
import { getTool, type ToolContext } from "./tools";

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mnemos-ws-"));
  outside = mkdtempSync(join(tmpdir(), "mnemos-out-"));
  mkdirSync(join(root, "reports", "q1"), { recursive: true });
  mkdirSync(join(root, "reports", "q2"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "reports", "q1", "summary.md"), "Q1 report\namount: 100\n");
  writeFileSync(join(root, "reports", "q2", "summary.md"), "Q2 report\namount: 200\n");
  writeFileSync(join(root, "notes.md"), "the secret is 42\nother line\n");
  writeFileSync(join(root, ".git", "config"), "should be skipped\n");
  writeFileSync(join(outside, "private.md"), "TOP SECRET — must never be read\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("buildWorkspaceFs — confined read-only access", () => {
  it("lists the registered roots when given no path", async () => {
    const fs = buildWorkspaceFs([root]);
    const entries = await fs.listDir();
    // Roots are realpath-resolved (e.g. macOS /var → /private/var), so compare
    // by count + kind rather than the raw input string.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("dir");
  });

  it("lists a directory's entries, skipping dotfiles/.git", async () => {
    const fs = buildWorkspaceFs([root]);
    const names = (await fs.listDir(root)).map((e) => e.name);
    expect(names).toContain("reports");
    expect(names).toContain("notes.md");
    expect(names).not.toContain(".git");
  });

  it("finds files by substring and supports counting (how many X)", async () => {
    const fs = buildWorkspaceFs([root]);
    const hits = await fs.findFiles("summary");
    expect(hits).toHaveLength(2); // exactly the two summary.md files
  });

  it("token-matches across separators (a model's loose wording still finds files)", async () => {
    const fs = buildWorkspaceFs([root]);
    // "reports summary" (two tokens) matches reports/q1/summary.md and
    // reports/q2/summary.md via token-AND on the path; narrower tokens narrow it.
    expect(await fs.findFiles("reports summary")).toHaveLength(2);
    expect(await fs.findFiles("q1 summary")).toHaveLength(1);
    expect(await fs.findFiles("zzz summary")).toHaveLength(0);
  });

  it("reads a file inside a source", async () => {
    const fs = buildWorkspaceFs([root]);
    const text = await fs.readFile(join(root, "notes.md"));
    expect(text).toContain("the secret is 42");
  });

  it("greps file contents and returns file:line matches", async () => {
    const fs = buildWorkspaceFs([root]);
    const matches = await fs.grep("amount");
    expect(matches).toHaveLength(2);
    expect(matches[0]?.text).toContain("amount");
  });

  // ---- Containment: the security boundary ----
  it("refuses to read a file outside the registered roots", async () => {
    const fs = buildWorkspaceFs([root]);
    await expect(fs.readFile(join(outside, "private.md"))).rejects.toThrow(/outside your registered sources/);
  });

  it("refuses a ../ traversal escape", async () => {
    const fs = buildWorkspaceFs([root]);
    await expect(fs.readFile(join(root, "..", "..", "etc", "hosts"))).rejects.toThrow();
  });

  it("refuses to list a directory outside the roots", async () => {
    const fs = buildWorkspaceFs([root]);
    await expect(fs.listDir(outside)).rejects.toThrow(/outside your registered sources/);
  });

  it("never returns outside content from a workspace-wide grep", async () => {
    const fs = buildWorkspaceFs([root]); // outside/ is NOT a root
    const matches = await fs.grep("TOP SECRET");
    expect(matches).toHaveLength(0);
  });

  it("refuses a symlink (inside a root) that points outside the root", async () => {
    const link = join(root, "escape-link.md");
    symlinkSync(join(outside, "private.md"), link);
    const fs = buildWorkspaceFs([root]);
    // realpath resolves the symlink to the outside target → confined out.
    await expect(fs.readFile(link)).rejects.toThrow(/outside your registered sources/);
  });

  it("rejects a sibling whose name is a prefix of the registered root", async () => {
    // base/foo is registered; base/foobar must NOT be reachable.
    const base = mkdtempSync(join(tmpdir(), "mnemos-sib-"));
    mkdirSync(join(base, "foo"));
    mkdirSync(join(base, "foobar"));
    writeFileSync(join(base, "foobar", "x.md"), "sibling content\n");
    const fs = buildWorkspaceFs([join(base, "foo")]);
    await expect(fs.readFile(join(base, "foobar", "x.md"))).rejects.toThrow(/outside your registered sources/);
    rmSync(base, { recursive: true, force: true });
  });

  it("bounds a large directory listing (truncates, doesn't materialize unbounded)", async () => {
    const big = mkdtempSync(join(tmpdir(), "mnemos-big-"));
    for (let i = 0; i < 505; i++) writeFileSync(join(big, `f${i}.txt`), "x");
    const fs = buildWorkspaceFs([big]);
    const entries = await fs.listDir(big);
    expect(entries.length).toBe(500); // MAX_LIST_ENTRIES
    rmSync(big, { recursive: true, force: true });
  });
});

describe("read-only file tools over the confined workspace", () => {
  it("find_files reports a count usable for 'how many' goals", async () => {
    const ctx: ToolContext = { search: async () => [], fs: buildWorkspaceFs([root]) };
    const res = await getTool("find_files")!.run({ pattern: "summary" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.observation).toContain("2 file(s) match");
  });

  it("file tools report unavailable when no workspace fs is injected", async () => {
    const noFs: ToolContext = { search: async () => [] };
    const res = await getTool("list_dir")!.run({}, noFs);
    expect(res.ok).toBe(false);
  });
});
