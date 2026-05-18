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
  createdAt: number;
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
};

type LiveMessage = {
  role: "user" | "assistant";
  content: string;
  /** Hits attached to assistant messages once the 'retrieved' event arrives. */
  hits?: Hit[];
  /** Provider id used for the response (assistant messages only). */
  provider?: string;
  /** True while the response is still streaming. */
  streaming?: boolean;
};

const STORAGE_SESSION_KEY = "mnemos.lastSessionId";
const STORAGE_PROVIDER_KEY = "mnemos.lastProviderId";

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [providers, setProviders] = useState<ChatProviderInfo[]>([]);
  const [providerId, setProviderId] = useState<string>("anthropic");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // ---- Load providers + last session on mount ----
  useEffect(() => {
    void (async () => {
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
      if (lastProvider) setProviderId(lastProvider);

      const lastSession =
        typeof window !== "undefined"
          ? window.localStorage.getItem(STORAGE_SESSION_KEY)
          : null;
      if (lastSession) setSessionId(lastSession);
    })();
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

  function rememberProvider(id: string) {
    setProviderId(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_PROVIDER_KEY, id);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || streaming) return;

    setError(null);
    setInput("");
    setStreaming(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: q },
      { role: "assistant", content: "", streaming: true, provider: providerId },
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
        }),
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send(e as unknown as FormEvent);
    }
  }

  return (
    <main className="grid grid-cols-[260px_1fr] min-h-screen bg-[#0a0a14] text-gray-100">
      {/* Sidebar */}
      <aside className="border-r border-gray-800 bg-gray-900/40 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-800 flex items-center justify-between">
          <Link href="/" className="text-cyan-300 hover:text-cyan-200 text-sm">
            ← mnemos
          </Link>
          <button
            onClick={newChat}
            className="text-xs px-2 py-1 rounded bg-cyan-500 text-gray-900 font-semibold hover:bg-cyan-400 transition"
          >
            + New
          </button>
        </div>
        <div className="px-4 py-2 text-xs uppercase tracking-wider text-gray-500">
          History
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-4 space-y-1">
          {sessions.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-gray-600">No sessions yet</li>
          )}
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => setSessionId(s.id)}
                className={`w-full text-left px-2 py-1.5 rounded text-xs truncate transition ${
                  s.id === sessionId
                    ? "bg-cyan-900/30 text-cyan-200"
                    : "text-gray-300 hover:bg-gray-800/60"
                }`}
                title={s.id}
              >
                {s.title ?? formatSessionPreview(s)}
              </button>
            </li>
          ))}
        </ul>
        <div className="px-4 py-3 border-t border-gray-800 text-xs text-gray-500">
          <Link href="/sources" className="hover:text-cyan-300 transition">
            ↗ Manage sources
          </Link>
        </div>
      </aside>

      {/* Main */}
      <section className="flex flex-col h-screen">
        <header className="flex items-center justify-between px-6 py-3 border-b border-gray-800">
          <h1 className="text-sm font-semibold text-gray-200">Chat</h1>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500" htmlFor="provider">
              Provider
            </label>
            <select
              id="provider"
              value={providerId}
              onChange={(e) => rememberProvider(e.target.value)}
              disabled={streaming}
              className="bg-gray-900 border border-gray-700 rounded text-xs px-2 py-1 text-gray-100 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div ref={threadRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-gray-500">
              <div className="text-5xl mb-3">🧠</div>
              <p className="text-sm">
                Ask a question about your indexed sources.
              </p>
              <p className="text-xs mt-1 text-gray-600">
                {sessions.length === 0
                  ? "Tip: register a folder under Manage sources first."
                  : "Or pick a past chat from the sidebar."}
              </p>
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))
          )}
        </div>

        <form
          onSubmit={send}
          className="border-t border-gray-800 px-6 py-4 bg-gray-950/50"
        >
          {error && (
            <div className="mb-2 text-xs text-red-400">{error}</div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                streaming
                  ? "Streaming…"
                  : "Ask anything about your sources. (⌘↵ to send)"
              }
              disabled={streaming}
              rows={2}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-cyan-500 transition disabled:opacity-50 resize-none font-mono"
            />
            <button
              type="submit"
              disabled={streaming || !input.trim()}
              className="rounded-md bg-amber-500 px-5 py-2.5 text-sm font-semibold text-gray-900 hover:bg-amber-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {streaming ? "…" : "Send"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function MessageBubble({ message }: { message: LiveMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-3xl rounded-lg px-4 py-3 ${
          isUser
            ? "bg-cyan-900/30 border border-cyan-900/50"
            : "bg-gray-900/60 border border-gray-800"
        }`}
      >
        {!isUser && message.hits && message.hits.length > 0 && (
          <Citations hits={message.hits} />
        )}
        <div className="text-sm text-gray-100 whitespace-pre-wrap leading-relaxed">
          {message.content || (
            <span className="text-gray-500 italic">Thinking…</span>
          )}
          {message.streaming && message.content && (
            <span className="inline-block w-2 h-4 ml-1 bg-amber-400 animate-pulse" />
          )}
        </div>
        {!isUser && message.provider && !message.streaming && (
          <div className="text-xs text-gray-500 mt-2">via {message.provider}</div>
        )}
      </div>
    </div>
  );
}

function Citations({ hits }: { hits: Hit[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className="mb-3">
      <div className="flex flex-wrap gap-1 mb-1">
        {hits.map((h) => (
          <button
            key={h.ref}
            onClick={() => setExpanded(expanded === h.ref ? null : h.ref)}
            className={`text-[10px] px-1.5 py-0.5 rounded transition border ${
              expanded === h.ref
                ? "bg-amber-500 text-gray-900 border-amber-400"
                : "bg-amber-900/30 text-amber-300 border-amber-900/50 hover:bg-amber-900/50"
            }`}
            title={`${h.filePath} (distance ${h.distance.toFixed(3)})`}
          >
            [{h.ref}] {shortPath(h.filePath)}
          </button>
        ))}
      </div>
      {expanded !== null && (
        <div className="text-xs font-mono bg-gray-950/60 border border-gray-800 rounded p-2 mb-2 text-gray-300 max-h-40 overflow-y-auto">
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

function formatSessionPreview(s: SessionRow): string {
  const d = new Date(s.updatedAt);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
