"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";

type SourceRow = {
  id: number;
  path: string;
  kind: string;
  chunkCount: number;
  fileCount?: number;
};

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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
        body: JSON.stringify({ path: p }),
      });
      if (!addRes.ok) throw new Error((await addRes.text()) || "add failed");

      setStatus("Ingesting… (reading, chunking, embedding)");
      const ingRes = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
      if (!ingRes.ok || !ingRes.body) throw new Error((await ingRes.text()) || "ingest failed");

      // Drain the SSE progress stream; surface the latest phase, stop on done/error.
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
        Mnemos is read-only over the folders you register here. Add a folder, and
        its files are chunked, embedded, and made searchable for grounded,
        cited answers.
      </p>

      <div className="flex gap-2 mb-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addAndIngest();
          }}
          placeholder="/absolute/path/to/folder"
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
      {status && <p className="text-xs text-cyan-300 mb-2">{status}</p>}
      {err && <p className="text-xs text-red-400 mb-2">{err}</p>}

      <div className="mt-3 border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wider text-muted mb-2">
          Registered ({sources.length})
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
                    {s.path}
                  </div>
                  <div className="text-[11px] text-muted">
                    {s.chunkCount} chunks
                    {typeof s.fileCount === "number" ? ` · ${s.fileCount} files` : ""}
                  </div>
                </div>
                <button
                  onClick={() => void remove(s.path)}
                  disabled={busy}
                  className="text-[11px] text-muted hover:text-red-400 transition shrink-0"
                  title="Remove source and purge its chunks"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
