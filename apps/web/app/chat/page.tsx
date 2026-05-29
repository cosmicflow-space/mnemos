"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import Image from "next/image";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { SettingsMenu } from "@/components/SettingsMenu";
import { ModelSettingsModal } from "@/components/ModelSettingsModal";
import { SourcesModal } from "@/components/SourcesModal";

type SessionRow = {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
};

type StoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  citations: number[] | null;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: number;
};

type ModelInfo = {
  id: string;
  displayName: string;
  contextWindow: number;
  /** USD per 1M tokens. null for local/free providers. */
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
};

/** All-time token totals per (provider, model), from /api/usage. */
type UsageTotal = {
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  messages: number;
};

type Hit = {
  ref: number;
  chunkId: number;
  filePath: string;
  sourcePath: string;
  snippet: string;
  startOffset: number;
  endOffset: number;
  distance: number;
};

type ChatProviderInfo = {
  id: string;
  displayName: string;
  credentialType: string;
  /** Whether this provider requires an API key (cloud) vs. none (local). */
  needsKey: boolean;
  /** Whether the required key is already on file in ~/.mnemos/.env. */
  configured: boolean;
  /** Env var the key is stored under, e.g. ANTHROPIC_API_KEY. */
  envVar: string | null;
  /** Human label + docs hint for the credential, from the provider schema. */
  credentialLabel: string | null;
  credentialDescription: string | null;
  /** Selectable models with pricing, and the cheapest-cost default. */
  models: ModelInfo[];
  defaultModel: string | null;
};

/** Structured payload from /api/query when the chosen provider is missing a
 * required credential. Rendered as an actionable card rather than raw JSON. */
type MissingCredential = {
  providerId: string;
  providerName: string;
  envVar: string | null;
  fields: { key: string; label: string; description: string | null }[];
};

type LiveMessage = {
  role: "user" | "assistant";
  content: string;
  /** Hits attached to assistant messages once the 'retrieved' event arrives. */
  hits?: Hit[];
  /** Provider id used for the response (assistant messages only). */
  provider?: string;
  /** Actual model that produced the response — populated from the 'done' event. */
  model?: string | null;
  /** End-to-end duration in milliseconds, from query to last token. */
  durationMs?: number;
  /** Token usage if the provider reports it (Ollama doesn't; frontier providers do). */
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** True while the response is still streaming. */
  streaming?: boolean;
};

const STORAGE_SESSION_KEY = "mnemos.lastSessionId";
const STORAGE_PROVIDER_KEY = "mnemos.lastProviderId";
const STORAGE_MODEL_PREFIX = "mnemos.lastModel."; // + providerId

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [providers, setProviders] = useState<ChatProviderInfo[]>([]);
  const [providerId, setProviderId] = useState<string>("anthropic");
  const [model, setModel] = useState<string>("");
  const [usageTotals, setUsageTotals] = useState<UsageTotal[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credPrompt, setCredPrompt] = useState<MissingCredential | null>(null);
  const [keyDialogProvider, setKeyDialogProvider] =
    useState<ChatProviderInfo | null>(null);
  // Single source of truth for the centered modals — opened by the settings
  // popover, the onboarding flow, or the provider dropdown.
  const [activeModal, setActiveModal] = useState<"model" | "sources" | null>(null);
  const [modelModalOnboarding, setModelModalOnboarding] = useState(false);
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // ---- Load providers + configured agent + last session on mount ----
  useEffect(() => {
    void (async () => {
      // Source-of-truth precedence: configured agent > explicit last-chosen
      // (localStorage) > hard default. Reading /api/config first means picking
      // a provider in /agent immediately becomes the chat default — no
      // surprise where the dropdown ignores your config.
      let configuredProvider: string | null = null;
      let configReady = false;
      try {
        const configRes = await fetch("/api/config", { cache: "no-store" });
        if (configRes.ok) {
          const cfg = (await configRes.json()) as { provider: string | null; ready: boolean };
          configReady = cfg.ready;
          if (cfg.ready && cfg.provider) configuredProvider = cfg.provider;
        }
      } catch {
        // silent
      }
      try {
        const res = await fetch("/api/providers");
        if (res.ok) {
          const data = (await res.json()) as { chatProviders: ChatProviderInfo[] };
          setProviders(data.chatProviders);
        }
      } catch {
        // silent
      }
      const lastProvider =
        typeof window !== "undefined"
          ? window.localStorage.getItem(STORAGE_PROVIDER_KEY)
          : null;
      if (configuredProvider) setProviderId(configuredProvider);
      else if (lastProvider) setProviderId(lastProvider);

      // Onboarding step 1: no usable model yet → open the model modal first.
      if (!configReady) {
        setModelModalOnboarding(true);
        setActiveModal("model");
      }

      const lastSession =
        typeof window !== "undefined"
          ? window.localStorage.getItem(STORAGE_SESSION_KEY)
          : null;
      if (lastSession) setSessionId(lastSession);
    })();
  }, []);

  // ---- Source count (drives the "no sources" note + onboarding hint) ----
  const refreshSourceCount = useCallback(async () => {
    try {
      const res = await fetch("/api/sources", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { sources: unknown[] };
        setSourceCount(data.sources.length);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void refreshSourceCount();
  }, [refreshSourceCount]);

  // Refetch providers (e.g. after a key is saved in the model modal).
  const refreshProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { chatProviders: ChatProviderInfo[] };
        setProviders(data.chatProviders);
      }
    } catch {
      // silent
    }
  }, []);

  // ---- Session list ----
  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = (await res.json()) as { sessions: SessionRow[] };
        setSessions(data.sessions);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // ---- All-time usage totals (drives the header "Total" cost readout) ----
  const refreshUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { totals: UsageTotal[] };
        setUsageTotals(data.totals);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  // ---- Choose a model whenever the provider (or its model list) changes ----
  // Precedence: last model used for THIS provider (if still offered) > the
  // provider's cheapest default > first model. Keeps a per-provider memory so
  // switching back and forth doesn't lose your choice.
  useEffect(() => {
    const info = providers.find((p) => p.id === providerId);
    if (!info) return;
    const remembered =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_MODEL_PREFIX + providerId)
        : null;
    const offered = new Set(info.models.map((m) => m.id));
    setModel(
      remembered && offered.has(remembered)
        ? remembered
        : (info.defaultModel ?? info.models[0]?.id ?? ""),
    );
  }, [providerId, providers]);

  // ---- Load messages when sessionId changes ----
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`/api/sessions?id=${sessionId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { messages: StoredMessage[] };
        setMessages(
          data.messages.map((m) => ({
            role: m.role,
            content: m.content,
            provider: m.provider ?? undefined,
            model: m.model ?? undefined,
            tokensIn: m.tokensIn,
            tokensOut: m.tokensOut,
          })),
        );
      } catch {
        // silent
      }
    })();
  }, [sessionId]);

  // ---- Auto-scroll on new content ----
  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  function newChat() {
    setSessionId(null);
    setMessages([]);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_SESSION_KEY);
    }
  }

  async function deleteSession(id: string, title: string) {
    if (!confirm(`Delete this session?\n\n${title}\n\nThis can't be undone.`)) return;
    try {
      const r = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
      // If we just deleted the active session, reset state.
      if (sessionId === id) newChat();
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Called by the key dialog after a successful save: flip the badge, switch to
  // the now-configured provider, and dismiss any stale "needs key" card.
  function onKeySaved(savedId: string) {
    setProviders((prev) =>
      prev.map((p) => (p.id === savedId ? { ...p, configured: true } : p)),
    );
    setKeyDialogProvider(null);
    setCredPrompt(null);
    setProviderId(savedId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_PROVIDER_KEY, savedId);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || streaming) return;

    setError(null);
    setCredPrompt(null);
    setInput("");
    setStreaming(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: q },
      {
        role: "assistant",
        content: "",
        streaming: true,
        provider: providerId,
        model: model || null,
      },
    ]);

    let assistantHits: Hit[] | undefined;
    let assistantText = "";

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          q,
          sessionId: sessionId ?? undefined,
          providerId,
          model: model || undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        // Prefer a structured, actionable error over dumping raw JSON. A
        // missing API key becomes a guided card; anything else falls through
        // to the generic error line.
        let payload: { error?: string } | null = null;
        try {
          payload = JSON.parse(text);
        } catch {
          // not JSON — leave payload null
        }
        if (payload?.error === "missing_credentials") {
          const mc = payload as unknown as MissingCredential & {
            provider?: string;
          };
          setCredPrompt({
            providerId: mc.provider ?? providerId,
            providerName: mc.providerName,
            envVar: mc.envVar ?? null,
            fields: mc.fields ?? [],
          });
          // Drop the optimistic user+assistant bubbles and put the question
          // back in the box so the user can resend once the key is configured.
          setMessages((prev) => prev.slice(0, -2));
          setInput(q);
          return;
        }
        throw new Error(text || res.statusText);
      }

      const headerSession = res.headers.get("x-mnemos-session-id");
      if (headerSession) {
        setSessionId(headerSession);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_SESSION_KEY, headerSession);
        }
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const block of events) {
          const line = block.trim();
          if (!line.startsWith("data: ")) continue;
          let event: unknown;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          const ev = event as {
            phase: string;
            hits?: Hit[];
            delta?: string;
            message?: string;
          };
          if (ev.phase === "retrieved" && ev.hits) {
            assistantHits = ev.hits;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, hits: assistantHits };
              }
              return next;
            });
          } else if (ev.phase === "delta" && typeof ev.delta === "string") {
            assistantText += ev.delta;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, content: assistantText };
              }
              return next;
            });
          } else if (ev.phase === "done") {
            // Capture model + duration + token counts from the runQuery
            // 'done' event so the message footer can show "ollama · llama3.2:3b · 1.2s".
            const done = event as {
              phase: "done";
              model?: string | null;
              durationMs?: number;
              tokenCounts?: { in?: number | null; out?: number | null };
            };
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  model: done.model ?? null,
                  durationMs: done.durationMs,
                  tokensIn: done.tokenCounts?.in ?? null,
                  tokensOut: done.tokenCounts?.out ?? null,
                };
              }
              return next;
            });
          } else if (ev.phase === "error") {
            throw new Error(ev.message ?? "stream error");
          }
        }
      }

      // Mark stream complete
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { ...last, streaming: false };
        }
        return next;
      });

      await refreshSessions();
      await refreshUsage(); // fold this turn's tokens into the all-time total
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = {
            ...last,
            content: last.content || `[error: ${message}]`,
            streaming: false,
          };
        }
        return next;
      });
    } finally {
      setStreaming(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Standard chat affordance: Enter sends, Shift+Enter newlines.
    // Cmd/Ctrl+Enter also send for power users who learn it elsewhere.
    if (e.key === "Enter" && !e.shiftKey) {
      // IME composition: don't send while user is mid-composition (e.g. CJK input)
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      void send(e as unknown as FormEvent);
    }
  }

  // ---- Derived cost readouts ----
  const currentProvider = providers.find((p) => p.id === providerId);
  const currentModels = currentProvider?.models ?? [];
  const currentModelInfo = currentModels.find((m) => m.id === model);
  const modelTooltip = [
    currentProvider?.displayName ?? providerId,
    currentModelInfo?.displayName,
    currentModelInfo && (currentModelInfo.inputCostPer1M != null || currentModelInfo.outputCostPer1M != null)
      ? `$${currentModelInfo.inputCostPer1M ?? "?"}/$${currentModelInfo.outputCostPer1M ?? "?"} per 1M`
      : currentModelInfo
        ? "free (local)"
        : null,
  ]
    .filter(Boolean)
    .join(" · ") + " — click to change";
  // This session's cost = sum over rendered assistant turns. The all-time total
  // comes from the DB aggregate (/api/usage) so it survives reloads.
  const sessionCost = messages.reduce(
    (sum, m) =>
      sum +
      (costUsd(findModelInfo(providers, m.provider, m.model), m.tokensIn, m.tokensOut) ?? 0),
    0,
  );
  const totalCost = usageTotals.reduce(
    (sum, t) =>
      sum +
      (costUsd(findModelInfo(providers, t.provider, t.model), t.tokensIn, t.tokensOut) ?? 0),
    0,
  );

  return (
    <main className="grid grid-cols-[260px_1fr] min-h-screen bg-app text-fg">
      {keyDialogProvider && (
        <KeyDialog
          provider={keyDialogProvider}
          onSaved={onKeySaved}
          onClose={() => setKeyDialogProvider(null)}
        />
      )}
      {activeModal === "model" && (
        <ModelSettingsModal
          providers={providers}
          providerId={providerId}
          model={model}
          onApply={(p, m) => {
            // The modal already ensured the key is set — apply directly rather
            // than via rememberProvider (which would re-check stale `configured`
            // state and could reopen the key dialog).
            setProviders((prev) =>
              prev.map((pr) => (pr.id === p ? { ...pr, configured: true } : pr)),
            );
            setProviderId(p);
            setModel(m);
            setCredPrompt(null);
            if (typeof window !== "undefined") {
              window.localStorage.setItem(STORAGE_PROVIDER_KEY, p);
              if (m) window.localStorage.setItem(STORAGE_MODEL_PREFIX + p, m);
            }
          }}
          onProvidersChanged={refreshProviders}
          onClose={() => setActiveModal(null)}
          onboarding={modelModalOnboarding}
        />
      )}
      {activeModal === "sources" && (
        <SourcesModal
          onChanged={refreshSourceCount}
          onClose={() => setActiveModal(null)}
        />
      )}
      {/* Sidebar */}
      <aside className="border-r border-line bg-surface flex flex-col">
        <div className="px-4 py-3.5 border-b border-line flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={20} height={20} unoptimized priority />
          <span className="text-sm font-semibold text-fg">Mnemos</span>
        </div>
        <div className="px-4 py-2 text-xs uppercase tracking-wider text-muted">
          History
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {sessions.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted">No sessions yet</p>
          )}
          {groupSessionsByDate(sessions).map((group) => (
            <div key={group.label} className="mb-3">
              <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted">
                {group.label}
              </div>
              <ul className="space-y-0.5">
                {group.items.map((s) => {
                  const label = s.title ?? formatSessionPreview(s);
                  return (
                    <li key={s.id} className="group/session relative">
                      <button
                        onClick={() => setSessionId(s.id)}
                        className={`w-full text-left pl-2 pr-7 py-1.5 rounded text-xs truncate transition ${
                          s.id === sessionId
                            ? "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
                            : "text-fg/90 hover:bg-app"
                        }`}
                        title={label}
                      >
                        {label}
                      </button>
                      <button
                        onClick={() => void deleteSession(s.id, label)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/session:opacity-100 transition rounded text-muted hover:text-red-400 hover:bg-red-500/10 w-5 h-5 flex items-center justify-center text-xs"
                        title="Delete session"
                        aria-label="Delete session"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-3 border-t border-line">
          <SettingsMenu
            onOpenSources={() => setActiveModal("sources")}
            onOpenModel={() => {
              setModelModalOnboarding(false);
              setActiveModal("model");
            }}
          />
          <button
            onClick={newChat}
            title="New chat"
            aria-label="New chat"
            className="w-9 h-9 rounded-full border border-line bg-surface hover:border-cyan-700 text-fg flex items-center justify-center transition text-base"
          >
            ✎
          </button>
        </div>
      </aside>

      {/* Main */}
      <section className="flex flex-col h-screen">
        {/* Clean status bar: no "Chat" label. Compact chips with hover
            tooltips; click the model chip to change provider/model in a modal. */}
        <header className="flex items-center justify-end gap-1.5 px-5 py-2 border-b border-line text-xs">
          {(sessionCost > 0 || totalCost > 0) && (
            <span
              title={`Session ${formatUsd(sessionCost)} · Total ${formatUsd(totalCost)} (estimated from pricing × tokens)`}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-muted hover:text-fg hover:bg-surface transition cursor-default"
            >
              <span aria-hidden>💰</span> {formatUsd(sessionCost)}
            </span>
          )}
          <button
            onClick={() => {
              setModelModalOnboarding(false);
              setActiveModal("model");
            }}
            disabled={streaming}
            title={modelTooltip}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-line bg-surface text-fg hover:border-cyan-700 transition disabled:opacity-50 max-w-[16rem]"
          >
            <span aria-hidden>{currentProvider ? providerBadge(currentProvider) : "🤖"}</span>
            <span className="font-medium truncate">
              {currentModelInfo?.displayName ?? currentProvider?.displayName ?? "Model"}
            </span>
            <span className="text-muted" aria-hidden>⌄</span>
          </button>
        </header>

        <div ref={threadRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted">
              <div className="text-5xl mb-3">🧠</div>
              <p className="text-sm">
                {sourceCount && sourceCount > 0
                  ? "Ask a question about your sources."
                  : "Ask anything — or add sources for grounded, cited answers."}
              </p>
              {sourceCount === 0 ? (
                <button
                  onClick={() => setActiveModal("sources")}
                  className="text-xs mt-2 text-cyan-300 hover:text-cyan-200 underline"
                >
                  + Add a folder of documents
                </button>
              ) : (
                <p className="text-xs mt-1 text-muted/70">
                  {sessions.length === 0
                    ? "Tip: add a folder from Settings & Sources."
                    : "Or pick a past chat from the sidebar."}
                </p>
              )}
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageBubble key={i} message={m} providers={providers} />
            ))
          )}
        </div>

        <form
          onSubmit={send}
          className="border-t border-line px-6 py-4 bg-surface"
        >
          {sourceCount === 0 && messages.length > 0 && (
            <div className="mb-2 text-[11px] text-muted flex items-center gap-1.5">
              <span aria-hidden>ℹ️</span>
              <span>
                No sources added — answering from the model&apos;s own knowledge.{" "}
                <button
                  type="button"
                  onClick={() => setActiveModal("sources")}
                  className="text-cyan-400 hover:text-cyan-300 underline"
                >
                  Add sources
                </button>{" "}
                for grounded, cited answers.
              </span>
            </div>
          )}
          {credPrompt && (
            <CredentialPrompt
              cred={credPrompt}
              onAddKey={() => {
                const info = providers.find((p) => p.id === credPrompt.providerId);
                if (info) setKeyDialogProvider(info);
              }}
            />
          )}
          {error && (
            <div className="mb-2 text-xs text-red-400">{error}</div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={streaming ? "Streaming…" : "Ask anything about your sources…"}
              disabled={streaming}
              rows={2}
              className="flex-1 bg-app border border-line rounded-md px-3 py-2 text-sm text-fg focus:outline-none focus:border-cyan-500 transition disabled:opacity-50 resize-none"
            />
            <button
              type="submit"
              disabled={streaming || !input.trim()}
              title="Send (Enter)"
              aria-label="Send"
              className="w-10 h-10 rounded-full bg-amber-500 text-gray-900 text-lg flex items-center justify-center hover:bg-amber-400 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {streaming ? "…" : "⏎"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

/** Pull the first http(s) URL out of a credential field's description, e.g.
 * "Get one at https://console.anthropic.com/settings/keys" → the URL. */
function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s)]+/);
  return m ? m[0] : null;
}

/** Status glyph shown next to each provider in the dropdown:
 *   🟢 local provider, no key required   🔑 cloud key on file   🔒 key needed. */
function providerBadge(p: ChatProviderInfo): string {
  if (!p.needsKey) return "🟢";
  return p.configured ? "🔑" : "🔒";
}

// ── Model + cost helpers ──────────────────────────────────────────────────────

/** Find a model's pricing info across the loaded providers. */
function findModelInfo(
  providers: ChatProviderInfo[],
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): ModelInfo | undefined {
  if (!providerId || !modelId) return undefined;
  return providers
    .find((p) => p.id === providerId)
    ?.models.find((m) => m.id === modelId);
}

/** USD cost for the given token counts under a model's pricing. Returns 0 for
 * local/unpriced models, and null when the model isn't known (so callers can
 * skip the cost segment rather than show a misleading $0). */
function costUsd(
  m: ModelInfo | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
): number | null {
  if (!m) return null;
  if (m.inputCostPer1M == null && m.outputCostPer1M == null) return 0; // local/free
  const ti = tokensIn ?? 0;
  const to = tokensOut ?? 0;
  return (ti / 1e6) * (m.inputCostPer1M ?? 0) + (to / 1e6) * (m.outputCostPer1M ?? 0);
}

/** Compact USD formatter tuned for tiny per-query costs. */
function formatUsd(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return "$" + n.toFixed(n < 1 ? 4 : 2);
}

// ── Markdown rendering ────────────────────────────────────────────────────────
// react-markdown maps each element through this Tailwind-styled component set.
// Output is safe React (no raw HTML injection); remark-gfm adds tables, task
// lists, strikethrough, and autolinks.
const mdComponents: Components = {
  p: (props) => <p className="mb-2 last:mb-0 leading-relaxed" {...props} />,
  ul: (props) => <ul className="list-disc pl-5 mb-2 space-y-0.5" {...props} />,
  ol: (props) => <ol className="list-decimal pl-5 mb-2 space-y-0.5" {...props} />,
  li: (props) => <li className="leading-relaxed" {...props} />,
  h1: (props) => <h1 className="text-base font-semibold mt-3 mb-1.5" {...props} />,
  h2: (props) => <h2 className="text-sm font-semibold mt-3 mb-1.5" {...props} />,
  h3: (props) => <h3 className="text-sm font-semibold mt-2 mb-1" {...props} />,
  a: (props) => (
    <a className="text-cyan-300 hover:text-cyan-200 underline" target="_blank" rel="noreferrer" {...props} />
  ),
  strong: (props) => <strong className="font-semibold text-fg" {...props} />,
  em: (props) => <em className="italic" {...props} />,
  blockquote: (props) => (
    <blockquote className="border-l-2 border-line pl-3 italic text-muted my-2" {...props} />
  ),
  hr: () => <hr className="border-line my-3" />,
  // Inline code gets a pill; the `[&>code]` reset on <pre> strips the pill for
  // fenced blocks so block code reads cleanly inside the dark code box.
  code: (props) => (
    <code className="bg-black/[0.06] dark:bg-white/10 text-amber-700 dark:text-amber-300 rounded px-1 py-0.5 text-[0.85em] font-mono" {...props} />
  ),
  pre: (props) => (
    <pre
      className="bg-gray-950 border border-line-strong rounded-md p-3 my-2 overflow-x-auto text-xs font-mono [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-gray-200"
      {...props}
    />
  ),
  table: (props) => (
    <div className="overflow-x-auto my-2 rounded-md border border-line-strong">
      <table className="w-full text-xs border-collapse" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-black/[0.03] dark:bg-white/[0.04]" {...props} />,
  th: (props) => <th className="text-left font-semibold px-2.5 py-1.5 border border-line-strong" {...props} />,
  td: (props) => <td className="px-2.5 py-1.5 border border-line-strong align-top" {...props} />,
};

function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm text-fg leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Inline modal to paste + save an API key for a cloud provider. Saves to
 * ~/.mnemos/.env via POST /api/config (chmod 600, hot-reloaded), so the user
 * never leaves the chat to get a provider working. Provider-agnostic — all
 * copy (docs link, field label) comes from the provider's own schema. */
function KeyDialog({
  provider,
  onSaved,
  onClose,
}: {
  provider: ChatProviderInfo;
  onSaved: (providerId: string) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const docsUrl = provider.credentialDescription
    ? extractUrl(provider.credentialDescription)
    : null;

  async function save() {
    const trimmed = key.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, apiKey: trimmed }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || r.statusText);
      }
      onSaved(provider.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-xl border border-line bg-elevated text-fg p-5 shadow-2xl aurora-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1">
          <span aria-hidden>🔑</span>
          <h2 className="text-sm font-semibold text-fg">
            Configure {provider.displayName}
          </h2>
        </div>
        <p className="text-xs text-muted leading-relaxed mb-3">
          {provider.displayName} is a cloud provider and authenticates with your
          own API key. Mnemos never reuses subscription or OAuth tokens.
        </p>

        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-cyan-300 hover:text-cyan-200 underline mb-3"
          >
            Get your API key →
          </a>
        )}

        <label className="block text-xs text-muted mb-1" htmlFor="api-key">
          {provider.credentialLabel ?? "API Key"}
        </label>
        <input
          id="api-key"
          type="password"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Paste your key here"
          className="w-full bg-surface border border-line rounded-md px-3 py-2 text-sm text-fg focus:outline-none focus:border-cyan-500 font-mono"
        />

        {provider.envVar && (
          <p className="text-[11px] text-muted mt-1.5">
            Saved as{" "}
            <span className="font-mono text-fg">{provider.envVar}</span> in{" "}
            <span className="font-mono">~/.mnemos/.env</span> (chmod 600). Never
            commit it to a git repo.
          </p>
        )}

        {err && <p className="text-xs text-red-400 mt-2">{err}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface hover:text-fg transition"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!key.trim() || saving}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-xs font-semibold text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save key"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Actionable card shown when the selected provider has no API key on file.
 * Replaces the old raw-JSON error: explains why a key is needed, links out to
 * get one, points at the in-app place to add it, and warns against committing
 * it to git. Provider-agnostic — driven entirely by the API payload. */
function CredentialPrompt({
  cred,
  onAddKey,
}: {
  cred: MissingCredential;
  onAddKey: () => void;
}) {
  const field = cred.fields[0];
  const docsUrl = field?.description ? extractUrl(field.description) : null;
  return (
    <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span aria-hidden>🔑</span>
        <span className="text-sm font-semibold text-amber-700 dark:text-amber-200">
          {cred.providerName} requires an API key
        </span>
      </div>
      <p className="text-xs text-fg/90 leading-relaxed mb-2">
        {cred.providerName} is a cloud provider, so it authenticates with your
        own API key. Mnemos never reuses subscription or OAuth tokens — an API
        key is the only supported credential.
      </p>
      <ol className="text-xs text-fg/90 list-decimal list-inside space-y-1 mb-2">
        <li>
          {docsUrl ? (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-300 hover:text-cyan-200 underline"
            >
              Get your API key →
            </a>
          ) : (
            (field?.description ?? "Obtain an API key from your provider.")
          )}
        </li>
        <li>
          <button
            onClick={onAddKey}
            className="text-cyan-300 hover:text-cyan-200 underline"
          >
            Add your key here
          </button>
          {cred.envVar ? (
            <>
              {" "}
              (saved as{" "}
              <span className="font-mono text-amber-700 dark:text-amber-200">{cred.envVar}</span> in{" "}
              <span className="font-mono">~/.mnemos/.env</span>)
            </>
          ) : null}
          , then resend — or set it on the{" "}
          <Link
            href="/agent"
            className="text-cyan-300 hover:text-cyan-200 underline"
          >
            Agent page
          </Link>
          .
        </li>
      </ol>
      <p className="text-[11px] text-red-600 dark:text-red-300 flex items-start gap-1.5">
        <span aria-hidden>⚠</span>
        <span>
          Never commit your API key to a git repo. Keep it only in{" "}
          <span className="font-mono">~/.mnemos/.env</span> — outside your
          projects, chmod&nbsp;600.
        </span>
      </p>
    </div>
  );
}

function MessageBubble({
  message,
  providers,
}: {
  message: LiveMessage;
  providers: ChatProviderInfo[];
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  function copyToClipboard() {
    if (!message.content) return;
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} group`}>
      <div
        className={`max-w-3xl rounded-lg px-4 py-3 relative aurora-card ${
          isUser
            ? "bg-cyan-900/30 border border-cyan-900/50 text-fg"
            : "bg-surface border border-line"
        }`}
      >
        {!isUser && message.hits && message.hits.length > 0 && (
          <Citations hits={message.hits} />
        )}
        {/* User turns are plain text (their own typing); assistant turns render
            as rich Markdown — tables, lists, code, bold. */}
        {isUser ? (
          <div className="text-sm text-fg whitespace-pre-wrap leading-relaxed">
            {message.content}
          </div>
        ) : message.content ? (
          <div>
            <Markdown>{message.content}</Markdown>
            {message.streaming && (
              <span className="inline-block w-2 h-4 ml-1 align-text-bottom bg-amber-400 animate-pulse" />
            )}
          </div>
        ) : (
          <span className="text-sm text-muted italic">Thinking…</span>
        )}
        {!isUser && !message.streaming && message.content && (
          <div className="flex items-center justify-between mt-2 text-xs text-muted gap-3">
            <span className="truncate">{formatMessageMetrics(message, providers)}</span>
            <button
              onClick={copyToClipboard}
              className="opacity-0 group-hover:opacity-100 transition rounded border border-line hover:border-cyan-700 bg-surface hover:bg-app px-2 py-0.5 text-[11px] text-muted hover:text-fg shrink-0"
              title="Copy response"
            >
              {copied ? "✓ copied" : "copy"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Citations({ hits }: { hits: Hit[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Show first 3 pills inline; the rest hide behind "+N more" until expanded.
  // Top-of-response is now scannable — citations are present but not a wall.
  const INLINE = 3;
  const visibleHits = showAll ? hits : hits.slice(0, INLINE);
  const hidden = Math.max(0, hits.length - INLINE);

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-1 mb-1">
        <span className="text-[10px] uppercase tracking-wider text-muted mr-1">
          Sources ({hits.length})
        </span>
        {visibleHits.map((h) => (
          <button
            key={h.ref}
            onClick={() => setExpanded(expanded === h.ref ? null : h.ref)}
            className={`text-[10px] px-1.5 py-0.5 rounded transition border ${
              expanded === h.ref
                ? "bg-amber-500 text-gray-900 border-amber-400"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 hover:bg-amber-500/25"
            }`}
            title={`${h.filePath} (distance ${h.distance.toFixed(3)})`}
          >
            [{h.ref}] {shortPath(h.filePath)}
          </button>
        ))}
        {hidden > 0 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-[10px] px-1.5 py-0.5 rounded transition border border-line bg-surface text-muted hover:bg-app"
          >
            {showAll ? "show less" : `+${hidden} more`}
          </button>
        )}
      </div>
      {expanded !== null && (
        <div className="text-xs font-mono bg-app border border-line rounded p-2 mb-2 text-fg/80 max-h-40 overflow-y-auto">
          {hits.find((h) => h.ref === expanded)?.snippet}
        </div>
      )}
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

/** Compose the message footer line: provider · model · duration · tokens · cost.
 * Each segment is omitted gracefully if not available so the same component
 * renders correctly for Ollama (no cost) and frontier providers (full). */
function formatMessageMetrics(m: LiveMessage, providers: ChatProviderInfo[]): string {
  const parts: string[] = [];
  if (m.provider) parts.push(m.provider);
  if (m.model) parts.push(m.model);
  if (typeof m.durationMs === "number") {
    parts.push(m.durationMs < 1000 ? `${m.durationMs}ms` : `${(m.durationMs / 1000).toFixed(1)}s`);
  }
  if (typeof m.tokensOut === "number" && m.tokensOut > 0) {
    parts.push(`${m.tokensOut} tok`);
  }
  const cost = costUsd(findModelInfo(providers, m.provider, m.model), m.tokensIn, m.tokensOut);
  if (cost !== null && cost > 0) parts.push(formatUsd(cost));
  return parts.join(" · ");
}

function formatSessionPreview(s: SessionRow): string {
  const d = new Date(s.updatedAt);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Group sessions by a friendly date bucket for the sidebar.
 * Buckets: Today, Yesterday, Earlier this week, Earlier. Within each bucket,
 * sessions stay in their incoming order (already newest-first from the API). */
type SessionGroup = { label: string; items: SessionRow[] };
function groupSessionsByDate(rows: SessionRow[]): SessionGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  // "This week" = within the past 7 days but earlier than yesterday.
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;
  const groups: Record<string, SessionRow[]> = {
    Today: [],
    Yesterday: [],
    "Earlier this week": [],
    Earlier: [],
  };
  for (const s of rows) {
    const t = s.updatedAt;
    if (t >= todayStart) groups.Today!.push(s);
    else if (t >= yesterdayStart) groups.Yesterday!.push(s);
    else if (t >= weekStart) groups["Earlier this week"]!.push(s);
    else groups.Earlier!.push(s);
  }
  return (Object.entries(groups) as Array<[string, SessionRow[]]>)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}
