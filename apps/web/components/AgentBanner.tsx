"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ConfigStatus = {
  provider: string | null;
  hasCredential: boolean;
  embedding: string;
  ready: boolean;
  reason: string | null;
};

/**
 * Renders a top-of-page banner whenever the LLM agent isn't fully configured.
 * Polls /api/config on mount and after window focus, so changes made in the
 * /agent page propagate to other tabs without manual refresh.
 *
 * Returns null when the agent is ready — no chrome in the steady state.
 */
export function AgentBanner() {
  const [status, setStatus] = useState<ConfigStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/config", { cache: "no-store" });
        if (!r.ok) return;
        const s = (await r.json()) as ConfigStatus;
        if (!cancelled) setStatus(s);
      } catch {
        // network blip; banner stays hidden
      }
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!status || status.ready) return null;

  const tone =
    status.provider === null
      ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
      : "border-red-500/40 bg-red-500/10 text-red-300";

  const label =
    status.provider === null ? "Configure your AI agent" : "Agent needs attention";

  const detail =
    status.reason ??
    "Pick a chat provider (Claude, GPT, Gemini, Ollama, or fully local) before using Mnemos.";

  return (
    <div className={`border-b px-4 py-2.5 text-sm ${tone}`}>
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div>
          <span className="font-semibold">{label}</span>
          <span className="ml-2 opacity-80">{detail}</span>
        </div>
        <Link
          href="/agent"
          className="rounded-md bg-fg/10 px-3 py-1 text-sm font-medium hover:bg-fg/20 transition"
        >
          Open settings →
        </Link>
      </div>
    </div>
  );
}
