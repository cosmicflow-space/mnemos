"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";

type SourceRow = {
  id: number;
  path: string;
  kind: string;
  chunkCount: number;
  fileCount?: number;
  watchIntervalMs?: number;
  lastScannedAt?: number | null;
  nextScanDueAt?: number | null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Auto re-scan cadence choices. Daily is the default; "Manual only" (0) opts a
// source out of background re-scans entirely.
const INTERVAL_OPTIONS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "Every 5 min", ms: 5 * MINUTE },
  { label: "Every 15 min", ms: 15 * MINUTE },
  { label: "Hourly", ms: HOUR },
  { label: "Every 6 hours", ms: 6 * HOUR },
  { label: "Daily", ms: DAY },
  { label: "Manual only", ms: 0 },
];

function intervalLabel(ms: number | undefined): string {
  if (ms === 0) return "Manual only";
  const found = INTERVAL_OPTIONS.find((o) => o.ms === ms);
  return found ? found.label : "Daily";
}

/** "in 3h", "in 12m", "due now" — coarse, human, no live ticking needed. */
function nextScanText(row: SourceRow): string | null {
  if (!row.watchIntervalMs) return null; // manual only
  const due = row.nextScanDueAt ?? 0;
  const delta = due - Date.now();
  if (delta <= 0) return "due now";
  if (delta < HOUR) return `in ${Math.max(1, Math.round(delta / MINUTE))}m`;
  if (delta < DAY) return `in ${Math.round(delta / HOUR)}h`;
  return `in ${Math.round(delta / DAY)}d`;
}

/**
 * Manage sources without leaving chat: list registered folders, add a new one
 * (add + ingest with live progress), and remove. Mirrors /api/sources and
 * /api/ingest. This is the focused Phase-1 surface; the richer scan/exclusion
 * preview from the standalone page folds in when that page is retired.
 */
export function SourcesModal({
  onChanged,
  onClose,
}: {
  onChanged: () => void;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [path, setPath] = useState("");
  // New sources default to manual re-scan (0) — opt into a cadence per folder.
  const [addInterval, setAddInterval] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Live per-source ingest state (running/paused/error + progress), polled.
  const [ingest, setIngest] = useState<
    Record<number, { state: string; filesDone: number; filesTotal: number }>
  >({});
  const [anyRunning, setAnyRunning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/sources", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as { sources: SourceRow[] };
        setSources(d.sources);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll ingest status so each row can show Pause/Resume + progress, and refresh
  // the source list (chunk counts) when a run finishes.
  useEffect(() => {
    let alive = true;
    let wasRunning = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/ingest/status", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as {
          sources: Array<{ sourceId: number; state: string; filesDone: number; filesTotal: number }>;
          running: number;
        };
        if (!alive) return;
        const map: Record<number, { state: string; filesDone: number; filesTotal: number }> = {};
        for (const s of d.sources) {
          map[s.sourceId] = { state: s.state, filesDone: s.filesDone, filesTotal: s.filesTotal };
        }
        setIngest(map);
        setAnyRunning(d.running > 0);
        if (wasRunning && d.running === 0) void refresh(); // run finished → counts changed
        wasRunning = d.running > 0;
      } catch {
        /* transient */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refresh]);

  async function pauseSource(id: number) {
    await fetch("/api/ingest/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: id }),
    });
  }
  async function resumeSource(id: number) {
    await fetch("/api/ingest/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: id }),
    });
  }
  async function pauseAll() {
    await fetch("/api/ingest/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  }

  // Ingest a path, draining the SSE progress stream. Unchanged files are skipped
  // server-side (incremental), so re-running is cheap. Throws on error.
  async function ingestPath(p: string) {
    setStatus("Ingesting… (reading, chunking, embedding)");
    const ingRes = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    if (!ingRes.ok || !ingRes.body) throw new Error((await ingRes.text()) || "ingest failed");

    const reader = ingRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const b of blocks) {
        const line = b.trim();
        if (!line.startsWith("data: ")) continue;
        let ev: { phase?: string; message?: string; files?: number; chunks?: number };
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.phase === "error") throw new Error(ev.message ?? "ingest error");
        if (typeof ev.files === "number" || typeof ev.chunks === "number") {
          setStatus(`Ingesting… ${ev.files ?? 0} files, ${ev.chunks ?? 0} chunks`);
        } else if (ev.phase) {
          setStatus(`Ingesting… ${ev.phase}`);
        }
      }
    }
  }

  async function addAndIngest() {
    const p = path.trim();
    if (!p || busy) return;
    setBusy(true);
    setErr(null);
    setStatus("Registering source…");
    try {
      const addRes = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p, watchIntervalMs: addInterval }),
      });
      if (!addRes.ok) throw new Error((await addRes.text()) || "add failed");
      await ingestPath(p);
      setStatus("Done.");
      setPath("");
      await refresh();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  // Re-scan an already-registered source: only changed/new files are re-embedded.
  async function rescan(p: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await ingestPath(p);
      setStatus("Done — re-scanned (unchanged files skipped).");
      await refresh();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  // Change a source's auto re-scan cadence. Optimistic: refresh after.
  async function updateInterval(p: string, ms: number) {
    setErr(null);
    try {
      const r = await fetch("/api/sources", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p, watchIntervalMs: ms }),
      });
      if (!r.ok) throw new Error((await r.text()) || "update failed");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(p: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/sources", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
      if (!r.ok) throw new Error((await r.text()) || "remove failed");
      await refresh();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Sources" onClose={onClose} maxWidth="max-w-xl">
      <p className="text-xs text-muted mb-3 leading-relaxed">
        Mnemos is read-only over what you register here. Add a <strong>folder</strong>{" "}
        (all its files) or a <strong>single file</strong> — it&apos;s chunked, embedded,
        and made searchable for grounded, cited answers. Paste an absolute path; Mnemos
        detects whether it&apos;s a file or a folder.
      </p>

      <div className="flex gap-2 mb-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addAndIngest();
          }}
          placeholder="/absolute/path/to/folder-or-file.pdf"
          disabled={busy}
          className="flex-1 bg-surface border border-line rounded-md px-3 py-2 text-sm text-fg font-mono focus:outline-none focus:border-cyan-500 disabled:opacity-50"
        />
        <button
          onClick={() => void addAndIngest()}
          disabled={busy || !path.trim()}
          className="rounded-md bg-cyan-500 px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {busy ? "Working…" : "Add & ingest"}
        </button>
      </div>

      <label className="flex items-center gap-2 mb-2 text-[11px] text-muted">
        <span>Auto re-scan:</span>
        <select
          value={addInterval}
          onChange={(e) => setAddInterval(Number(e.target.value))}
          disabled={busy}
          className="bg-surface border border-line rounded px-1.5 py-1 text-fg focus:outline-none focus:border-cyan-500 disabled:opacity-50"
        >
          {INTERVAL_OPTIONS.map((o) => (
            <option key={o.ms} value={o.ms}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-muted/70">
          incremental — only changed files re-embed
        </span>
      </label>
      {status && <p className="text-xs text-cyan-300 mb-2">{status}</p>}
      {err && <p className="text-xs text-red-400 mb-2">{err}</p>}

      <div className="mt-3 border-t border-line pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wider text-muted">
            Registered ({sources.length})
          </div>
          {anyRunning && (
            <button
              onClick={() => void pauseAll()}
              className="text-[11px] text-amber-400 hover:text-amber-300 transition"
              title="Pause all running ingestions (resume any time)"
            >
              ⏸ Pause all
            </button>
          )}
        </div>
        {sources.length === 0 ? (
          <p className="text-xs text-muted">No sources yet.</p>
        ) : (
          <ul className="space-y-1">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-mono text-fg truncate" title={s.path}>
                    <span className="mr-1.5 opacity-70" aria-hidden>
                      {s.kind === "file" ? "▤" : "▦"}
                    </span>
                    {s.path}
                  </div>
                  <div className="text-[11px] text-muted">
                    {s.kind === "file" ? "file" : "folder"} · {s.chunkCount} chunks
                    {s.kind !== "file" && typeof s.fileCount === "number"
                      ? ` · ${s.fileCount} files`
                      : ""}
                    {(() => {
                      const next = nextScanText(s);
                      return s.watchIntervalMs === 0
                        ? " · auto: off"
                        : ` · auto: ${intervalLabel(s.watchIntervalMs)}${next ? ` (${next})` : ""}`;
                    })()}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {ingest[s.id]?.state === "running" && (
                    <span className="text-[11px] text-cyan-300 tabular-nums">
                      {ingest[s.id]?.filesDone ?? 0}/{ingest[s.id]?.filesTotal || "?"}
                    </span>
                  )}
                  <select
                    value={s.watchIntervalMs ?? DAY}
                    onChange={(e) => void updateInterval(s.path, Number(e.target.value))}
                    disabled={busy}
                    title="Auto re-scan cadence"
                    className="bg-surface border border-line rounded px-1 py-1 text-[11px] text-muted focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                  >
                    {INTERVAL_OPTIONS.map((o) => (
                      <option key={o.ms} value={o.ms}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {ingest[s.id]?.state === "running" ? (
                    <button
                      onClick={() => void pauseSource(s.id)}
                      className="text-[11px] text-amber-400 hover:text-amber-300 transition"
                      title="Pause this ingestion (resume any time)"
                    >
                      ⏸ Pause
                    </button>
                  ) : ingest[s.id]?.state === "paused" ? (
                    <button
                      onClick={() => void resumeSource(s.id)}
                      className="text-[11px] text-cyan-400 hover:text-cyan-300 transition"
                      title="Resume — continues where it left off (skips finished files)"
                    >
                      ▶ Resume
                    </button>
                  ) : (
                    <button
                      onClick={() => void rescan(s.path)}
                      disabled={busy}
                      className="text-[11px] text-cyan-400 hover:text-cyan-300 transition disabled:opacity-50"
                      title="Re-ingest now — only changed/new files are re-embedded"
                    >
                      ↻ Re-scan
                    </button>
                  )}
                  <button
                    onClick={() => void remove(s.path)}
                    disabled={busy || ingest[s.id]?.state === "running"}
                    className="text-[11px] text-muted hover:text-red-400 transition disabled:opacity-50"
                    title="Remove source and purge its chunks"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
