/**
 * Credential auto-detection.
 *
 * Scans well-known locations on the user's machine for already-configured
 * provider credentials so developers don't have to paste keys they already
 * have on disk. Mirrors how `gh auth status` and `aws configure list` feel.
 *
 * Design constraints:
 * - Existence-only by default. The scanner reports which files/env vars
 *   *exist*, never their values, until the user clicks "Use this one".
 * - Honors the project's read-only-by-default architecture invariant —
 *   no file path outside this fixed allowlist is ever read.
 * - Anthropic OAuth tokens (Claude Code's credential store) are detected but
 *   flagged as non-importable because Anthropic's API rejects OAuth tokens
 *   issued for first-party apps; the spirit is to be honest, not silently
 *   broken.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "local"
  | "anthropic-oauth";

export type DetectedCredential = {
  /** Which provider this credential is for. */
  provider: ProviderId;
  /** Env var name that would carry this credential, if any. */
  envVar?: string;
  /** Kind of source we found it in (governs how we read it). */
  source: "env" | "rc-file" | "json-file" | "reachable";
  /** Display string for the user (path relative to ~, or a URL). */
  location: string;
  /** Whether this credential can be used by Mnemos (false = TOS / scope mismatch). */
  importable: boolean;
  /** User-facing explanation. Especially important when importable is false. */
  note?: string;
};

export type CredentialScan = {
  scannedAt: string;
  hostPlatform: NodeJS.Platform;
  found: DetectedCredential[];
};

const HOME = homedir();
const rel = (p: string): string => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

// ── Provider files we look for ──────────────────────────────────────────────
type FileSpec = {
  provider: ProviderId;
  envVar?: string;
  path: string;
  importable: boolean;
  note?: string;
};

const FILE_SPECS: FileSpec[] = [
  // Anthropic API key — official CLI tool stores it here as { api_key: "..." }
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    path: join(HOME, ".anthropic", "auth.json"),
    importable: true,
  },
  // Anthropic OAuth (Claude Code) — cannot be reused by third-party harnesses
  {
    provider: "anthropic-oauth",
    path: join(HOME, ".claude", ".credentials.json"),
    importable: false,
    note: "Claude Code OAuth token detected. Anthropic restricts these to first-party apps; generate a separate API key at console.anthropic.com to use Claude in Mnemos.",
  },
  // OpenAI API key — community CLI tools commonly use these locations
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    path: join(HOME, ".openai", "auth.json"),
    importable: true,
  },
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    path: join(HOME, ".config", "openai", "auth.json"),
    importable: true,
  },
  // Google Cloud ADC — the legitimate reuse path for Gemini via Vertex AI
  {
    provider: "gemini",
    path: join(HOME, ".config", "gcloud", "application_default_credentials.json"),
    importable: true,
    note: "Google Cloud Application Default Credentials. Mnemos can use these via Vertex AI without an API key (wiring lands in v0.2 — for now, paste a Gemini API key from aistudio.google.com).",
  },
];

// Shell rc files we look at for KEY=VAL exports
const RC_FILES = [
  join(HOME, ".zshrc"),
  join(HOME, ".zprofile"),
  join(HOME, ".bashrc"),
  join(HOME, ".bash_profile"),
  join(HOME, ".profile"),
  join(HOME, ".envrc"),
];

// Env var names we recognize across providers
const ENV_VAR_MAP: Record<string, ProviderId> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GEMINI_API_KEY: "gemini",
  GOOGLE_API_KEY: "gemini",
  OLLAMA_HOST: "ollama",
  OLLAMA_BASE_URL: "ollama",
};

// ── Scanning ────────────────────────────────────────────────────────────────

function scanEnvVars(): DetectedCredential[] {
  const out: DetectedCredential[] = [];
  for (const [envVar, provider] of Object.entries(ENV_VAR_MAP)) {
    const v = process.env[envVar];
    if (v && v.trim().length > 0) {
      out.push({
        provider,
        envVar,
        source: "env",
        location: `process.env.${envVar}`,
        importable: true,
      });
    }
  }
  return out;
}

function scanRcFiles(): DetectedCredential[] {
  const out: DetectedCredential[] = [];
  const seen = new Set<string>();
  for (const file of RC_FILES) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Match: optional `export ` prefix, KEY, `=`, value (quoted or unquoted)
    const re = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[1];
      if (!key) continue;
      const provider = ENV_VAR_MAP[key];
      if (!provider) continue;
      const dedupe = `${file}:${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        provider,
        envVar: key,
        source: "rc-file",
        location: rel(file),
        importable: true,
      });
    }
  }
  return out;
}

function scanFiles(): DetectedCredential[] {
  return FILE_SPECS.filter((spec) => existsSync(spec.path)).map((spec) => ({
    provider: spec.provider,
    envVar: spec.envVar,
    source: spec.path.endsWith(".json") ? "json-file" as const : "rc-file" as const,
    location: rel(spec.path),
    importable: spec.importable,
    note: spec.note,
  }));
}

async function scanOllama(): Promise<DetectedCredential[]> {
  const base = process.env.OLLAMA_HOST ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const r = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return [];
    return [
      {
        provider: "ollama",
        source: "reachable",
        location: base,
        importable: true,
      },
    ];
  } catch {
    return [];
  }
}

export async function scanCredentials(): Promise<CredentialScan> {
  const [envHits, rcHits, fileHits, ollamaHits] = await Promise.all([
    Promise.resolve(scanEnvVars()),
    Promise.resolve(scanRcFiles()),
    Promise.resolve(scanFiles()),
    scanOllama(),
  ]);
  return {
    scannedAt: new Date().toISOString(),
    hostPlatform: process.platform,
    found: [...envHits, ...rcHits, ...fileHits, ...ollamaHits],
  };
}

// ── Importing (reads the actual value, with the user's explicit click) ──────

export type ImportRequest = {
  provider: ProviderId;
  source: "env" | "rc-file" | "json-file";
  location: string; // must match a previously-scanned location
};

export type ImportResult = {
  ok: true;
  provider: ProviderId;
  envVar: string;
  /** Last 4 chars of the imported value — for UI confirmation, not the value itself. */
  fingerprint: string;
} | {
  ok: false;
  error: string;
};

function readApiKeyFromJsonFile(path: string): string | null {
  try {
    const txt = readFileSync(path, "utf8");
    const j = JSON.parse(txt) as Record<string, unknown>;
    // Common shapes — try the obvious keys
    for (const key of ["api_key", "apiKey", "access_token", "key"]) {
      const v = j[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    // not JSON or unreadable
  }
  return null;
}

function readEnvFromRcFile(path: string, envVar: string): string | null {
  try {
    const txt = readFileSync(path, "utf8");
    const re = new RegExp(`^\\s*(?:export\\s+)?${envVar}\\s*=\\s*['"]?([^'"\\n#]+?)['"]?\\s*(?:#.*)?$`, "m");
    const m = re.exec(txt);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Resolve a relative location (`~/...`) back to absolute. */
function unrel(loc: string): string {
  return loc.startsWith("~") ? join(HOME, loc.slice(1)) : loc;
}

/**
 * Server-side allowlist check — refuses to open any path outside the fixed
 * set the scanner knows about. The UI promises "we only ever read these
 * specific locations"; this enforces that promise on the server contract
 * regardless of what the client sends.
 */
export function isAllowedLocation(req: ImportRequest): boolean {
  if (req.source === "env") {
    const envVar = req.location.replace(/^process\.env\./, "");
    return envVar in ENV_VAR_MAP && req.location === `process.env.${envVar}`;
  }
  const absolute = unrel(req.location);
  if (req.source === "json-file") {
    return FILE_SPECS.some(
      (spec) => spec.path === absolute && spec.provider === req.provider,
    );
  }
  if (req.source === "rc-file") {
    return RC_FILES.includes(absolute);
  }
  return false;
}

export function readCredentialValue(req: ImportRequest): string | null {
  if (req.provider === "anthropic-oauth") return null; // never importable
  if (!isAllowedLocation(req)) return null;
  if (req.source === "env") {
    const envVar = req.location.replace(/^process\.env\./, "");
    return process.env[envVar] ?? null;
  }
  if (req.source === "json-file") {
    return readApiKeyFromJsonFile(unrel(req.location));
  }
  if (req.source === "rc-file") {
    const envVar = ENV_VAR_MAP_INVERSE[req.provider];
    if (!envVar) return null;
    return readEnvFromRcFile(unrel(req.location), envVar);
  }
  return null;
}

const ENV_VAR_MAP_INVERSE: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function fingerprint(value: string): string {
  if (value.length <= 4) return "•".repeat(value.length);
  return "••••" + value.slice(-4);
}
