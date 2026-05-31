"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import type { RankedModel, SpeedTier, QualityTier } from "@/lib/model-ranking";

const SPEED_BADGE: Record<SpeedTier, { icon: string; label: string; cls: string }> = {
  fast: { icon: "⚡", label: "Fast", cls: "text-emerald-400" },
  moderate: { icon: "〰", label: "Moderate", cls: "text-amber-400" },
  slow: { icon: "🐢", label: "Slow on CPU", cls: "text-rose-400" },
};

// Short, honest accuracy hint. "strong" is the unremarkable good case (no note).
const QUALITY_NOTE: Partial<Record<QualityTier, string>> = {
  fair: "decent",
  basic: "lightweight — may be shallow",
  code: "code-focused — mixed for prose",
  reasoning: "reasoning model — thorough but slow",
};

function sizeLabel(bytes: number | null): string {
  if (bytes == null) return "";
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function modelMeta(m: RankedModel): string {
  const parts: string[] = [];
  if (m.paramsB != null) parts.push(`${m.paramsB}B`);
  const sz = sizeLabel(m.sizeBytes);
  if (sz) parts.push(sz);
  if (m.quant) parts.push(m.quant);
  return parts.join(" · ");
}

/** A credential the scanner found on disk. Values are never returned by the
 * scan — only locations + an `importable` flag. OAuth/subscription tokens are
 * importable: false (vendor ToS prohibits third-party reuse). */
type DetectedCredential = {
  provider: string;
  source: "env" | "rc-file" | "json-file" | "reachable";
  location: string;
  importable: boolean;
  note?: string;
};

type ModelInfo = {
  id: string;
  displayName: string;
  contextWindow: number;
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  pricedAsOf: string | null;
};

export type ProviderInfo = {
  id: string;
  displayName: string;
  needsKey: boolean;
  configured: boolean;
  envVar: string | null;
  credentialLabel: string | null;
  credentialDescription: string | null;
  models: ModelInfo[];
  defaultModel: string | null;
};

function extractUrl(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s)]+/);
  return m ? m[0] : null;
}

function priceLabel(m: ModelInfo): string {
  if (m.inputCostPer1M == null && m.outputCostPer1M == null) return "free (local)";
  return `$${m.inputCostPer1M ?? "?"} in / $${m.outputCostPer1M ?? "?"} out per 1M`;
}

function ctxLabel(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K ctx` : `${tokens} ctx`;
}

/**
 * Configure the AI model without leaving chat: pick provider, pick a priced
 * model, and (for cloud providers missing a key) paste the API key. Persists
 * via POST /api/config, which writes ~/.mnemos/.env (chmod 600) and sets the
 * default provider. Doubles as the first-run onboarding step.
 */
export function ModelSettingsModal({
  providers,
  providerId,
  model,
  onApply,
  onProvidersChanged,
  onClose,
  onboarding = false,
}: {
  providers: ProviderInfo[];
  providerId: string;
  model: string;
  /** Reflect the chosen provider+model back into the chat. */
  onApply: (provider: string, model: string) => void;
  /** Ask the chat to refetch providers — picks up configured-flag changes AND
   * newly installed local models. Awaitable so the dialog can show progress. */
  onProvidersChanged: () => void | Promise<void>;
  onClose: () => void;
  onboarding?: boolean;
}) {
  const [provider, setProvider] = useState(providerId);
  const initial =
    providers.find((p) => p.id === providerId)?.models.some((m) => m.id === model)
      ? model
      : "";
  const [selModel, setSelModel] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scan, setScan] = useState<DetectedCredential[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // Ranked local models (balanced-first) with per-model perf — only for Ollama.
  const [ranked, setRanked] = useState<RankedModel[]>([]);
  const [machine, setMachine] = useState<{ note: string } | null>(null);
  const [modelDocsUrl, setModelDocsUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const fetchRanked = useCallback(async (prov: string) => {
    if (prov !== "ollama") {
      setRanked([]);
      setMachine(null);
      return;
    }
    try {
      const r = await fetch("/api/models/ranked?provider=ollama", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as {
          ranked?: RankedModel[];
          machine?: { note: string };
          docsUrl?: string;
        };
        setRanked(d.ranked ?? []);
        setMachine(d.machine ?? null);
        setModelDocsUrl(d.docsUrl ?? null);
      }
    } catch {
      // ignore — fall back to the plain dropdown
    }
  }, []);

  useEffect(() => {
    void fetchRanked(provider);
  }, [provider, fetchRanked]);

  // Default to the best INSTALLED model when nothing valid is selected (never an
  // uninstalled curated suggestion — you can't run what you don't have).
  useEffect(() => {
    const installedRanked = ranked.filter((m) => m.installed);
    if (provider === "ollama" && installedRanked.length > 0 && (!selModel || !installedRanked.some((m) => m.id === selModel))) {
      const rec = installedRanked.find((m) => m.recommended) ?? installedRanked[0];
      if (rec) setSelModel(rec.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, provider]);

  // Re-detect on open so the model list reflects anything installed since the
  // chat page first loaded (e.g. `ollama pull gemma3` while the app was running).
  useEffect(() => {
    void Promise.resolve(onProvidersChanged());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshModels() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onProvidersChanged();
      await fetchRanked(provider);
    } finally {
      setRefreshing(false);
    }
  }

  // Scan well-known credential locations once so the dialog can offer to reuse a
  // key the user already has (and surface — but never reuse — OAuth tokens).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/credentials/scan", { cache: "no-store" });
        if (r.ok) {
          const d = (await r.json()) as { found: DetectedCredential[] };
          if (!cancelled) setScan(d.found);
        }
      } catch {
        // silent — detection is a convenience, not required
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const info = providers.find((p) => p.id === provider);
  const needsKey = Boolean(info?.needsKey && !info?.configured);
  const models = info?.models ?? [];
  const docsUrl = extractUrl(info?.credentialDescription ?? null);

  // A detected, importable API key for this provider (env var or key file).
  const keyHit = scan.find((h) => h.provider === provider && h.importable);
  // A detected but non-reusable credential (OAuth subscription token / ADC).
  // Vendor ToS prohibits third-party reuse, so we show it as status only.
  const blockedHit = scan.find(
    (h) =>
      !h.importable &&
      ((provider === "anthropic" && h.provider === "anthropic-oauth") ||
        (provider === "openai" && h.provider === "codex-oauth") ||
        (provider === "gemini" && h.provider === "gemini")),
  );

  async function useDetected(hit: DetectedCredential) {
    if (importing) return;
    setImporting(true);
    setErr(null);
    try {
      const r = await fetch("/api/credentials/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, source: hit.source, location: hit.location }),
      });
      // Parse defensively — a non-JSON error body (proxy/HTML 500) shouldn't
      // surface as a confusing "Unexpected token" instead of the real failure.
      const text = await r.text();
      let j: { ok?: boolean; error?: string; message?: string } = {};
      try {
        j = text ? JSON.parse(text) : {};
      } catch {
        /* non-JSON body — fall back to raw text below */
      }
      if (!r.ok || !j.ok) {
        throw new Error(j.message ?? j.error ?? (text || `HTTP ${r.status}`));
      }
      onProvidersChanged();
      onApply(provider, selModel);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  function pickProvider(id: string) {
    setProvider(id);
    setErr(null);
    setApiKey("");
    const next = providers.find((p) => p.id === id);
    setSelModel(next?.defaultModel ?? next?.models[0]?.id ?? "");
  }

  async function save() {
    if (saving) return;
    if (needsKey && !apiKey.trim()) {
      setErr(`${info?.displayName ?? "This provider"} needs an API key.`);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body: { provider: string; apiKey?: string; model?: string } = { provider };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      // Persist the chosen model server-side so the Telegram bot mirrors it.
      if (selModel) body.model = selModel;
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.text()) || r.statusText);
      onProvidersChanged();
      onApply(provider, selModel);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={onboarding ? "Choose your AI model" : "AI Model"} onClose={onClose}>
      {onboarding && (
        <p className="text-xs text-muted mb-3 leading-relaxed">
          Mnemos needs one model to answer with. Local (Ollama) keeps everything
          on your machine; cloud models need your own API key. You can change
          this anytime from Settings.
        </p>
      )}

      <label className="block text-xs text-muted mb-1">Provider</label>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {providers.map((p) => (
          <button
            key={p.id}
            onClick={() => pickProvider(p.id)}
            className={`text-xs px-2.5 py-1.5 rounded border transition ${
              provider === p.id
                ? "border-cyan-500 bg-cyan-500/15 text-cyan-200"
                : "border-line bg-surface text-fg hover:border-cyan-700"
            }`}
          >
            {!p.needsKey ? "🟢" : p.configured ? "🔑" : "🔒"} {p.displayName}
          </button>
        ))}
      </div>

      {info && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-muted" htmlFor="model-sel">
              Model
            </label>
            {/* Local model lists come live from the daemon — let the user
                re-scan after `ollama pull` without reloading the page. */}
            {!info.needsKey && (
              <button
                type="button"
                onClick={() => void refreshModels()}
                disabled={refreshing}
                title="Re-scan the local daemon for newly installed models"
                className="text-[11px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
              >
                {refreshing ? "Detecting…" : "↻ Detect new"}
              </button>
            )}
          </div>
          {provider === "ollama" && ranked.length > 0 ? (
            <div className="space-y-1.5 max-h-80 overflow-y-auto pr-0.5">
              <p className="text-[11px] text-muted">
                Ranked fastest + most accurate first. Speed is measured from your own queries once you&apos;ve
                run a model.
              </p>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                {machine && <span className="text-muted">🖥 {machine.note}</span>}
                {modelDocsUrl && (
                  <a href={modelDocsUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:text-cyan-300 underline shrink-0">
                    Browse models →
                  </a>
                )}
              </div>
              {ranked.map((m) => {
                const badge = SPEED_BADGE[m.speed];
                const note = m.installed ? QUALITY_NOTE[m.quality] : m.note;
                const sel = selModel === m.id;
                const pull = `ollama pull ${m.id}`;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      if (m.installed) {
                        setSelModel(m.id);
                      } else {
                        void navigator.clipboard?.writeText(pull).then(() => {
                          setCopied(m.id);
                          setTimeout(() => setCopied((c) => (c === m.id ? null : c)), 1500);
                        });
                      }
                    }}
                    title={m.installed ? "Use this model" : `Copy: ${pull}`}
                    className={`w-full text-left rounded-md border px-3 py-2 transition ${
                      sel
                        ? "border-cyan-500 bg-cyan-500/10"
                        : m.installed
                          ? "border-line bg-surface hover:border-cyan-700"
                          : "border-dashed border-line/70 bg-surface/40 hover:border-cyan-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-sm font-medium truncate ${m.installed ? "text-fg" : "text-muted"}`}>
                        {m.id}
                      </span>
                      {m.recommended && (
                        <span className="text-[10px] font-semibold text-cyan-300 shrink-0">★ recommended</span>
                      )}
                      {!m.installed && (
                        <span className="text-[10px] text-muted shrink-0">{copied === m.id ? "copied!" : "not installed"}</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                      {modelMeta(m) && <span className="font-mono">{modelMeta(m)}</span>}
                      <span className={badge.cls}>
                        {badge.icon} {badge.label}
                      </span>
                      {m.installed ? (
                        <span>{m.tokPerSec != null ? `~${Math.round(m.tokPerSec)} tok/s` : "speed not measured yet"}</span>
                      ) : (
                        <span className="font-mono text-cyan-400/80">⤓ {pull}</span>
                      )}
                      {note && <span>· {note}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : models.length > 0 ? (
            <div className="space-y-1.5 max-h-80 overflow-y-auto pr-0.5">
              {(() => {
                const asOf = models.find((m) => m.pricedAsOf)?.pricedAsOf;
                return asOf ? (
                  <p className="text-[11px] text-muted">
                    💲 Pricing as of {asOf} — providers change rates; verify before relying on it.
                  </p>
                ) : null;
              })()}
              {models.map((m) => {
                const sel = selModel === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSelModel(m.id)}
                    className={`w-full text-left rounded-md border px-3 py-2 transition ${
                      sel ? "border-cyan-500 bg-cyan-500/10" : "border-line bg-surface hover:border-cyan-700"
                    }`}
                  >
                    <div className="text-sm text-fg font-medium truncate">{m.displayName}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                      <span className="font-mono">{ctxLabel(m.contextWindow)}</span>
                      <span>{priceLabel(m)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted">
              {info.needsKey
                ? "No models available."
                : "No models detected — pull one (e.g. `ollama pull gemma3`), then ↻ Detect new."}
            </p>
          )}
        </div>
      )}

      {needsKey && (
        <div className="mb-4">
          {keyHit && (
            <div className="mb-3 rounded-md border border-cyan-700/40 bg-cyan-500/10 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-fg min-w-0">
                  🔑 Key detected{" "}
                  <span className="font-mono text-muted">{keyHit.location}</span>
                </span>
                <button
                  onClick={() => void useDetected(keyHit)}
                  disabled={importing}
                  className="rounded-md bg-cyan-500 px-3 py-1 text-xs font-semibold text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50 shrink-0"
                >
                  {importing ? "Using…" : "Use this"}
                </button>
              </div>
            </div>
          )}
          {blockedHit && (
            <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-fg/90 leading-relaxed">
              ⚠{" "}
              {blockedHit.note ??
                "An OAuth/subscription token was found but can't be reused — create an API key instead."}
            </div>
          )}
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-muted" htmlFor="api-key-field">
              {keyHit ? "Or paste a key" : (info?.credentialLabel ?? "API Key")}
            </label>
            {docsUrl && (
              <a
                href={docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-cyan-400 hover:text-cyan-300 underline"
              >
                Get a key →
              </a>
            )}
          </div>
          <input
            id="api-key-field"
            type="password"
            autoFocus
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder="Paste your key here"
            className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm text-fg focus:outline-none focus:border-cyan-500 font-mono"
          />
          {info?.envVar && (
            <p className="text-[11px] text-muted mt-1.5">
              Saved as <span className="font-mono">{info.envVar}</span> in{" "}
              <span className="font-mono">~/.mnemos/.env</span> — never commit it
              to a git repo.
            </p>
          )}
        </div>
      )}

      {err && <p className="text-xs text-red-400 mb-3">{err}</p>}

      <div className="flex justify-end gap-2">
        {!onboarding && (
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-muted hover:text-fg transition"
          >
            Cancel
          </button>
        )}
        <button
          onClick={() => void save()}
          disabled={saving || (needsKey && !apiKey.trim())}
          className="rounded-md bg-cyan-500 px-4 py-1.5 text-xs font-semibold text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : onboarding ? "Continue" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
