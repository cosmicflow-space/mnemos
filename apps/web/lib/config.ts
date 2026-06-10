/**
 * Provider configuration state, persisted to `~/.mnemos/.env`.
 *
 * The web UI is gated on this state: until a chat provider is chosen and
 * (for frontier providers) a credential is on file, the user lands on the
 * /agent page first.
 *
 * Single-file persistence intentionally — one operator, one machine, one
 * config file. The same file is read by `setup.mjs` at install time.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRegistry } from "@/lib/runtime";

export type ProviderId =
  | "anthropic"
  | "openai"
  | "codex"
  | "gemini"
  | "ollama"
  | "local";

export const PROVIDER_IDS: ProviderId[] = [
  "anthropic",
  "openai",
  "codex",
  "gemini",
  "ollama",
  "local",
];

const ENV_KEY_FOR_PROVIDER: Record<ProviderId, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  codex: "CODEX_API_KEY",
  gemini: "GEMINI_API_KEY",
  ollama: null,
  local: null,
};

/** Codex is dual-auth: an existing `codex login` session (~/.codex/auth.json,
 * ChatGPT-plan usage) counts as configured even with no CODEX_API_KEY set.
 * The env key remains the future swap path to metered API billing. */
function hasCodexLoginSession(): boolean {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return existsSync(join(codexHome, "auth.json"));
}

/** The env var that holds a provider's API key, or null for providers that
 * need no credential (ollama, local). Used by routes to name the exact var a
 * user must set when a credential is missing. */
export function envKeyForProvider(provider: string): string | null {
  return ENV_KEY_FOR_PROVIDER[provider as ProviderId] ?? null;
}

/** True if the provider's API key is already on file (process env or
 * ~/.mnemos/.env). Providers that need no key (ollama, local) are always
 * "configured". Lets the UI badge each provider before the user picks it. */
export function isProviderConfigured(provider: string): boolean {
  if (provider === "codex" && hasCodexLoginSession()) return true;
  const envKey = ENV_KEY_FOR_PROVIDER[provider as ProviderId] ?? null;
  if (envKey === null) return true;
  const merged = readEnvFile();
  return Boolean((process.env[envKey] ?? merged[envKey] ?? "").trim());
}

export type ConfigStatus = {
  provider: ProviderId | null;
  hasCredential: boolean;
  embedding: string;
  ready: boolean;
  reason: string | null;
  /**
   * Provider IDs that are actually registered + callable right now. Stubs
   * (e.g. gemini, llama-cpp in v0.1) are NOT in this list, even though their
   * manifests appear in the plugin registry — they have no chat() impl.
   */
  registeredChatProviders: string[];
};

function listRegisteredChatProviders(): string[] {
  try {
    const reg = getRegistry();
    return [...reg.chatProviders.keys()];
  } catch {
    return [];
  }
}

function stateDir(): string {
  return process.env.MNEMOS_STATE_DIR ?? join(homedir(), ".mnemos");
}

function envFilePath(): string {
  return join(stateDir(), ".env");
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    out[key] = val;
  }
  return out;
}

function readEnvFile(): Record<string, string> {
  const p = envFilePath();
  if (!existsSync(p)) return {};
  try {
    return parseEnvFile(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeEnvFile(values: Record<string, string>): void {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines = [
    "# Mnemos config — managed by the /agent UI and setup.mjs",
    `# Last written: ${new Date().toISOString()}`,
    ...Object.entries(values)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `${k}=${v}`),
  ];
  const p = envFilePath();
  writeFileSync(p, lines.join("\n") + "\n");
  try {
    chmodSync(p, 0o600);
  } catch {
    // non-POSIX (Windows) — chmod unsupported, file ACLs handle it
  }
}

function currentProvider(merged: Record<string, string>): ProviderId | null {
  const raw = (process.env.MNEMOS_DEFAULT_PROVIDER ?? merged.MNEMOS_DEFAULT_PROVIDER ?? "").trim();
  return PROVIDER_IDS.includes(raw as ProviderId) ? (raw as ProviderId) : null;
}

function currentEmbedding(merged: Record<string, string>): string {
  return (
    process.env.MNEMOS_DEFAULT_EMBEDDING ??
    merged.MNEMOS_DEFAULT_EMBEDDING ??
    "embed-local"
  );
}

function hasKey(provider: ProviderId, merged: Record<string, string>): boolean {
  if (provider === "codex" && hasCodexLoginSession()) return true;
  const envKey = ENV_KEY_FOR_PROVIDER[provider];
  if (envKey === null) return true;
  return Boolean((process.env[envKey] ?? merged[envKey] ?? "").trim());
}

export function getConfigStatus(): ConfigStatus {
  const merged = readEnvFile();
  const provider = currentProvider(merged);
  const embedding = currentEmbedding(merged);
  const registeredChatProviders = listRegisteredChatProviders();

  if (!provider) {
    return {
      provider: null,
      hasCredential: false,
      embedding,
      ready: false,
      reason: "No chat provider chosen yet.",
      registeredChatProviders,
    };
  }
  // Stub providers ship a manifest but no chat() impl — we surface them as
  // "not ready" so the UI can show them greyed out and users don't get a
  // runtime error when they hit /chat.
  if (!registeredChatProviders.includes(provider)) {
    return {
      provider,
      hasCredential: hasKey(provider, merged),
      embedding,
      ready: false,
      reason: `Provider "${provider}" isn't wired up yet in this build (coming soon). Pick anthropic, openai, codex, gemini, or ollama for now.`,
      registeredChatProviders,
    };
  }
  const hasCredential = hasKey(provider, merged);
  if (!hasCredential) {
    const envKey = ENV_KEY_FOR_PROVIDER[provider];
    return {
      provider,
      hasCredential: false,
      embedding,
      ready: false,
      reason: `Provider "${provider}" is selected but ${envKey} is missing.`,
      registeredChatProviders,
    };
  }
  return {
    provider,
    hasCredential: true,
    embedding,
    ready: true,
    reason: null,
    registeredChatProviders,
  };
}

export type SetProviderInput = {
  provider: ProviderId;
  apiKey?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  /** The specific model selected in the UI. Persisted so server-initiated
   * queries (e.g. the Telegram bot) use the same model after a restart. */
  model?: string;
};

export function setProviderConfig(input: SetProviderInput): ConfigStatus {
  const merged = readEnvFile();
  merged.MNEMOS_DEFAULT_PROVIDER = input.provider;
  process.env.MNEMOS_DEFAULT_PROVIDER = input.provider;

  const envKey = ENV_KEY_FOR_PROVIDER[input.provider];
  if (envKey && input.apiKey) {
    const trimmed = input.apiKey.trim();
    if (trimmed) {
      merged[envKey] = trimmed;
      process.env[envKey] = trimmed;
    }
  }
  if (input.provider === "ollama") {
    if (input.ollamaBaseUrl) {
      const url = input.ollamaBaseUrl.trim();
      if (url) {
        merged.OLLAMA_BASE_URL = url;
        process.env.OLLAMA_BASE_URL = url;
      }
    }
    if (input.ollamaModel) {
      const model = input.ollamaModel.trim();
      if (model) {
        merged.MNEMOS_OLLAMA_MODEL = model;
        process.env.MNEMOS_OLLAMA_MODEL = model;
      }
    }
  }
  // Persist the UI's selected model so server-side callers (the Telegram bot)
  // mirror it. For ollama, keep MNEMOS_OLLAMA_MODEL in sync since the provider
  // reads that var specifically.
  if (input.model) {
    const m = input.model.trim();
    if (m) {
      merged.MNEMOS_DEFAULT_MODEL = m;
      process.env.MNEMOS_DEFAULT_MODEL = m;
      if (input.provider === "ollama") {
        merged.MNEMOS_OLLAMA_MODEL = m;
        process.env.MNEMOS_OLLAMA_MODEL = m;
      }
    }
  }
  writeEnvFile(merged);
  return getConfigStatus();
}

/** The UI's last-selected model, persisted in ~/.mnemos/.env. Used by the
 * Telegram bot so its answers use the same model you picked in the web UI.
 * Falls back to MNEMOS_OLLAMA_MODEL (the legacy local-model var), else
 * undefined → the provider's own default. */
export function getDefaultModel(): string | undefined {
  const merged = readEnvFile();
  const m = (process.env.MNEMOS_DEFAULT_MODEL ?? merged.MNEMOS_DEFAULT_MODEL ?? "").trim();
  if (m) return m;
  const om = (process.env.MNEMOS_OLLAMA_MODEL ?? merged.MNEMOS_OLLAMA_MODEL ?? "").trim();
  return om || undefined;
}

/** Set a single `~/.mnemos/.env` value (and process.env), preserving the rest.
 * Used for secrets that aren't provider API keys — e.g. the Telegram bot token.
 * An empty value removes the key. */
export function setEnvValue(key: string, value: string): void {
  const merged = readEnvFile();
  const v = value.trim();
  if (v) {
    merged[key] = v;
    process.env[key] = v;
  } else {
    delete merged[key];
    delete process.env[key];
  }
  writeEnvFile(merged);
}

/** The configured default chat provider id (MNEMOS_DEFAULT_PROVIDER), falling
 * back to local Ollama so background channels (e.g. Telegram) stay on-machine
 * until the operator picks otherwise. */
export function getDefaultProviderId(): string {
  return currentProvider(readEnvFile()) ?? "ollama";
}

/** Build a chat/embedding provider's credential map from the environment.
 * Shared by the query route and the Telegram channel so both initialize
 * providers identically. No hardcoded secrets — reads process.env only. */
export function credentialsForProvider(providerId: string): Record<string, string> {
  const c: Record<string, string> = {};
  if (providerId === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    c.apiKey = process.env.ANTHROPIC_API_KEY;
  } else if (providerId === "openai" && process.env.OPENAI_API_KEY) {
    c.apiKey = process.env.OPENAI_API_KEY;
  } else if (providerId === "codex") {
    // No key → the plugin falls back to the operator's `codex login` session.
    if (process.env.CODEX_API_KEY) c.apiKey = process.env.CODEX_API_KEY;
  } else if (providerId === "gemini") {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (key) c.apiKey = key;
  } else if (providerId === "ollama") {
    if (process.env.OLLAMA_BASE_URL) c.baseURL = process.env.OLLAMA_BASE_URL;
    if (process.env.MNEMOS_OLLAMA_MODEL) c.model = process.env.MNEMOS_OLLAMA_MODEL;
  }
  return c;
}

/**
 * Load `~/.mnemos/.env` into `process.env` on boot. Idempotent — values
 * already set in process.env win (matches the documented precedence).
 */
export function hydrateProcessEnv(): void {
  const merged = readEnvFile();
  for (const [k, v] of Object.entries(merged)) {
    if (!(k in process.env) && v.length > 0) {
      process.env[k] = v;
    }
  }
}
