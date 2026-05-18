/**
 * Default file-exclude rules applied during scan + ingest.
 *
 * Two tiers:
 *
 *   - **Security** patterns are *hard-locked*: matched files never appear in the
 *     scan result, never reach a loader, never end up in the vector store.
 *     Even if the user explicitly asks to include them, we refuse. Credentials
 *     and private keys cannot leak into a RAG index — period.
 *
 *   - **Default-noise** patterns (logs, lockfiles, minified bundles, transient
 *     temp/cache/backup files) are *soft-excluded*: matched files are tracked
 *     separately and surfaced in the UI with counts. The user can flip them on
 *     per-ingest via the scan-result toggles.
 *
 * Size is handled in a third dimension by the scanner — files > 10 MB are
 * flagged but NOT excluded, so the UI can prompt "10 files over 10 MB —
 * include them?" without silently dropping them.
 */

export type ExclusionReason =
  | "secret"        // hard-locked — never includable
  | "log"           // *.log, *.log.N
  | "lockfile"      // *-lock.*, *.lock, Cargo.lock
  | "minified"      // *.min.js, *.min.css, *.map
  | "transient"     // *.tmp, *.cache, *.bak, *~
  | "hidden";       // dotfiles not matched by a security rule (e.g. .bashrc, .zshrc)

type Pattern = {
  pattern: RegExp;
  reason: ExclusionReason;
  label: string;
};

const SECURITY_PATTERNS: Pattern[] = [
  { pattern: /(^|\/)\.env(\.|$)/, reason: "secret", label: ".env files" },
  { pattern: /\.pem$/i, reason: "secret", label: "PEM keys" },
  { pattern: /\.key$/i, reason: "secret", label: "private keys" },
  { pattern: /\.crt$/i, reason: "secret", label: "certificates" },
  { pattern: /(^|\/)id_(rsa|ecdsa|ed25519|dsa)(\.|$)/i, reason: "secret", label: "SSH keys" },
  { pattern: /(^|\/)\.npmrc$/, reason: "secret", label: ".npmrc" },
  { pattern: /(^|\/)\.netrc$/, reason: "secret", label: ".netrc" },
  { pattern: /(^|\/)credentials(\.|$)/i, reason: "secret", label: "credentials files" },
  { pattern: /(^|\/)\.aws\//, reason: "secret", label: ".aws/" },
];

const DEFAULT_EXCLUDE_PATTERNS: Pattern[] = [
  { pattern: /\.log($|\.)/i, reason: "log", label: "log files" },
  { pattern: /(package|pnpm|yarn|composer|bun)-lock\.(json|yaml|yml|lockb)$/, reason: "lockfile", label: "lockfiles" },
  { pattern: /Cargo\.lock$/, reason: "lockfile", label: "lockfiles" },
  { pattern: /Gemfile\.lock$/, reason: "lockfile", label: "lockfiles" },
  { pattern: /Pipfile\.lock$/, reason: "lockfile", label: "lockfiles" },
  { pattern: /poetry\.lock$/, reason: "lockfile", label: "lockfiles" },
  { pattern: /go\.sum$/, reason: "lockfile", label: "lockfiles" },
  { pattern: /\.lock$/i, reason: "lockfile", label: "lockfiles" },
  { pattern: /\.min\.(js|css)$/i, reason: "minified", label: "minified files" },
  { pattern: /\.map$/i, reason: "minified", label: "source maps" },
  { pattern: /\.tmp$/i, reason: "transient", label: "temp files" },
  { pattern: /\.cache$/i, reason: "transient", label: "cache files" },
  { pattern: /\.bak$/i, reason: "transient", label: "backup files" },
  { pattern: /~$/, reason: "transient", label: "backup files" },
  // Catch-all for dotfiles that didn't match a security or other default rule.
  // Order matters: this MUST be last so .env / id_rsa / *.pem hit the security
  // tier first. The match is per-basename ((^|/)\.) to avoid catching paths
  // that merely contain a dot in a parent dir.
  { pattern: /(^|\/)\.[^/]+$/, reason: "hidden", label: "hidden files" },
];

export type ExclusionVerdict = {
  reason: ExclusionReason;
  label: string;
  /** Hard-locked exclusions cannot be overridden by user opt-in. */
  hardLocked: boolean;
} | null;

/** Check whether a file path matches any exclude rule. */
export function checkExclusion(relativePath: string): ExclusionVerdict {
  for (const { pattern, reason, label } of SECURITY_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { reason, label, hardLocked: true };
    }
  }
  for (const { pattern, reason, label } of DEFAULT_EXCLUDE_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { reason, label, hardLocked: false };
    }
  }
  return null;
}

/** A user-facing flag set indicating which default-noise tiers to opt into. */
export type IncludeOverrides = {
  log?: boolean;
  lockfile?: boolean;
  minified?: boolean;
  transient?: boolean;
  hidden?: boolean;
};

/**
 * Whether a file should be excluded *given* user overrides. Security excludes
 * are always honored (hardLocked); soft excludes are honored unless the user
 * has explicitly opted that tier back in.
 */
export function shouldExclude(
  relativePath: string,
  overrides: IncludeOverrides = {},
): ExclusionVerdict {
  const verdict = checkExclusion(relativePath);
  if (!verdict) return null;
  if (verdict.hardLocked) return verdict;
  if (overrides[verdict.reason as keyof IncludeOverrides]) return null;
  return verdict;
}

export const LARGE_FILE_BYTES = 10 * 1024 * 1024;
