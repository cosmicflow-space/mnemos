"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { getTheme, setTheme, type Theme } from "@/lib/theme";

type IngestStatus = {
  overall: "running" | "paused" | "error" | "idle";
  sources: Array<{
    state: "running" | "paused" | "error";
    filesDone: number;
    filesTotal: number;
    currentPath?: string;
    path: string;
  }>;
};

/**
 * Compact bottom-left settings launcher: a circular Mnemos avatar (brand +
 * "account menu", the ChatGPT/Claude convention) that opens a small slide-up
 * popover. Quick toggles live in the popover; heavier surfaces (Sources, AI
 * Model) open as centered modals owned by the page.
 */
export function SettingsMenu({
  onOpenSources,
  onOpenModel,
  onOpenVerified,
  onOpenTelegram,
}: {
  onOpenSources: () => void;
  onOpenModel: () => void;
  onOpenVerified: () => void;
  onOpenTelegram: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>("dark");
  const [ingest, setIngest] = useState<IngestStatus>({ overall: "idle", sources: [] });
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setThemeState(getTheme());
  }, []);

  // Poll live ingestion status so the launcher ring reflects running/paused.
  // Cheap in-memory endpoint; 3s cadence is plenty for a status light.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/ingest/status", { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as IngestStatus;
        if (alive) setIngest(data);
      } catch {
        /* transient — keep last known state */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  const toNext = theme === "dark" ? "Light mode" : "Dark mode";
  const toNextIcon = theme === "dark" ? "☀️" : "🌙";

  const ringClass =
    ingest.overall === "running"
      ? "mnemos-ring-running"
      : ingest.overall === "paused"
        ? "mnemos-ring-paused"
        : ingest.overall === "error"
          ? "mnemos-ring-error"
          : "";
  const activeSource = ingest.sources.find((s) => s.state === "running");
  const ingestTitle =
    ingest.overall === "running" && activeSource
      ? `Ingesting ${activeSource.filesDone}/${activeSource.filesTotal || "?"} files…`
      : ingest.overall === "paused"
        ? "Ingestion paused"
        : ingest.overall === "error"
          ? "Ingest error — open Sources"
          : "Settings & Sources";

  return (
    <div ref={ref} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-52 rounded-xl border border-line bg-elevated shadow-2xl overflow-hidden text-sm">
          <button
            onClick={toggleTheme}
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-fg hover:bg-surface transition"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden>{toNextIcon}</span> {toNext}
            </span>
          </button>
          <div className="border-t border-line" />
          <button
            onClick={() => {
              onOpenModel();
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-fg hover:bg-surface transition"
          >
            <span aria-hidden>🤖</span> AI Model
          </button>
          <button
            onClick={() => {
              onOpenSources();
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-fg hover:bg-surface transition"
          >
            <span aria-hidden>📁</span> Sources
          </button>
          <button
            onClick={() => {
              onOpenVerified();
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-fg hover:bg-surface transition"
          >
            <span aria-hidden>✓</span> Verified answers
          </button>
          <button
            onClick={() => {
              onOpenTelegram();
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-fg hover:bg-surface transition"
          >
            <span aria-hidden>📲</span> Telegram
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        title={ingestTitle}
        aria-label="Settings & Sources"
        aria-haspopup="true"
        aria-expanded={open}
        data-ingest={ingest.overall}
        className={`w-9 h-9 rounded-full flex items-center justify-center transition border bg-gradient-to-br from-cyan-500/25 to-indigo-500/25 ${
          ringClass
            ? ringClass
            : open
              ? "border-cyan-400 shadow-[0_0_18px_-4px_rgba(6,182,212,0.9)]"
              : "border-cyan-600/50 hover:border-cyan-400 shadow-[0_0_14px_-6px_rgba(99,102,241,0.7)]"
        }`}
      >
        <Image src="/logo.svg" alt="Mnemos settings" width={20} height={20} unoptimized />
      </button>
    </div>
  );
}
