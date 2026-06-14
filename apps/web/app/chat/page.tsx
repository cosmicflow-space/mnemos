"use client";

import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import Image from "next/image";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SettingsMenu } from "@/components/SettingsMenu";
import { FloatingThemeToggle } from "@/components/FloatingThemeToggle";
import { ModelSettingsModal } from "@/components/ModelSettingsModal";
import { SourcesModal } from "@/components/SourcesModal";
import { parseQueryRoute, type RouteTier } from "@/lib/query-routing";
import { formatTipsMarkdown, INPUT_TIPS, INPUT_COMMANDS, tipColor } from "@/lib/input-tips";
import type { DoResult, FocusResult, ReindexResult, RagStatusWire } from "@/lib/do-types";
import { Wordmark } from "@/components/Wordmark";
import { VerifiedAnswersModal } from "@/components/VerifiedAnswersModal";
import { TelegramSettingsModal } from "@/components/TelegramSettingsModal";

type SessionRow = {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  /** True when this session is the one currently bound to a paired Telegram
   * chat — i.e. it's "live on the phone" right now (📱 badge). */
  telegramActive?: boolean;
};

type FocusFile = { fileId: number; name: string };

type StoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  citations: number[] | null;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  direct?: boolean;
  createdAt: number;
};

type ModelInfo = {
  id: string;
  displayName: string;
  contextWindow: number;
  /** USD per 1M tokens. null for local/free providers. */
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  pricedAsOf: string | null;
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
  /** Full chunk text — what was actually sent to the model. */
  text?: string;
  /** Source file modification time (epoch ms). */
  fileMtime?: number;
  startOffset: number;
  endOffset: number;
  distance: number;
};

/** Flattened chunk used by the transparency panels — works for both live hits
 * and citations resolved from history (the latter has no query-time distance). */
type SourceChunk = {
  filePath: string;
  sourcePath: string;
  text?: string;
  fileMtime?: number;
  distance?: number;
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
  /** Hits attached to assistant messages once the 'retrieved' event arrives
   * (live turns). Reloaded turns carry `citations` instead, resolved on demand. */
  hits?: Hit[];
  /** Stored citation chunk-IDs for reloaded messages (no live hits). */
  citations?: number[];
  /** Provider id used for the response (assistant messages only). */
  provider?: string;
  /** Actual model that produced the response — populated from the 'done' event. */
  model?: string | null;
  /** End-to-end duration in milliseconds, from query to last token. */
  durationMs?: number;
  /** Token usage if the provider reports it (Ollama doesn't; frontier providers do). */
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** True when a previously-verified answer boosted this response. */
  verifiedUsed?: boolean;
  /** True while the response is still streaming. */
  streaming?: boolean;
  /** True when this was a direct-to-model turn (`!` family) — no file search. */
  direct?: boolean;
  /** Routing tier (local / frontier-cheap / frontier-flagship) for the badge. */
  tier?: RouteTier;
  /** True for a local command result (e.g. /do, /focus) — render the body only,
   * no model footer / sources / copy chrome. */
  note?: boolean;
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
  // Shell-style input recall: submitted queries, navigated with ↑/↓.
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  // The unsent draft, stashed when history navigation starts and restored when
  // the user steps back past the newest entry.
  const draftRef = useRef("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credPrompt, setCredPrompt] = useState<MissingCredential | null>(null);
  const [keyDialogProvider, setKeyDialogProvider] =
    useState<ChatProviderInfo | null>(null);
  // Single source of truth for the centered modals — opened by the settings
  // popover, the onboarding flow, or the provider dropdown.
  const [activeModal, setActiveModal] = useState<
    "model" | "sources" | "verified" | "telegram" | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [modelModalOnboarding, setModelModalOnboarding] = useState(false);
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  // File Focus Mode (web): the active file scope for the current session, the
  // PIN modal for the `/do rag` write, and whether a Telegram chat is paired
  // (so the sidebar can offer "Continue on phone").
  const [focus, setFocusState] = useState<FocusFile[] | null>(null);
  const [pinModal, setPinModal] = useState<{ mode: "verify" | "setup"; count: number } | null>(null);
  const [telegramPaired, setTelegramPaired] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  // Tracks which originating sessions have a rag-status poller in flight, so two
  // concurrent `/do rag` adds each get their own completion handoff.
  const ragPollRef = useRef<Set<string>>(new Set());
  // When we open a fresh focused thread we seed its first bubble locally; this
  // tells the message-loader effect to skip its fetch (which would clobber it).
  const seededRef = useRef<string | null>(null);

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
        const data = (await res.json()) as { sessions: SessionRow[]; telegramPaired?: boolean };
        setSessions(data.sessions);
        setTelegramPaired(Boolean(data.telegramPaired));
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
    // A focus transition just seeded this new thread's first bubble — don't
    // overwrite it with an (empty) history fetch.
    if (seededRef.current === sessionId) {
      seededRef.current = null;
      return;
    }
    // Guard against a stale fetch resolving after the session changed again
    // (e.g. a fast focus transition) and clobbering the newer thread.
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions?id=${sessionId}`);
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { messages: StoredMessage[] };
        if (cancelled) return;
        setMessages(
          data.messages.map((m) => ({
            role: m.role,
            content: m.content,
            provider: m.provider ?? undefined,
            model: m.model ?? undefined,
            tokensIn: m.tokensIn,
            tokensOut: m.tokensOut,
            citations: m.citations ?? undefined,
            // Persisted so a reloaded `!` answer keeps its "Direct" label
            // instead of looking like an ordinary RAG answer.
            direct: m.direct,
          })),
        );
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // ---- Load the focus scope for the active session (shared with Telegram) ----
  useEffect(() => {
    if (!sessionId) {
      setFocusState(null);
      return;
    }
    // Guard against a stale focus fetch overwriting the chip after a fast switch.
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/focus?sessionId=${sessionId}`, { cache: "no-store" });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { files: FocusFile[] | null };
        if (!cancelled) setFocusState(data.files);
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
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

  // Open the custom confirm dialog (replaces the native confirm()).
  function deleteSession(id: string, title: string) {
    setDeleteTarget({ id, title });
  }

  async function confirmDeleteSession() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/sessions/${deleteTarget.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
      // If we just deleted the active session, reset state.
      if (sessionId === deleteTarget.id) newChat();
      await refreshSessions();
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
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

  // ── /do · /focus · /done · /reindex (the find→add→focus→chat workflow) ──────
  // These mirror the Telegram bot exactly; state is keyed by the shared session
  // id, so a thread continues seamlessly across phone and browser.

  /** Append a plain user-echo bubble (the typed command). */
  function pushUser(content: string) {
    setMessages((prev) => [...prev, { role: "user", content }]);
  }
  /** Append an assistant "note" bubble — body only, no model chrome. */
  function pushNote(content: string) {
    setMessages((prev) => [...prev, { role: "assistant", content, note: true }]);
  }

  /** Ensure a real session row exists before running a /do command (so its
   * working-set state and later queries share one id). */
  async function ensureSessionId(): Promise<string> {
    if (sessionId) return sessionId;
    const res = await fetch("/api/sessions", { method: "POST" });
    const data = (await res.json()) as { id: string };
    // Keep the command bubbles we just pushed — don't let the message-loader
    // effect replace them with this new session's (empty) history.
    seededRef.current = data.id;
    setSessionId(data.id);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_SESSION_KEY, data.id);
    return data.id;
  }

  /** Open a fresh thread (after a focus transition) and seed its first bubble. */
  function transitionTo(id: string, note: string, focused: FocusFile[] | null) {
    seededRef.current = id;
    setMessages([{ role: "assistant", content: note, note: true }]);
    setFocusState(focused);
    setSessionId(id);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_SESSION_KEY, id);
    void refreshSessions();
  }

  function formatRagOutcome(detail: Record<string, unknown>): string {
    const n = (k: string) => (typeof detail[k] === "number" ? (detail[k] as number) : 0);
    const parts: string[] = [];
    if (n("added")) parts.push(`added ${n("added")}`);
    if (n("updated")) parts.push(`re-indexed ${n("updated")}`);
    if (n("unchanged")) parts.push(`already up to date ${n("unchanged")}`);
    if (n("failed")) parts.push(`failed ${n("failed")}`);
    const head = parts.length ? parts.join(" · ") : "nothing to do";
    const chunks = n("chunks") > 0 ? ` — ${n("chunks")} chunk(s) embedded, searchable now.` : ".";
    return `${head}${chunks}`;
  }

  /** Poll the rag-ingest status started by `/do rag`, then report + auto-focus.
   * Keyed by the originating session so two concurrent adds don't share a lock. */
  function pollRag(startedFrom: string) {
    if (ragPollRef.current.has(startedFrom)) return;
    ragPollRef.current.add(startedFrom);
    const deadline = Date.now() + 5 * 60 * 1000;
    const tick = async () => {
      try {
        const res = await fetch(`/api/do?sessionId=${startedFrom}`, { cache: "no-store" });
        const data = (await res.json()) as { status: RagStatusWire | null };
        const st = data.status;
        if (st && st.state !== "chunking") {
          ragPollRef.current.delete(startedFrom);
          if (st.state === "error") {
            pushNote(`⚠️ ${String(st.detail.message ?? "ingest failed")}`);
            return;
          }
          const summary = formatRagOutcome(st.detail);
          const focusedId =
            typeof st.detail.focusedSessionId === "string" ? st.detail.focusedSessionId : undefined;
          const focusName = typeof st.detail.focusName === "string" ? st.detail.focusName : undefined;
          if (focusedId) {
            transitionTo(
              focusedId,
              `✅ ${summary}\n\n🎯 Now focused on **${focusName ?? "the file"}** — questions are scoped to it. Type \`/done\` to exit.`,
              null, // the focus effect will load the real focus for the new session
            );
          } else {
            pushNote(`✅ ${summary}`);
            await refreshSessions();
          }
          return;
        }
      } catch {
        // ignore a transient poll error; keep trying until the deadline
      }
      if (Date.now() < deadline) setTimeout(() => void tick(), 1500);
      else ragPollRef.current.delete(startedFrom);
    };
    setTimeout(() => void tick(), 1200);
  }

  /** Submit a PIN (verify a parked write, or bootstrap a new PIN). */
  async function submitPin(digits: string) {
    if (!pinModal) return;
    const sid = await ensureSessionId();
    if (pinModal.mode === "setup") {
      const res = await fetch("/api/do", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid, input: `pin ${digits}` }),
      });
      const data = (await res.json()) as DoResult;
      setPinModal(null);
      if (data.kind === "pin-set") pushNote("✅ PIN set. Run `/do rag <n>` again to add your files.");
      else if (data.kind === "message") pushNote(data.text);
      return;
    }
    // verify
    const res = await fetch("/api/do", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sid, pin: digits }),
    });
    const data = (await res.json()) as DoResult;
    if (data.kind === "rag-started") {
      setPinModal(null);
      pushNote("⏳ Adding to the index — chunking now. I'll update when it's ready.");
      pollRag(data.startedFrom);
    } else if (data.kind === "pin-bad") {
      const left =
        data.lockedMs != null
          ? `Locked for ${Math.ceil(data.lockedMs / 60000)} min.`
          : data.attemptsLeft != null
            ? `${data.attemptsLeft} attempt(s) left.`
            : "Try again.";
      setPinModal(null);
      pushNote(`❌ Wrong PIN. ${left} Re-run \`/do rag\` to retry.`);
    } else {
      setPinModal(null);
      if (data.kind === "message") pushNote(data.text);
    }
  }

  /** "Continue on phone": bind the paired Telegram chat(s) to a session. */
  async function bindToPhone(id: string) {
    try {
      const res = await fetch("/api/telegram/bind-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
      const data = (await res.json()) as { ok: boolean; reason?: string };
      if (data.ok) {
        await refreshSessions();
        setError(null);
      } else {
        setError(data.reason ?? "Couldn't bind this chat to Telegram.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Dispatch a slash command. Returns true if it was a recognized command. */
  async function runSlashCommand(raw: string): Promise<boolean> {
    const m = /^\/(do|focus|done|reindex)(?:\s+([\s\S]*))?$/i.exec(raw);
    if (!m) return false;
    const verb = m[1]!.toLowerCase();
    const rest = (m[2] ?? "").trim();
    pushUser(raw);
    const sid = await ensureSessionId();

    try {
      if (verb === "done") {
        const res = await fetch("/api/focus", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid, done: true }),
        });
        const data = (await res.json()) as FocusResult;
        if (data.kind === "off") {
          if (data.wasFocused && data.sessionId) {
            transitionTo(data.sessionId, "🌐 Focus off. Back to searching all your files.", null);
          } else {
            setFocusState(null);
            pushNote("You're not focused on a file. `/focus <name>` to scope to one.");
          }
        }
        return true;
      }

      if (verb === "focus") {
        const res = await fetch("/api/focus", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid, arg: rest }),
        });
        const data = (await res.json()) as FocusResult;
        if (data.kind === "focused") {
          const note =
            `🎯 Now focused on **${data.name}** — questions are scoped to this file. Type \`/done\` to exit.` +
            (data.metadataOnly && data.metaText ? `\n\n${data.metaText}` : "");
          transitionTo(data.sessionId, note, [{ fileId: -1, name: data.name }]);
        } else if (data.kind === "choose") {
          const list = data.matches.map((p) => `- \`${p}\``).join("\n");
          const more = data.more > 0 ? `\n\n…and ${data.more} more.` : "";
          pushNote(`Several indexed files match. Be more specific (e.g. include a parent folder):\n\n${list}${more}`);
        } else if (data.kind === "current") {
          pushNote(
            data.files && data.files.length > 0
              ? `🎯 Focused on **${data.files.map((f) => f.name).join(", ")}**. Type \`/done\` to exit.`
              : "Not focused. `/focus <name>` to scope to an indexed file, or `/do fs <name>` to find a new one.",
          );
        } else if (data.kind === "none") {
          pushNote(data.message);
        } else if (data.kind === "error") {
          pushNote(`⚠️ ${data.message}`);
        }
        return true;
      }

      if (verb === "reindex") {
        pushNote('⏳ Re-extracting the focused file… (scanned PDFs run OCR — may take a moment)');
        const res = await fetch("/api/reindex", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
        });
        const data = (await res.json()) as ReindexResult;
        if (data.kind === "readable") {
          transitionTo(
            data.sessionId,
            `✅ Extracted text from **${data.name}** — it's readable now. Ask away.`,
            [{ fileId: -1, name: data.name }],
          );
        } else if (data.kind === "still-empty") {
          pushNote(`📄 Still no readable text in **${data.name}**. ${data.reason}`);
        } else if (data.kind === "no-focus") {
          pushNote("Focus on a file first (`/focus <name>`), then `/reindex` to re-extract it.");
        } else {
          pushNote(`⚠️ Couldn't re-extract${data.name ? ` "${data.name}"` : ""}: ${data.message}`);
        }
        return true;
      }

      // verb === "do"
      const res = await fetch("/api/do", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid, input: rest }),
      });
      const data = (await res.json()) as DoResult;
      switch (data.kind) {
        case "verbs": {
          const lines = data.verbs.map((v) => `- \`${v.name}\` — ${v.summary}`);
          lines.push("- `rag` — add files you found to the index (PIN-gated)");
          pushNote(
            data.verbs.length === 0
              ? "No Mnemos aliases available yet. Create one under `~/.mnemos/do/` (see docs/agent/do-spec.md), then `/do <verb>`."
              : `**Mnemos aliases:**\n\n${lines.join("\n")}\n\nUse: \`/do fs <name>\`, then \`/do rag <n>\`.`,
          );
          break;
        }
        case "matches": {
          const numbered = data.items.map((p, i) => `${i + 1}. \`${p}\``).join("\n");
          const overflow = data.truncated ? "\n\n…more matches — narrow the pattern (e.g. add an extension)." : "";
          pushNote(
            `**${data.count} match(es)** for "${data.arg}":\n\n${numbered}${overflow}\n\nAdd to the index: \`/do rag <n>\` · \`1-3\` · \`all\``,
          );
          break;
        }
        case "rag-started":
          pushNote("⏳ Adding to the index — chunking now. I'll update when it's ready.");
          pollRag(data.startedFrom);
          break;
        case "rag-pin":
          setPinModal({ mode: "verify", count: data.count });
          break;
        case "rag-setup":
          setPinModal({ mode: "setup", count: 0 });
          break;
        case "rag-locked":
          pushNote(`🔒 Too many wrong PINs. Try again in ${Math.ceil(data.ms / 60000)} min.`);
          break;
        case "pin-set":
          pushNote("✅ PIN set. Run `/do rag <n>` again to add your files.");
          break;
        case "message":
          pushNote(data.text);
          break;
        case "error":
          pushNote(`⚠️ ${data.message}`);
          break;
      }
      return true;
    } catch (err) {
      pushNote(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const raw = input.trim();
    if (!raw || streaming) return;

    // The find → add → focus workflow commands (mirror the Telegram bot).
    if (/^\/(do|focus|done|reindex)(\s|$)/i.test(raw)) {
      setInput("");
      setInputHistory((h) => (h[h.length - 1] === raw ? h : [...h, raw]));
      setHistoryIdx(null);
      await runSlashCommand(raw);
      return;
    }

    // Local help command — render the input shortcuts as a chat bubble without
    // calling the model (mirrors Telegram's /tips). Same source of truth.
    if (raw === "/tips" || raw === "/help") {
      setInput("");
      setInputHistory((h) => (h[h.length - 1] === raw ? h : [...h, raw]));
      setHistoryIdx(null);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: raw },
        { role: "assistant", content: formatTipsMarkdown() },
      ]);
      return;
    }

    // /cost — frontier spend report. Needs server data, so fetch it and render
    // the returned markdown in a bubble (no model call).
    if (raw === "/cost") {
      setInput("");
      setInputHistory((h) => (h[h.length - 1] === raw ? h : [...h, raw]));
      setHistoryIdx(null);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: raw },
        { role: "assistant", content: "", streaming: true },
      ]);
      const finish = (content: string) =>
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, content, streaming: false };
          return next;
        });
      try {
        const res = await fetch("/api/cost");
        const data = (await res.json()) as { markdown?: string; message?: string };
        finish(
          res.ok && data.markdown
            ? data.markdown
            : `⚠️ Couldn't load cost: ${data.message ?? res.statusText}`,
        );
      } catch (err) {
        finish(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Routing prefix (!, !!, !!!, +, ++) decides direct-vs-RAG and the model
    // tier. The server parses it authoritatively; we parse here only to show the
    // cleaned text + the right badge optimistically. A bare prefix is ignored.
    const route = parseQueryRoute(raw);
    if (!route.q) return;

    // Record the raw input (with prefix) for ↑ recall so re-running reproduces
    // the same mode. Skip consecutive duplicates; reset navigation.
    setInputHistory((h) => (h[h.length - 1] === raw ? h : [...h, raw]));
    setHistoryIdx(null);
    setError(null);
    setCredPrompt(null);
    setInput("");
    setStreaming(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: route.q },
      {
        role: "assistant",
        content: "",
        streaming: true,
        provider: providerId,
        model: model || null,
        direct: route.direct,
        tier: route.tier,
      },
    ]);

    let assistantHits: Hit[] | undefined;
    let assistantText = "";

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Send the RAW input (with any routing prefix) — the server parses it
          // authoritatively into direct/tier and overrides provider/model for
          // frontier tiers. providerId/model below are used only for local tier.
          q: raw,
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
          // Restore the RAW input (with any leading `!`) so a direct question
          // stays direct on retry instead of silently reverting to RAG.
          setMessages((prev) => prev.slice(0, -2));
          setInput(raw);
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
          } else if (ev.phase === "notice" && typeof ev.message === "string") {
            // Focus is on a metadata-only file (no extractable text) — the server
            // replies with an honest, located notice instead of letting the model
            // improvise. Render it as the answer body.
            assistantText = ev.message;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, content: assistantText, note: true };
              }
              return next;
            });
          } else if (ev.phase === "done") {
            // Capture model + duration + token counts from the runQuery
            // 'done' event so the message footer can show "ollama · llama3.2:3b · 1.2s".
            const done = event as {
              phase: "done";
              provider?: string;
              model?: string | null;
              durationMs?: number;
              tokenCounts?: { in?: number | null; out?: number | null };
              verifiedAnswerUsed?: boolean;
              direct?: boolean;
            };
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  // Correct the optimistic guess: a frontier tier (+/!!) was
                  // resolved server-side to a different provider/model.
                  provider: done.provider ?? last.provider,
                  model: done.model ?? null,
                  durationMs: done.durationMs,
                  tokensIn: done.tokenCounts?.in ?? null,
                  tokensOut: done.tokenCounts?.out ?? null,
                  verifiedUsed: Boolean(done.verifiedAnswerUsed),
                  direct: Boolean(done.direct),
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
    const ta = e.currentTarget;

    // During IME composition, let the browser/IME own every key (↑/↓ pick
    // candidates, Enter commits) — none of our shortcuts should fire.
    if (e.nativeEvent.isComposing) return;

    // Ctrl+C clears the input (terminal-style) — but only with no selection, so
    // copying selected text still works. (Cmd+C on macOS is left untouched.)
    if (e.ctrlKey && !e.metaKey && (e.key === "c" || e.key === "C")) {
      if (ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        setInput("");
        setHistoryIdx(null);
      }
      return;
    }

    // ↑ recalls previous submitted inputs — only when the cursor is at the very
    // start, so editing a multi-line draft still moves the caret normally.
    if (
      e.key === "ArrowUp" &&
      ta.selectionStart === 0 &&
      ta.selectionEnd === 0 &&
      inputHistory.length > 0
    ) {
      e.preventDefault();
      // Starting navigation — stash the unsent draft so ↓ can restore it.
      if (historyIdx === null) draftRef.current = input;
      const next =
        historyIdx === null ? inputHistory.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setInput(inputHistory[next] ?? "");
      return;
    }

    // ↓ steps forward through recalled inputs, restoring the draft at the end.
    if (e.key === "ArrowDown" && historyIdx !== null) {
      e.preventDefault();
      const next = historyIdx + 1;
      if (next >= inputHistory.length) {
        setHistoryIdx(null);
        setInput(draftRef.current);
      } else {
        setHistoryIdx(next);
        setInput(inputHistory[next] ?? "");
      }
      return;
    }

    // Standard chat affordance: Enter sends, Shift+Enter newlines.
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
        ? providerId === "codex"
          ? "ChatGPT plan"
          : "free (local)"
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
      {pinModal && (
        <PinDialog
          mode={pinModal.mode}
          count={pinModal.count}
          onSubmit={(digits) => void submitPin(digits)}
          onClose={() => setPinModal(null)}
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
      {deleteTarget && (
        <ConfirmDialog
          title="Delete chat?"
          danger
          confirmLabel="Delete"
          busy={deleting}
          message={
            <>
              This permanently deletes{" "}
              <span className="text-fg font-medium">
                “{deleteTarget.title}”
              </span>{" "}
              and its messages. This can&apos;t be undone.
            </>
          }
          onConfirm={() => void confirmDeleteSession()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {activeModal === "verified" && (
        <VerifiedAnswersModal onClose={() => setActiveModal(null)} />
      )}
      {activeModal === "telegram" && (
        <TelegramSettingsModal onClose={() => setActiveModal(null)} />
      )}
      {/* Sidebar */}
      <aside className="border-r border-line bg-surface flex flex-col">
        <div className="px-4 py-3.5 border-b border-line flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={28} height={28} unoptimized priority />
          <Wordmark className="text-sm font-semibold" />
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
                  // Right padding leaves room for the hover actions (phone + ×).
                  const pad = telegramPaired ? "pr-12" : "pr-7";
                  return (
                    <li key={s.id} className="group/session relative">
                      <button
                        onClick={() => setSessionId(s.id)}
                        className={`w-full text-left pl-2 ${pad} py-1.5 rounded text-xs truncate transition ${
                          s.id === sessionId
                            ? "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
                            : "text-fg/90 hover:bg-app"
                        }`}
                        title={s.telegramActive ? `${label} — active on Telegram` : label}
                      >
                        {s.telegramActive && (
                          <span className="mr-1" aria-hidden title="Active on Telegram">📱</span>
                        )}
                        {label}
                      </button>
                      {/* "Continue on phone": re-point the paired Telegram chat at
                          this session, so it can be picked up on the phone. Hidden
                          for the session already live there. */}
                      {telegramPaired && !s.telegramActive && (
                        <button
                          onClick={() => void bindToPhone(s.id)}
                          className="absolute right-7 top-1/2 -translate-y-1/2 opacity-0 group-hover/session:opacity-100 transition rounded text-muted hover:text-amber-400 hover:bg-amber-500/10 w-5 h-5 flex items-center justify-center text-xs"
                          title="Continue this chat on your phone (Telegram)"
                          aria-label="Continue on phone"
                        >
                          📱
                        </button>
                      )}
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
            onOpenVerified={() => setActiveModal("verified")}
            onOpenTelegram={() => setActiveModal("telegram")}
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
                  + Add a folder or file
                </button>
              ) : (
                <p className="text-xs mt-1 text-muted/70">
                  {sessions.length === 0
                    ? "Tip: add a folder or file from Settings & Sources."
                    : "Or pick a past chat from the sidebar."}
                </p>
              )}
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageBubble
                key={i}
                message={m}
                providers={providers}
                question={
                  messages[i - 1]?.role === "user"
                    ? messages[i - 1]?.content
                    : undefined
                }
              />
            ))
          )}
        </div>

        <form
          onSubmit={send}
          className="border-t border-line px-6 py-4 bg-surface"
        >
          {focus && focus.length > 0 && (
            <div className="mb-2 flex items-center gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-700 dark:text-amber-300">
                <span aria-hidden>🎯</span> Focused on{" "}
                <span className="font-medium">{focus.map((f) => f.name).join(", ")}</span>
              </span>
              <button
                type="button"
                onClick={() => void runSlashCommand("/done")}
                className="text-muted hover:text-fg underline"
                title="Back to searching all your files"
              >
                exit focus
              </button>
            </div>
          )}
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
          <div className="relative flex gap-2 items-end">
            <FloatingThemeToggle />
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Typing ends history navigation — this is a fresh draft now.
                setHistoryIdx(null);
              }}
              onKeyDown={onKeyDown}
              placeholder={
                streaming
                  ? "Streaming…"
                  : focus && focus.length > 0
                    ? `Ask about ${focus[0]?.name ?? "this file"}… (/done to exit)`
                    : "Ask your files… (or /do to find & add, see below)"
              }
              disabled={streaming}
              rows={2}
              className="flex-1 bg-app border border-line rounded-md px-3 py-2 text-sm text-fg placeholder:text-muted focus:outline-none focus:border-cyan-500 transition disabled:opacity-50 resize-none"
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
          {/* Routing legend that doubles as a live mode indicator: shows the
              prefix key normally, and the active mode once a sigil is typed. */}
          {(() => {
            const r = parseQueryRoute(input);
            if (!input.trim() || r.sigil === "") {
              return (
                <div className="mt-1.5 space-y-0.5">
                  {/* Rendered from INPUT_TIPS / INPUT_COMMANDS so the legend can't
                      drift from /tips and Telegram /help — one source of truth. */}
                  <div className="text-[11px] text-muted flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    {INPUT_TIPS.map((t) => {
                      const c = tipColor(t.syntax);
                      const cls =
                        c === "amber" ? "text-amber-400" : c === "sky" ? "text-sky-400" : "text-muted";
                      return (
                        <span key={t.syntax}>
                          <code className={cls}>{t.syntax}</code> {t.short}
                        </span>
                      );
                    })}
                    <span className="text-muted">· <code>/tips</code> for details</span>
                  </div>
                  <div className="text-[11px] text-muted flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span className="text-muted">find &amp; focus:</span>
                    {INPUT_COMMANDS.filter((c) => c.cmd !== "/do").map((c) => (
                      <span key={c.cmd}>
                        <code className="text-emerald-500 dark:text-emerald-400">{c.cmd}</code> {c.short}
                      </span>
                    ))}
                  </div>
                </div>
              );
            }
            const files = r.direct ? "skip your files" : "search your files";
            const brain =
              r.tier === "local"
                ? "local model"
                : r.tier === "frontier-flagship"
                  ? "frontier model (flagship)"
                  : "frontier model";
            return (
              <div className="mt-1.5 text-[11px] text-amber-400">
                → Mode: {files} · {brain}
              </div>
            );
          })()}
          <div className="mt-1 text-[10px] text-muted">
            ⏎ send · ⇧⏎ newline · ↑ history · ⌃C clear
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

/** 6-digit PIN dialog for the `/do rag` write — either confirming a parked add
 * (verify) or setting the PIN the first time (setup). The PIN is a proof-of-human
 * the model structurally can't supply; it never gates reads or chat. */
function PinDialog({
  mode,
  count,
  onSubmit,
  onClose,
}: {
  mode: "verify" | "setup";
  count: number;
  onSubmit: (digits: string) => void;
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const ok = /^\d{6}$/.test(pin);
  const setup = mode === "setup";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-line bg-elevated text-fg p-5 shadow-2xl aurora-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1">
          <span aria-hidden>🔒</span>
          <h2 className="text-sm font-semibold text-fg">
            {setup ? "Set your write PIN" : "Confirm with your PIN"}
          </h2>
        </div>
        <p className="text-xs text-muted leading-relaxed mb-3">
          {setup
            ? "Adding files to the index is guarded by a 6-digit PIN — a proof-of-human the model can't supply. Set it once; you'll re-enter it on a daily cadence (or on an unusually large add). It never gates reading or chatting."
            : `Enter your 6-digit PIN to add ${count} file${count === 1 ? "" : "s"} to the index.`}
        </p>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ok) onSubmit(pin);
            if (e.key === "Escape") onClose();
          }}
          placeholder="••••••"
          className="w-full bg-surface border border-line rounded-md px-3 py-2 text-center text-lg tracking-[0.5em] font-mono text-fg focus:outline-none focus:border-cyan-500"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface hover:text-fg transition"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(pin)}
            disabled={!ok}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-xs font-semibold text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {setup ? "Set PIN" : "Confirm"}
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
  question,
}: {
  message: LiveMessage;
  providers: ChatProviderInfo[];
  /** The user question this answer responded to (for "Save as verified"). */
  question?: string;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [panel, setPanel] = useState<"sources" | "audit" | null>(null);
  const [chunks, setChunks] = useState<SourceChunk[] | null>(null);
  const [loadingChunks, setLoadingChunks] = useState(false);
  const [verifyState, setVerifyState] = useState<"idle" | "saving" | "saved">("idle");

  const hasSources =
    (message.hits?.length ?? 0) > 0 || (message.citations?.length ?? 0) > 0;

  // Save this answer as a verified Q→A so future similar questions get it
  // injected. Chunk IDs come from live hits or reloaded citations.
  async function saveVerified() {
    if (!question || verifyState !== "idle") return;
    const chunkIds =
      message.hits?.map((h) => h.chunkId) ?? message.citations ?? [];
    setVerifyState("saving");
    try {
      const r = await fetch("/api/verified", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question,
          answer: message.content,
          chunkIds,
          provider: message.provider,
          model: message.model ?? undefined,
        }),
      });
      setVerifyState(r.ok ? "saved" : "idle");
    } catch {
      setVerifyState("idle");
    }
  }

  function copyToClipboard() {
    if (!message.content) return;
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Resolve the chunks behind this answer. Live turns already carry full hits;
  // reloaded turns resolve their stored citation IDs on demand via /api/chunks.
  async function openPanel(which: "sources" | "audit") {
    setPanel(which);
    if (chunks) return;
    if (message.hits && message.hits.length > 0) {
      setChunks(
        message.hits.map((h) => ({
          filePath: h.filePath,
          sourcePath: h.sourcePath,
          text: h.text ?? h.snippet,
          fileMtime: h.fileMtime,
          distance: h.distance,
        })),
      );
      return;
    }
    if (message.citations && message.citations.length > 0) {
      setLoadingChunks(true);
      try {
        const r = await fetch(`/api/chunks?ids=${message.citations.join(",")}`, {
          cache: "no-store",
        });
        if (r.ok) {
          const d = (await r.json()) as { chunks: SourceChunk[] };
          setChunks(d.chunks);
        }
      } catch {
        // silent — panel shows an empty state
      } finally {
        setLoadingChunks(false);
      }
    }
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} group`}>
      <div
        className={`max-w-3xl rounded-lg px-4 py-3 relative aurora-card ${
          isUser
            ? "bg-cyan-50 border border-cyan-300 text-fg dark:bg-cyan-900/30 dark:border-cyan-900/50"
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
        {!isUser && !message.streaming && message.content && !message.note && (
          <div className="flex items-center justify-between mt-2 text-xs text-muted gap-3">
            <span className="flex items-center gap-2 min-w-0">
              {message.direct ? (
                <span
                  className="text-amber-400 shrink-0"
                  title="Direct question to the model — your files were not searched"
                >
                  ⚡ Direct · files not searched
                </span>
              ) : (message.tier && message.tier !== "local") ||
                providers.find((p) => p.id === message.provider)?.needsKey ? (
                // Frontier badge: from `tier` while live, or derived from the
                // persisted (frontier) provider on reload — so `+`/`++` turns
                // keep the badge after a refresh, not just `!` turns.
                <span
                  className="text-sky-400 shrink-0 inline-flex items-center gap-1"
                  title="Searched your files, answered by a frontier model"
                >
                  {/* Inline SVG (not the ☁️ emoji): the emoji is a fixed-color
                      glyph that's near-invisible on the white zen-light card. This
                      tints with currentColor, so it reads in both themes. */}
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor" aria-hidden>
                    <path d="M6.6 19a4.6 4.6 0 0 1-.62-9.16 6 6 0 0 1 11.65 1.07A3.85 3.85 0 0 1 17.3 19H6.6Z" />
                  </svg>
                  Frontier
                </span>
              ) : null}
              {message.verifiedUsed && (
                <span
                  className="text-emerald-400 shrink-0"
                  title="Boosted by a previously-verified answer"
                >
                  ✓ verified
                </span>
              )}
              <span className="truncate">{formatMessageMetrics(message, providers)}</span>
              {hasSources && (
                <>
                  <span aria-hidden>·</span>
                  <button
                    onClick={() => void openPanel("sources")}
                    className="text-cyan-400 hover:text-cyan-300 shrink-0 underline underline-offset-2 decoration-1"
                    title="Files this answer drew from"
                  >
                    Sources
                  </button>
                  <button
                    onClick={() => void openPanel("audit")}
                    className="text-cyan-400 hover:text-cyan-300 shrink-0 underline underline-offset-2 decoration-1"
                    title="Exactly what was sent to the model"
                  >
                    Data sent
                  </button>
                  {question && (
                    <button
                      onClick={() => void saveVerified()}
                      disabled={verifyState !== "idle"}
                      className="text-emerald-400 hover:text-emerald-300 shrink-0 underline underline-offset-2 decoration-1 disabled:opacity-60 disabled:no-underline"
                      title="Confirm this answer is correct — similar future questions will reuse it"
                    >
                      {verifyState === "saved"
                        ? "✓ saved"
                        : verifyState === "saving"
                          ? "saving…"
                          : "✓ Save verified"}
                    </button>
                  )}
                </>
              )}
            </span>
            <button
              onClick={copyToClipboard}
              className="opacity-0 group-hover:opacity-100 transition rounded border border-line hover:border-cyan-700 bg-surface hover:bg-app px-2 py-0.5 text-[11px] text-muted hover:text-fg shrink-0"
              title="Copy response"
            >
              {copied ? "✓ copied" : "copy"}
            </button>
          </div>
        )}
        {panel === "sources" && (
          <SourcesPanel
            chunks={chunks}
            loading={loadingChunks}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === "audit" && (
          <DataSentPanel
            chunks={chunks}
            loading={loadingChunks}
            provider={message.provider}
            model={message.model ?? null}
            tokensIn={message.tokensIn ?? null}
            onClose={() => setPanel(null)}
          />
        )}
      </div>
    </div>
  );
}

/** Absolute file path = registered source folder + the file's relative path. */
function absPath(c: SourceChunk): string {
  return `${c.sourcePath.replace(/\/+$/, "")}/${c.filePath}`;
}

function formatMtime(ms?: number): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Sources" panel: the files this answer drew from, with copyable absolute
 * paths + modified date + chunk count (and relevance on live turns). */
function SourcesPanel({
  chunks,
  loading,
  onClose,
}: {
  chunks: SourceChunk[] | null;
  loading: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const files = useMemo(() => {
    const map = new Map<
      string,
      { path: string; mtime?: number; count: number; bestDistance?: number }
    >();
    for (const c of chunks ?? []) {
      const p = absPath(c);
      const e = map.get(p);
      if (e) {
        e.count += 1;
        if (c.distance != null && (e.bestDistance == null || c.distance < e.bestDistance))
          e.bestDistance = c.distance;
      } else {
        map.set(p, { path: p, mtime: c.fileMtime, count: 1, bestDistance: c.distance });
      }
    }
    return [...map.values()];
  }, [chunks]);

  function copyPath(p: string) {
    void navigator.clipboard.writeText(p).then(() => {
      setCopied(p);
      setTimeout(() => setCopied((cur) => (cur === p ? null : cur)), 1500);
    });
  }

  return (
    <Modal title="Sources" onClose={onClose} maxWidth="max-w-2xl">
      <p className="text-xs text-muted mb-3">
        Files this answer drew from. Click a path to copy it.
      </p>
      {loading ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : files.length === 0 ? (
        <p className="text-xs text-muted">No sources for this answer.</p>
      ) : (
        <ul className="space-y-2">
          {files.map((f) => (
            <li key={f.path} className="rounded-md border border-line bg-surface px-3 py-2">
              <button
                onClick={() => copyPath(f.path)}
                title="Click to copy path"
                className="block w-full text-left font-mono text-xs text-fg break-all hover:text-cyan-300 transition"
              >
                {f.path}
              </button>
              <div className="text-[11px] text-muted mt-1">
                {copied === f.path ? "✓ copied · " : ""}
                {f.count} chunk{f.count > 1 ? "s" : ""}
                {formatMtime(f.mtime) ? ` · modified ${formatMtime(f.mtime)}` : ""}
                {f.bestDistance != null
                  ? ` · relevance ${(1 - f.bestDistance).toFixed(2)}`
                  : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** "Data sent" panel: the privacy audit — exactly which chunks went to the
 * model (never raw files), framed local vs external. */
function DataSentPanel({
  chunks,
  loading,
  provider,
  model,
  tokensIn,
  onClose,
}: {
  chunks: SourceChunk[] | null;
  loading: boolean;
  provider?: string;
  model: string | null;
  tokensIn: number | null;
  onClose: () => void;
}) {
  const isLocal = provider === "ollama" || provider === "local";
  const list = chunks ?? [];
  return (
    <Modal title="What was sent" onClose={onClose} maxWidth="max-w-2xl">
      <div
        className={`mb-3 rounded-md border px-3 py-2 text-xs leading-relaxed ${
          isLocal
            ? "border-emerald-600/40 bg-emerald-500/10"
            : "border-cyan-700/40 bg-cyan-500/10"
        }`}
      >
        {isLocal ? (
          <>
            🟢 <span className="font-medium">100% local.</span> This ran on{" "}
            <span className="font-mono">{provider}</span>
            {model ? ` (${model})` : ""} — nothing left your machine. The chunks
            below were the context used.
          </>
        ) : (
          <>
            📤 Sent to <span className="font-medium">{provider}</span>
            {model ? ` (${model})` : ""}. Only the retrieved chunks below were
            sent — <span className="font-medium">never your raw files</span>.
            {typeof tokensIn === "number" && tokensIn > 0
              ? ` ~${tokensIn} input tokens.`
              : ""}
          </>
        )}
      </div>
      {loading ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted">No chunks were retrieved for this answer.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((c, i) => (
            <li key={i} className="rounded-md border border-line bg-surface px-3 py-2">
              <div className="font-mono text-[11px] text-muted mb-1 break-all">
                [{i + 1}] {absPath(c)}
              </div>
              <div className="text-xs text-fg/90 whitespace-pre-wrap max-h-44 overflow-y-auto">
                {c.text ?? "(text unavailable)"}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
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
