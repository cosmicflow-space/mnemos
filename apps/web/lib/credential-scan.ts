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
 * - First-party CLI OAuth tokens (Claude Code, OpenAI codex CLI) are detected
 *   but flagged as non-importable because the vendors restrict third-party
 *   reuse of those credentials — Anthropic explicitly prohibits it per their
 *   Feb 2026 docs, and OpenAI does not document third-party reuse. The spirit
 *   is to be honest about TOS, not silently broken.
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
  | "anthropic-oauth"
  | "codex-oauth";

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
    note: "Claude Code OAuth token detected. Anthropic explicitly prohibits third-party reuse of these tokens (per Feb 2026 docs at code.claude.com/docs/en/legal-and-compliance). Generate a separate API key at console.anthropic.com to use Claude in Mnemos.",
  },
  // OpenAI codex CLI OAuth — cannot be reused by third-party harnesses
  {
    provider: "codex-oauth",
    path: join(HOME, ".codex", "auth.json"),
    importable: false,
    note: "OpenAI codex CLI OAuth token detected. The codex CLI's OAuth flow is a first-party CLI auth path — Mnemos does not import or reuse it. Generate a separate API key at platform.openai.com to use GPT in Mnemos.",
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
  // Google Cloud ADC — detected for transparency, but not importable in v0.1
  // because the proper Vertex AI auth path isn't wired yet. The generic JSON
  // importer would otherwise treat the OAuth access_token in the ADC file as
  // a Gemini API key, which is incorrect. Vertex AI wiring lands in v0.2.
  {
    provider: "gemini",
    path: join(HOME, ".config", "gcloud", "application_default_credentials.json"),
    importable: false,
    note: "Google Cloud Application Default Credentials detected. Mnemos v0.1 does not yet wire Vertex AI auth (the proper consumer for ADC). Paste a Gemini API key from aistudio.google.com instead; Vertex AI / ADC support is planned for v0.2.",
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
// Note: GOOGLE_API_KEY is intentionally NOT mapped here even though Google
// docs accept either GEMINI_API_KEY or GOOGLE_API_KEY. The import path
// reconstructs the env var from provider ID via ENV_VAR_MAP_INVERSE (which is
// 1:1), so detecting GOOGLE_API_KEY would produce a "Use this" button that
// then looks up the wrong env var name. v0.2 will propagate envVar through
// ImportRequest so we can re-add GOOGLE_API_KEY detection cleanly.
const ENV_VAR_MAP: Record<string, ProviderId> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GEMINI_API_KEY: "gemini",
  OLLAMA_HOST: "ollama",
  OLLAMA_BASE_URL: "ollama",
};

// ── Scanning ────────────────────────────────────────────────────────────────

function scanEnvVars(): DetectedCredential[] {
  const out: DetectedCredential[] = [];
  for (const [envVar, provider] of Object.entries(ENV_VAR_MAP)) {
    const v = process.env[envVar];
    if (v && v.trim().length > 0) {
      // Ollama env/rc hits report the env-var location string rather than the
      // actual URL value — the UI's import path writes `hit.location` directly
      // into ollamaBaseUrl, which would produce broken config. The reachable
      // detection (live probe at :11434) is the working import path. Surface
      // env/rc hits for transparency but mark them non-importable in v0.1.
      const importable = provider !== "ollama";
      const note = provider === "ollama"
        ? "Detected, but env/rc import isn't wired in v0.1. Start the Ollama daemon and re-scan — the live detection at the daemon URL is the working import path. Or paste the URL into the Ollama base-URL field manually."
        : undefined;
      out.push({
        provider,
        envVar,
        source: "env",
        location: `process.env.${envVar}`,
        importable,
        ...(note ? { note } : {}),
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
      // Same reason as scanEnvVars: Ollama rc-file hits report the file path
      // rather than the URL value, so the UI import path produces broken
      // config. Mark non-importable and direct users to the live probe.
      const importable = provider !== "ollama";
      const note = provider === "ollama"
        ? "Detected, but env/rc import isn't wired in v0.1. Start the Ollama daemon and re-scan — the live detection at the daemon URL is the working import path. Or paste the URL into the Ollama base-URL field manually."
        : undefined;
      out.push({
        provider,
        envVar: key,
        source: "rc-file",
        location: rel(file),
        importable,
        ...(note ? { note } : {}),
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
  if (!isAllowedLocation(req)) return null;

  // Structural enforcement of the FILE_SPECS `importable` flag. The UI marks
  // some files as non-importable (Anthropic OAuth, OpenAI codex OAuth, Google
  // ADC), but the API route is a separate trust boundary. Without this
  // check, a caller could POST to /api/credentials/import with a registered
  // location whose `importable` is false and have it succeed. Enforcing the
  // flag here catches any future non-importable entry without needing a
  // matching hardcoded refusal.
  if (req.source === "json-file") {
    const absolute = unrel(req.location);
    const spec = FILE_SPECS.find(
      (s) => s.path === absolute && s.provider === req.provider,
    );
    if (spec && !spec.importable) return null;
  }

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
