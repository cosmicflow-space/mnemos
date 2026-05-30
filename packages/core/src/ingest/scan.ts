/**
 * Read-only filesystem scan.
 *
 * Walks a folder, classifies every file, applies the security/default exclude
 * rules from `./exclude`, and returns a summary the UI can use to decide what
 * to ingest. Does NOT load file contents, embed, or write anything.
 *
 * Three exclusion dimensions are tracked separately so the UI can surface
 * each with its own affordance:
 *   - Security excludes (.env, *.pem, id_rsa*) — hard-locked, never returned
 *     in `files`; only the count is reported.
 *   - Default-noise excludes (logs, lockfiles, minified, transient) — not in
 *     `files` by default; the UI can opt them back in per ingest.
 *   - Large files (> 10 MB) — INCLUDED in `files` but flagged via
 *     `largeFiles` so the UI can prompt "10 files over 10 MB, include all?"
 */

import { readdir, stat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve, basename } from "node:path";
import {
  classifyFile,
  type Classification,
  type FileCategory,
} from "./classify";
import {
  checkSecurityExclusion,
  checkSoftExclusion,
  LARGE_FILE_BYTES,
  type ExclusionReason,
  type ExclusionVerdict,
} from "./exclude";

export type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  mtime: number;
  classification: Classification;
  /** Set when the file matched a soft-exclude rule (log, lockfile, etc.).
   * The pipeline can override the exclusion via user-supplied includeOverrides.
   * Security-tier files are NOT included in scan.files at all — they only
   * appear in scan.securityExcluded for accounting. */
  exclusion?: ExclusionVerdict;
};

export type ExcludedFile = {
  relativePath: string;
  sizeBytes: number;
  reason: ExclusionReason;
  label: string;
};

export type ExclusionSummary = {
  /** Count by reason: { log: 234, lockfile: 5, ... } */
  byReason: Partial<Record<ExclusionReason, number>>;
  /** Count by user-facing label, for display. */
  byLabel: Record<string, number>;
  totalCount: number;
  /** First ~20 excluded files (path + reason) so UI can show a preview. */
  sample: ExcludedFile[];
};

export type LargeFileSummary = {
  count: number;
  totalBytes: number;
  /** First ~20 large files for preview. */
  sample: Array<{
    relativePath: string;
    sizeBytes: number;
    classification: Classification;
  }>;
};

export type ScanSummary = {
  totalFiles: number;
  totalBytes: number;
  byLabel: Record<string, number>;
  byCategory: Record<FileCategory, number>;
  deferredNotes: Array<{ label: string; count: number; note: string }>;
};

export type ScanResult = {
  rootPath: string;
  files: ScannedFile[];
  summary: ScanSummary;
  skippedDirs: string[];
  /** Soft-excluded by default (logs, lockfiles, etc.). User can opt back in. */
  defaultExcluded: ExclusionSummary;
  /** Hard-excluded (secrets). Reported as count + labels only — never includable. */
  securityExcluded: ExclusionSummary;
  /** Files > 10 MB. Included in `files` but flagged for UI confirmation. */
  largeFiles: LargeFileSummary;
};

export type ScanOptions = {
  skipDirs?: ReadonlySet<string>;
  /** Maximum directory recursion depth. Default 12. */
  maxDepth?: number;
  /** Maximum file count to scan. Default 50,000. */
  maxFiles?: number;
};

const DEFAULT_SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", "out", ".next", ".nuxt",
  ".turbo", ".cache",
  ".venv", "venv", "__pycache__", ".pytest_cache",
  ".idea", ".vscode", ".DS_Store",
  "target", "vendor", ".gradle", ".mvn",
]);

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FILES = 50_000;
const SAMPLE_CAP = 20;

export async function scanFolder(
  rootPath: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  let absoluteRoot = resolve(rootPath);

  const files: ScannedFile[] = [];
  const skippedDirs: string[] = [];
  const defaultExcludedRaw: ExcludedFile[] = [];
  const securityExcludedRaw: ExcludedFile[] = [];
  const largeFilesRaw: LargeFileSummary["sample"] = [];
  let largeFilesCount = 0;
  let largeFilesBytes = 0;

  // Process one file: security/soft-exclusion, classification, large-file tally,
  // then push into `files`. Shared by the directory walk and the single-file
  // root branch. For a single explicitly-registered file the user's choice is
  // deliberate, so `singleFile` skips SOFT exclusions (logs, lockfiles, hidden)
  // — but the SECURITY hard-lock (.env, *.pem, id_rsa*, .aws/, ...) always
  // applies. The hard-lock is checked against `securityPath` (the absolute,
  // symlink-resolved path) so credential files are caught by parent directory
  // even when relativePath is a bare basename, and a benignly-named symlink to a
  // secret can't dodge it.
  function considerFile(
    full: string,
    relativePath: string,
    s: Stats,
    singleFile: boolean,
    securityPath: string = full,
  ): void {
    const security = checkSecurityExclusion(securityPath);
    if (security) {
      securityExcludedRaw.push({
        relativePath,
        sizeBytes: s.size,
        reason: security.reason,
        label: security.label,
      });
      return;
    }
    const softExclusion = singleFile ? undefined : checkSoftExclusion(relativePath);
    if (softExclusion) {
      defaultExcludedRaw.push({
        relativePath,
        sizeBytes: s.size,
        reason: softExclusion.reason,
        label: softExclusion.label,
      });
    }

    const classification = classifyFile(full);

    if (s.size > LARGE_FILE_BYTES) {
      largeFilesCount += 1;
      largeFilesBytes += s.size;
      if (largeFilesRaw.length < SAMPLE_CAP) {
        largeFilesRaw.push({ relativePath, sizeBytes: s.size, classification });
      }
    }

    files.push({
      absolutePath: full,
      relativePath,
      sizeBytes: s.size,
      mtime: s.mtimeMs,
      classification,
      ...(softExclusion ? { exclusion: softExclusion } : {}),
    });
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      // Skip hidden DIRECTORIES wholesale (.git, .cache, .venv, etc. — almost
      // always config/state, never personal-knowledge content). Hidden FILES
      // (.env, .bashrc) fall through to checkExclusion so they're either
      // security-blocked (.env) or routed to the soft-exclude "hidden" tier
      // (which the user can opt into per-ingest).
      if (entry.isDirectory() && entry.name.startsWith(".")) {
        if (skipDirs.has(entry.name)) skippedDirs.push(join(dir, entry.name));
        continue;
      }
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

      // relativePath is computed relative to the scan root (a directory here).
      considerFile(full, full.slice(absoluteRoot.length + 1), s, false);
    }
  }

  // A source can be a single file, not just a directory. Stat the root once to
  // decide: a file is scanned on its own (relativePath = its basename); a
  // directory is walked recursively. A missing/unreadable root yields an empty
  // result (walk's readdir fails silently), matching prior behavior.
  let rootStat: Stats | undefined;
  try {
    rootStat = await stat(absoluteRoot);
  } catch {
    rootStat = undefined;
  }
  if (rootStat?.isFile()) {
    // Resolve symlinks so the hard-lock sees the true target's path — a benign
    // link name must not let a secret (e.g. a link to ~/.env) slip in.
    const realRoot = await realpath(absoluteRoot).catch(() => absoluteRoot);
    considerFile(absoluteRoot, basename(absoluteRoot), rootStat, true, realRoot);
  } else {
    // Canonicalize the directory root so a symlinked source dir — an innocuous
    // alias pointing at, say, ~/.ssh — is walked and security-checked against
    // its true target path, not the alias (which would dodge the hard-lock and
    // let credential files into the index). `walk` slices relativePath against
    // absoluteRoot, so updating it here keeps paths source-relative.
    absoluteRoot = await realpath(absoluteRoot).catch(() => absoluteRoot);
    await walk(absoluteRoot, 0);
  }

  return {
    rootPath: absoluteRoot,
    files,
    summary: summarize(files),
    skippedDirs,
    defaultExcluded: summarizeExclusion(defaultExcludedRaw),
    securityExcluded: summarizeExclusion(securityExcludedRaw),
    largeFiles: {
      count: largeFilesCount,
      totalBytes: largeFilesBytes,
      sample: largeFilesRaw,
    },
  };
}

function summarizeExclusion(rows: ExcludedFile[]): ExclusionSummary {
  const byReason: Partial<Record<ExclusionReason, number>> = {};
  const byLabel: Record<string, number> = {};
  for (const r of rows) {
    byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    byLabel[r.label] = (byLabel[r.label] ?? 0) + 1;
  }
  return {
    byReason,
    byLabel,
    totalCount: rows.length,
    sample: rows.slice(0, SAMPLE_CAP),
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
    // Soft-excluded files are in files[] but shouldn't count toward the
    // "Will ingest / Deferred / Skipped" headline numbers — they're already
    // tallied in defaultExcluded.byLabel which the UI surfaces separately.
    if (f.exclusion) continue;
    const { classification } = f;
    byLabel[classification.label] = (byLabel[classification.label] ?? 0) + 1;
    byCategory[classification.category] += 1;
    totalBytes += f.sizeBytes;
    if (classification.category === "deferred" && classification.note) {
      const existing = deferredAgg.get(classification.label);
      if (existing) {
        existing.count += 1;
      } else {
        deferredAgg.set(classification.label, { count: 1, note: classification.note });
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
