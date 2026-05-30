"use client";

import { useCallback, useEffect, useState } from "react";

type Entry = { name: string; absPath: string; isDir: boolean };
type BrowseResponse = {
  path: string;
  parent: string | null;
  home: string;
  entries: Entry[];
  truncated: boolean;
};

/**
 * Server-powered file/folder picker panel. The browser can't hand JS an absolute
 * path, so this navigates the real filesystem via GET /api/browse (loopback-only)
 * and returns true absolute paths — every pick is guaranteed to exist. Rendered
 * inline inside the Sources modal (not a stacked dialog) so picking lands the
 * path back in the add form with the re-scan cadence still selectable.
 */
export function FolderPicker({
  initialPath,
  onPick,
  onCancel,
}: {
  initialPath?: string;
  onPick: (absPath: string) => void;
  onCancel: () => void;
}) {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p?: string) => {
    setLoading(true);
    setErr(null);
    try {
      const url = p ? `/api/browse?path=${encodeURIComponent(p)}` : "/api/browse";
      const r = await fetch(url, { cache: "no-store" });
      const d = (await r.json()) as Partial<BrowseResponse> & { message?: string };
      if (!r.ok) {
        setErr(d.message ?? "Could not open that folder.");
        return;
      }
      setData(d as BrowseResponse);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not reach the browse service.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath);
  }, [load, initialPath]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Choose a folder or file</h3>
        <button
          onClick={onCancel}
          className="text-[11px] text-muted hover:text-fg underline-offset-2 hover:underline"
        >
          Cancel
        </button>
      </div>

      {/* Current location + navigation */}
      <div className="mb-2 flex items-center gap-1.5">
        <button
          onClick={() => void load(data?.home)}
          title="Home"
          className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg hover:border-cyan-500 transition shrink-0"
        >
          ⌂
        </button>
        <button
          onClick={() => data?.parent && void load(data.parent)}
          disabled={!data?.parent}
          title="Up one level"
          className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg hover:border-cyan-500 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          ↑
        </button>
        <span className="flex-1 truncate rounded border border-line bg-surface px-2 py-1 text-[11px] text-muted font-mono" dir="rtl">
          {data?.path ?? "…"}
        </span>
      </div>

      {/* Entry list */}
      <div className="h-64 overflow-y-auto rounded-md border border-line bg-surface">
        {loading && <p className="p-3 text-xs text-muted">Loading…</p>}
        {err && !loading && <p className="p-3 text-xs text-red-400">{err}</p>}
        {!loading && !err && data && data.entries.length === 0 && (
          <p className="p-3 text-xs text-muted">This folder is empty (or only hidden items).</p>
        )}
        {!loading &&
          !err &&
          data?.entries.map((e) =>
            e.isDir ? (
              <button
                key={e.absPath}
                onClick={() => void load(e.absPath)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-elevated transition"
              >
                <span className="shrink-0">📁</span>
                <span className="flex-1 truncate">{e.name}</span>
                <span className="text-muted">›</span>
              </button>
            ) : (
              <button
                key={e.absPath}
                onClick={() => onPick(e.absPath)}
                title="Select this file"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted hover:bg-elevated hover:text-fg transition"
              >
                <span className="shrink-0">📄</span>
                <span className="flex-1 truncate">{e.name}</span>
              </button>
            ),
          )}
        {data?.truncated && (
          <p className="px-3 py-1.5 text-[11px] text-muted/70">Showing the first 1000 entries.</p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-line px-3 py-2 text-xs text-muted hover:text-fg transition"
        >
          Cancel
        </button>
        <button
          onClick={() => data && onPick(data.path)}
          disabled={!data}
          className="rounded-md bg-cyan-500 px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50"
        >
          Use this folder
        </button>
      </div>
    </div>
  );
}
