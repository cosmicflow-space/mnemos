/**
 * Confined, read-only workspace access for the agent (Phase 3).
 *
 * The agent may navigate, find, read, and grep — but ONLY inside the user's
 * registered source roots (Mnemos's existing trust boundary), and read-only.
 * Every path is realpath-resolved and checked to be inside a root, so `../`,
 * absolute-path, and symlink-escape attempts are rejected (the read-side of the
 * security posture's containment rule). Everything is bounded: directory size,
 * walk breadth, file size, and match counts — so a huge tree or file can't be
 * used to exhaust memory or stall the loop.
 */

import {
  realpathSync,
  readdirSync,
  statSync,
  opendirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
  type Dirent,
} from "node:fs";
import { resolve, join, sep } from "node:path";
import type { WorkspaceFs, DirEntry, GrepMatch } from "./tools";

// Bounds — generous enough to be useful, tight enough to stay safe/fast.
const MAX_WALK_NODES = 20_000; // files+dirs visited in a single find/grep
const MAX_FIND_RESULTS = 500;
const MAX_GREP_MATCHES = 200;
const MAX_LIST_ENTRIES = 500; // cap a single directory listing (bounded read)
const MAX_FILE_BYTES = 512 * 1024; // skip/clip files larger than this
const READ_CAP_CHARS = 200_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", ".cache", ".DS_Store"]);

/** Read a confined file WITHOUT following a final-component symlink (O_NOFOLLOW),
 * then validate the opened inode via fstat. Closes the check-then-use gap where
 * a path realpath-confirmed by confine() is swapped to an external symlink before
 * the read. Returns null for non-regular/oversized/binary files. */
function readConfined(file: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null; // ELOOP (symlink swapped in), ENOENT, EACCES, …
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return off === st.size ? buf : buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

function realRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(realpathSync(resolve(r)));
    } catch {
      // a registered source that no longer exists on disk — skip it
    }
  }
  return out;
}

/** Resolve `candidate` and return it only if it lies inside a registered root;
 * null otherwise. Uses realpath so symlinks can't escape the boundary. */
function confine(roots: string[], candidate: string): string | null {
  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    return null;
  }
  for (const root of roots) {
    // `root + sep` avoids the sibling-prefix bug (/a/foo must not match /a/foobar);
    // root.endsWith(sep) handles a root of "/" (where root + sep would be "//").
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (real === root || real.startsWith(prefix)) return real;
  }
  return null;
}

function isSkipped(name: string): boolean {
  return SKIP_DIRS.has(name);
}

/** Depth-first walk of a directory, yielding file paths, bounded by node count. */
function* walkFiles(start: string, budget: { n: number }): Generator<string> {
  const stack: string[] = [start];
  while (stack.length > 0) {
    if (budget.n >= MAX_WALK_NODES) return;
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (budget.n >= MAX_WALK_NODES) return;
      budget.n += 1;
      if (e.name.startsWith(".") || isSkipped(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) yield full;
    }
  }
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true; // NUL byte → binary
  return false;
}

/**
 * Build the vetted read-only workspace view over the given registered source
 * roots. All methods are confined + bounded; nothing writes.
 */
export function buildWorkspaceFs(roots: string[]): WorkspaceFs {
  const rroots = realRoots(roots);

  return {
    async listDir(path?: string): Promise<DirEntry[]> {
      // No path → present the registered roots themselves as the top level.
      if (!path) return rroots.map((r) => ({ name: r, kind: "dir" as const }));
      const dir = confine(rroots, path);
      if (!dir) throw new Error("path is outside your registered sources");
      // Stream entries with opendir + a cap, so a huge directory can't be fully
      // materialized in memory before truncation.
      const out: DirEntry[] = [];
      const d = opendirSync(dir);
      try {
        let e: Dirent | null;
        while ((e = d.readSync()) !== null && out.length < MAX_LIST_ENTRIES) {
          if (e.name.startsWith(".") || isSkipped(e.name)) continue;
          out.push({ name: e.name, kind: e.isDirectory() ? "dir" : "file" });
        }
      } finally {
        d.closeSync();
      }
      return out;
    },

    async findFiles(pattern: string): Promise<string[]> {
      // Token-AND match: every whitespace-separated token must appear somewhere
      // in the path (case-insensitive). So "annual report" matches a path like
      // .../reports/2024/annual-report.md — forgiving of the exact separator or
      // wording a model guesses, without being a fuzzy free-for-all.
      const tokens = pattern.toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const budget = { n: 0 };
      const out: string[] = [];
      for (const root of rroots) {
        for (const f of walkFiles(root, budget)) {
          const lower = f.toLowerCase();
          if (tokens.every((t) => lower.includes(t))) {
            out.push(f);
            if (out.length >= MAX_FIND_RESULTS) return out;
          }
        }
      }
      return out;
    },

    async readFile(path: string): Promise<string> {
      const file = confine(rroots, path);
      if (!file) throw new Error("path is outside your registered sources");
      const buf = readConfined(file);
      if (!buf) throw new Error("not a readable regular file (or too large)");
      if (looksBinary(buf)) throw new Error("file appears to be binary");
      return buf.toString("utf8").slice(0, READ_CAP_CHARS);
    },

    async grep(pattern: string, path?: string): Promise<GrepMatch[]> {
      const needle = pattern.toLowerCase();
      const budget = { n: 0 };
      const out: GrepMatch[] = [];
      const starts = path ? [confine(rroots, path)].filter((p): p is string => p !== null) : rroots;
      if (path && starts.length === 0) throw new Error("path is outside your registered sources");
      for (const start of starts) {
        // A start may be a file or a dir.
        let files: Iterable<string>;
        try {
          files = statSync(start).isDirectory() ? walkFiles(start, budget) : [start];
        } catch {
          continue;
        }
        for (const f of files) {
          const buf = readConfined(f); // O_NOFOLLOW + size cap; null = skip
          if (!buf) continue;
          if (looksBinary(buf)) continue;
          const lines = buf.toString("utf8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            if (line.toLowerCase().includes(needle)) {
              const text = line.trim();
              out.push({ path: f, line: i + 1, text: text.length > 300 ? `${text.slice(0, 300)}…` : text });
              if (out.length >= MAX_GREP_MATCHES) return out;
            }
          }
        }
      }
      return out;
    },
  };
}
