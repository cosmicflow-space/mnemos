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

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  classifyFile,
  type Classification,
  type FileCategory,
} from "./classify";
import {
  checkExclusion,
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
  const absoluteRoot = resolve(rootPath);

  const files: ScannedFile[] = [];
  const skippedDirs: string[] = [];
  const defaultExcludedRaw: ExcludedFile[] = [];
  const securityExcludedRaw: ExcludedFile[] = [];
  const largeFilesRaw: LargeFileSummary["sample"] = [];
  let largeFilesCount = 0;
  let largeFilesBytes = 0;

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

      const relativePath = full.slice(absoluteRoot.length + 1);

      // 1. Exclusion check (security + default-noise).
      // Security-tier files are tracked in summary but NEVER reach files[]
      // — they can't be opted back in. Soft-excluded files DO go into files[]
      // tagged with their exclusion verdict so the pipeline can re-include
      // them based on user overrides.
      const exclusion = checkExclusion(relativePath);
      if (exclusion?.hardLocked) {
        securityExcludedRaw.push({
          relativePath,
          sizeBytes: s.size,
          reason: exclusion.reason,
          label: exclusion.label,
        });
        continue;
      }
      if (exclusion) {
        defaultExcludedRaw.push({
          relativePath,
          sizeBytes: s.size,
          reason: exclusion.reason,
          label: exclusion.label,
        });
      }

      // 2. Classification (loader / category)
      const classification = classifyFile(full);

      // 3. Large-file flag — INCLUDE the file, but tally separately
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
        ...(exclusion ? { exclusion } : {}),
      });
    }
  }

  await walk(absoluteRoot, 0);

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
