"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type ProviderId = "anthropic" | "openai" | "gemini" | "ollama" | "local";

type ConfigStatus = {
  provider: ProviderId | null;
  hasCredential: boolean;
  embedding: string;
  ready: boolean;
  reason: string | null;
  registeredChatProviders: string[];
};

type DetectedCredential = {
  provider: ProviderId | "anthropic-oauth" | "codex-oauth";
  envVar?: string;
  source: "env" | "rc-file" | "json-file" | "reachable";
  location: string;
  importable: boolean;
  note?: string;
};

type CredentialScan = {
  scannedAt: string;
  hostPlatform: string;
  found: DetectedCredential[];
};

type ProviderMeta = {
  id: ProviderId;
  name: string;
  blurb: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  keyHint?: string;
  consoleUrl?: string;
  consoleLabel?: string;
  howTo?: string;
};

const PROVIDERS: ProviderMeta[] = [
  {
    id: "anthropic",
    name: "Claude (Anthropic)",
    blurb: "Frontier model via API key. Best general-purpose answers.",
    needsKey: true,
    needsBaseUrl: false,
    keyHint: "sk-ant-…",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    consoleLabel: "console.anthropic.com",
    howTo: "Sign in → Settings → API Keys → Create Key. Starts with sk-ant-.",
  },
  {
    id: "openai",
    name: "GPT (OpenAI)",
    blurb: "Frontier model via API key. Also provides embeddings.",
    needsKey: true,
    needsBaseUrl: false,
    keyHint: "sk-…",
    consoleUrl: "https://platform.openai.com/api-keys",
    consoleLabel: "platform.openai.com/api-keys",
    howTo: "Sign in → API keys → Create new secret key. Starts with sk-. (Note: separate from a ChatGPT Plus subscription.)",
  },
  {
    id: "gemini",
    name: "Gemini (Google)",
    blurb: "Frontier model via API key. Long context window.",
    needsKey: true,
    needsBaseUrl: false,
    keyHint: "AIza…",
    consoleUrl: "https://aistudio.google.com/apikey",
    consoleLabel: "aistudio.google.com/apikey",
    howTo: "Sign in with a Google account → Get API key → Create. Starts with AIza. (Google Cloud ADC support via Vertex AI is coming.)",
  },
  {
    id: "ollama",
    name: "Ollama (local daemon)",
    blurb: "Fully local, no API key. Requires `ollama serve` running.",
    needsKey: false,
    needsBaseUrl: true,
  },
  {
    id: "local",
    name: "Local (bundled runtime)",
    blurb: "Bundled llama.cpp runtime. No key, no API call. First-time use downloads a small model (~400 MB, Apache 2.0) from HuggingFace.",
    needsKey: false,
    needsBaseUrl: false,
  },
];

function providerLabel(p: ProviderId | "anthropic-oauth" | "codex-oauth"): string {
  if (p === "anthropic-oauth") return "Anthropic (OAuth)";
  if (p === "codex-oauth") return "OpenAI Codex (OAuth)";
  return PROVIDERS.find((x) => x.id === p)?.name ?? p;
}

type OllamaModelsResponse = {
  reachable: boolean;
  baseUrl: string;
  models: Array<{ name: string; sizeBytes: number | null }>;
};

export default function AgentPage() {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const router = useRouter();
  const [scan, setScan] = useState<CredentialScan | null>(null);
  const [choice, setChoice] = useState<ProviderId>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [ollamaModels, setOllamaModels] = useState<OllamaModelsResponse | null>(null);
  const [ollamaModel, setOllamaModel] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (choice === "ollama" && !ollamaModels) {
      void fetch("/api/ollama/models", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<OllamaModelsResponse>) : null))
        .then((data) => {
          if (!data) return;
          setOllamaModels(data);
          if (!ollamaModel && data.models.length > 0) {
            // Prefer a small fast model if available, else first.
            const preferred =
              data.models.find((m) => m.name === "llama3.2:3b") ??
              data.models.find((m) => m.name.startsWith("llama3.2")) ??
              data.models.find((m) => m.name.includes(":3b") || m.name.includes(":7b")) ??
              data.models[0];
            if (preferred) setOllamaModel(preferred.name);
          }
        })
        .catch(() => {
          /* network failure — leave dropdown empty */
        });
    }
  }, [choice, ollamaModels, ollamaModel]);

  async function refresh() {
    try {
      const [statusRes, scanRes] = await Promise.all([
        fetch("/api/config", { cache: "no-store" }),
        fetch("/api/credentials/scan", { cache: "no-store" }),
      ]);
      if (statusRes.ok) {
        const s = (await statusRes.json()) as ConfigStatus;
        setStatus(s);
        if (s.provider) setChoice(s.provider);
      }
      if (scanRes.ok) {
        setScan((await scanRes.json()) as CredentialScan);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const meta = PROVIDERS.find((p) => p.id === choice)!;
      const body: Record<string, string> = { provider: choice };
      if (meta.needsKey && apiKey.trim()) body.apiKey = apiKey.trim();
      if (meta.needsBaseUrl && ollamaUrl.trim()) body.ollamaBaseUrl = ollamaUrl.trim();
      if (choice === "ollama" && ollamaModel.trim()) body.ollamaModel = ollamaModel.trim();
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = (await r.json()) as { error?: string; message?: string };
        throw new Error(err.message ?? err.error ?? `HTTP ${r.status}`);
      }
      const s = (await r.json()) as ConfigStatus;
      setStatus(s);
      setApiKey("");
      setSavedAt(Date.now());
      // Frictionless flow: if the config is complete, route the user back
      // home automatically after a brief confirmation window. The 1500ms
      // delay lets the "✓ Saved" badge register visually before the
      // navigation, so the user knows the save succeeded before the screen
      // changes. If the config is incomplete (e.g. missing API key), stay
      // on the page so they can fix it.
      if (s.ready) {
        setTimeout(() => router.push("/"), 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleImport(hit: DetectedCredential) {
    if (!hit.importable) return;
    const id = `${hit.provider}:${hit.location}`;
    setImporting(id);
    setError(null);
    try {
      if (hit.provider === "ollama") {
        // Ollama "import" just sets the base URL — no credential involved.
        const r = await fetch("/api/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "ollama", ollamaBaseUrl: hit.location }),
        });
        if (!r.ok) throw new Error(await r.text());
        const s = (await r.json()) as ConfigStatus;
        setStatus(s);
        setChoice("ollama");
        setSavedAt(Date.now());
        if (s.ready) {
          setTimeout(() => router.push("/"), 1500);
        }
        return;
      }
      const r = await fetch("/api/credentials/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: hit.provider,
          source: hit.source,
          location: hit.location,
        }),
      });
      const j = (await r.json()) as { ok?: boolean; status?: ConfigStatus; error?: string; message?: string };
      if (!r.ok || !j.ok) throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      if (j.status) {
        setStatus(j.status);
        setChoice(j.status.provider ?? choice);
      }
      setSavedAt(Date.now());
      if (j.status?.ready) {
        setTimeout(() => router.push("/"), 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
    }
  }

  const meta = PROVIDERS.find((p) => p.id === choice)!;
  const ollamaScanHit = scan?.found.find((f) => f.provider === "ollama");
  const registered = new Set(status?.registeredChatProviders ?? []);
  const isWired = (id: ProviderId): boolean => registered.has(id);

  return (
    <main className="min-h-screen px-6 py-12 max-w-3xl mx-auto">
      <header className="mb-10 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 text-cyan-300 hover:text-cyan-200 transition">
          <span className="text-2xl">←</span>
          <span className="text-lg">mnemos</span>
        </Link>
        <h1 className="text-2xl font-semibold text-fg">Agent</h1>
      </header>

      <section className="mb-8 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Current status</h2>
        {!status ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : status.ready ? (
          <p className="text-sm text-cyan-300">
            ✓ Ready — chat via <span className="font-mono">{status.provider}</span>, embeddings via{" "}
            <span className="font-mono">{status.embedding}</span>.
          </p>
        ) : (
          <p className="text-sm text-amber-300">⚠ Not ready — {status.reason ?? "no provider configured."}</p>
        )}
      </section>

      {scan && scan.found.length > 0 && (
        <section className="mb-8 rounded-lg border border-cyan-700/40 bg-cyan-500/5 p-5">
          <h2 className="text-sm uppercase tracking-wider text-cyan-300 mb-1">Detected on your machine</h2>
          <p className="text-xs text-muted mb-4">
            Mnemos scanned standard credential locations. Nothing has been imported — click <em>Use this</em> on a row to copy it into <span className="font-mono">~/.mnemos/.env</span>.
          </p>
          <ul className="space-y-2">
            {scan.found.map((hit) => {
              const id = `${hit.provider}:${hit.location}`;
              return (
                <li
                  key={id}
                  className="flex items-start justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-line bg-elevated px-2 py-0.5 text-xs uppercase text-fg/80">
                        {providerLabel(hit.provider)}
                      </span>
                      <span className="font-mono text-xs text-muted truncate">{hit.location}</span>
                    </div>
                    {hit.note && (
                      <p className="mt-1 text-xs text-muted">{hit.note}</p>
                    )}
                  </div>
                  {!hit.importable ? (
                    <span className="rounded-md border border-line px-3 py-1 text-xs text-muted">
                      Cannot reuse
                    </span>
                  ) : hit.provider !== "anthropic-oauth" && !registered.has(hit.provider) ? (
                    <span className="rounded-md border border-amber-700/50 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
                      Coming soon
                    </span>
                  ) : status?.provider === hit.provider && status?.ready ? (
                    <span className="rounded-md border border-cyan-700/50 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300 font-medium">
                      ✓ In use
                    </span>
                  ) : (
                    <button
                      onClick={() => void handleImport(hit)}
                      disabled={importing === id}
                      className="rounded-md bg-cyan-600 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-500 transition disabled:opacity-50"
                    >
                      {importing === id ? "Importing…" : hit.provider === "ollama" ? "Use Ollama" : "Use this"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        <fieldset>
          <legend className="text-sm uppercase tracking-wider text-muted mb-3">Chat provider</legend>
          <div className="space-y-2">
            {PROVIDERS.map((p) => {
              const wired = isWired(p.id);
              return (
              <label
                key={p.id}
                className={`flex items-start gap-3 rounded-md border px-4 py-3 transition ${
                  !wired
                    ? "border-line bg-surface opacity-60 cursor-not-allowed"
                    : choice === p.id
                    ? "border-cyan-500 bg-cyan-500/10 cursor-pointer"
                    : "border-line bg-surface hover:border-line cursor-pointer"
                }`}
              >
                <input
                  type="radio"
                  name="provider"
                  value={p.id}
                  checked={choice === p.id}
                  onChange={() => wired && setChoice(p.id)}
                  disabled={!wired}
                  className="mt-1 accent-cyan-500"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-fg flex items-center gap-2">
                    {p.name}
                    {!wired && (
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                        Coming soon
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted mt-0.5">{p.blurb}</div>
                  {choice === p.id && p.consoleUrl && (
                    <div className="mt-2 text-xs">
                      <a
                        href={p.consoleUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                      >
                        Get an API key → {p.consoleLabel}
                      </a>
                      {p.howTo && (
                        <p className="text-muted mt-1">{p.howTo}</p>
                      )}
                    </div>
                  )}
                  {choice === p.id && p.id === "ollama" && (
                    <div className="mt-3 space-y-2 text-xs">
                      {ollamaScanHit ? (
                        <span className="text-cyan-300">✓ Reachable at <span className="font-mono">{ollamaScanHit.location}</span></span>
                      ) : (
                        <div className="space-y-1">
                          <span className="text-amber-300">✗ Not reachable.</span>
                          <pre className="rounded bg-app border border-line px-2 py-1 text-fg inline-block">ollama serve</pre>
                        </div>
                      )}
                      {ollamaModels && ollamaModels.reachable && (
                        <div>
                          <label htmlFor="ollama-model" className="block text-muted mb-1">
                            Model {ollamaModels.models.length === 0 && "(none installed)"}
                          </label>
                          {ollamaModels.models.length === 0 ? (
                            <div className="text-amber-300">
                              No models pulled yet. Try{" "}
                              <code className="rounded bg-app border border-line px-1.5 py-0.5 text-fg">ollama pull llama3.2:3b</code>
                              {" "}then refresh.
                            </div>
                          ) : (
                            <select
                              id="ollama-model"
                              value={ollamaModel}
                              onChange={(e) => setOllamaModel(e.target.value)}
                              className="w-full rounded-md bg-app border border-line px-3 py-2 font-mono text-fg focus:outline-none focus:border-cyan-500"
                            >
                              {ollamaModels.models.map((m) => (
                                <option key={m.name} value={m.name}>
                                  {m.name}{m.sizeBytes ? ` (${(m.sizeBytes / 1e9).toFixed(1)} GB)` : ""}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {choice === p.id && p.id === "local" && (
                    <p className="mt-2 text-xs text-muted">
                      Default model: Qwen 2.5 0.5B (Q4_K_M, ~400 MB, Apache 2.0). Auto-download on first Save (UI in next pass).
                    </p>
                  )}
                </div>
              </label>
              );
            })}
          </div>
        </fieldset>

        {meta.needsKey && (
          <div>
            <label className="block text-sm uppercase tracking-wider text-muted mb-2">API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status?.hasCredential && status.provider === choice ? "•••••••• (already saved — leave blank to keep)" : meta.keyHint ?? ""}
              autoComplete="off"
              className="w-full rounded-md bg-app border border-line px-4 py-2.5 text-fg font-mono text-sm focus:outline-none focus:border-cyan-500 transition"
            />
            <p className="text-xs text-muted mt-1.5">
              Stored at <span className="font-mono">~/.mnemos/.env</span> (chmod 600). Never sent to any third party.
            </p>
          </div>
        )}

        {meta.needsBaseUrl && (
          <div>
            <label className="block text-sm uppercase tracking-wider text-muted mb-2">Ollama base URL</label>
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className="w-full rounded-md bg-app border border-line px-4 py-2.5 text-fg font-mono text-sm focus:outline-none focus:border-cyan-500 transition"
            />
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-cyan-500 px-5 py-2.5 text-sm font-semibold text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {savedAt && !error && (
            <span className="text-sm text-cyan-300">
              ✓ Saved{status?.ready ? " — returning home…" : ""}
            </span>
          )}
        </div>
      </form>
    </main>
  );
}
