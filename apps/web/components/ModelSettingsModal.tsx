"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";

type ModelInfo = {
  id: string;
  displayName: string;
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
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
  return `$${m.inputCostPer1M ?? "?"}/$${m.outputCostPer1M ?? "?"} per 1M`;
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
  /** Ask the chat to refetch providers (configured flags changed). */
  onProvidersChanged: () => void;
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
  const [err, setErr] = useState<string | null>(null);

  const info = providers.find((p) => p.id === provider);
  const needsKey = Boolean(info?.needsKey && !info?.configured);
  const models = info?.models ?? [];
  const docsUrl = extractUrl(info?.credentialDescription ?? null);

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
      const body: { provider: string; apiKey?: string } = { provider };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
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

      {models.length > 0 && (
        <>
          <label className="block text-xs text-muted mb-1" htmlFor="model-sel">
            Model
          </label>
          <select
            id="model-sel"
            value={selModel}
            onChange={(e) => setSelModel(e.target.value)}
            className="w-full bg-surface border border-line rounded-md px-2 py-2 text-sm text-fg focus:outline-none focus:border-cyan-500 mb-4"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} · {priceLabel(m)}
              </option>
            ))}
          </select>
        </>
      )}

      {needsKey && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-muted" htmlFor="api-key-field">
              {info?.credentialLabel ?? "API Key"}
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
