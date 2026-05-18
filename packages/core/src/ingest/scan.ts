/**
 * Read-only filesystem scan.
 *
 * Walks a folder, classifies every file, and returns a summary plus the file
 * list. Does NOT load file contents, embed, or write anything. Cheap and fast
 * so the UI can show "Found 24 PDFs, 50 markdown" in <2 seconds, letting the
 * user confirm they picked the right folder before committing to embedding.
 *
 * Skips hidden files/dirs (dotfiles) and common junk dirs (node_modules,
 * .git, dist, build, .next, etc.) by default — these almost never belong in
 * a personal-RAG index and ignoring them avoids ingesting millions of irrelevant
 * generated files.
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  classifyFile,
  type Classification,
  type FileCategory,
} from "./classify";

export type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  mtime: number;
  classification: Classification;
};

export type ScanSummary = {
  totalFiles: number;
  totalBytes: number;
  /** Counts grouped by label (e.g. {"PDFs": 24, "markdown files": 50}). */
  byLabel: Record<string, number>;
  /** Counts grouped by category. */
  byCategory: Record<FileCategory, number>;
  /** Deferred kinds present, with their notes for UI surfacing. */
  deferredNotes: Array<{ label: string; count: number; note: string }>;
};

export type ScanResult = {
  rootPath: string;
  files: ScannedFile[];
  summary: ScanSummary;
  /** Directories skipped due to the skip-list. UI can show this so users
   * understand why their node_modules wasn't indexed. */
  skippedDirs: string[];
};

export type ScanOptions = {
  /** Folder names skipped during traversal. */
  skipDirs?: ReadonlySet<string>;
  /** Skip files larger than this (bytes). Default 10 MB. */
  maxFileBytes?: number;
  /** Maximum directory recursion depth. Default 12. */
  maxDepth?: number;
  /** Maximum file count to scan. Default 50,000 (safety cap). */
  maxFiles?: number;
};

const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".idea",
  ".vscode",
  ".DS_Store",
  "target",
  "vendor",
  ".gradle",
  ".mvn",
]);

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FILES = 50_000;

export async function scanFolder(
  rootPath: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const absoluteRoot = resolve(rootPath);

  const files: ScannedFile[] = [];
  const skippedDirs: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir, skip silently
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      // Skip hidden files/dirs (anything starting with .)
      if (entry.name.startsWith(".")) continue;
      // Skip junk dirs
      if (entry.isDirectory() && skipDirs.has(entry.name)) {
        skippedDirs.push(join(dir, entry.name));
        continue;
      }

      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      let s;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.size > maxBytes) continue;

      const relativePath = full.slice(absoluteRoot.length + 1);
      const classification = classifyFile(full);
      files.push({
        absolutePath: full,
        relativePath,
        sizeBytes: s.size,
        mtime: s.mtimeMs,
        classification,
      });
    }
  }

  await walk(absoluteRoot, 0);

  return {
    rootPath: absoluteRoot,
    files,
    summary: summarize(files),
    skippedDirs,
  };
}

function summarize(files: ScannedFile[]): ScanSummary {
  const byLabel: Record<string, number> = {};
  const byCategory: Record<FileCategory, number> = {
    supported: 0,
    deferred: 0,
    unsupported: 0,
  };
  const deferredAgg = new Map<string, { count: number; note: string }>();
  let totalBytes = 0;

  for (const f of files) {
    const { classification } = f;
    byLabel[classification.label] = (byLabel[classification.label] ?? 0) + 1;
    byCategory[classification.category] += 1;
    totalBytes += f.sizeBytes;
    if (classification.category === "deferred" && classification.note) {
      const existing = deferredAgg.get(classification.label);
      if (existing) {
        existing.count += 1;
      } else {
        deferredAgg.set(classification.label, {
          count: 1,
          note: classification.note,
        });
      }
    }
  }

  const deferredNotes = [...deferredAgg.entries()].map(([label, v]) => ({
    label,
    count: v.count,
    note: v.note,
  }));

  return {
    totalFiles: files.length,
    totalBytes,
    byLabel,
    byCategory,
    deferredNotes,
  };
}
