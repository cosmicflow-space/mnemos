"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

type SourceRow = {
  id: number;
  path: string;
  kind: string;
  scope: string;
  chunkCount: number;
  createdAt: number;
  fileCount?: number;
  lastIngestedAt?: number | null;
};

type ExclusionReason = "secret" | "log" | "lockfile" | "minified" | "transient" | "hidden";
type IncludeReason = Exclude<ExclusionReason, "secret">;

type ExclusionSummary = {
  byReason: Partial<Record<ExclusionReason, number>>;
  byLabel: Record<string, number>;
  totalCount: number;
};

type LargeFilesSummary = {
  count: number;
  totalBytes: number;
};

const INCLUDE_REASON_LABELS: Record<IncludeReason, string> = {
  log: "log files",
  lockfile: "lockfiles",
  minified: "minified / source maps",
  transient: "temp / cache / backup files",
  hidden: "hidden dotfiles (.bashrc, .zshrc, etc.)",
};

function formatRelative(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

type ScanSummary = {
  totalFiles: number;
  totalBytes: number;
  byLabel: Record<string, number>;
  byCategory: { supported: number; deferred: number; unsupported: number };
  deferredNotes: Array<{ label: string; count: number; note: string }>;
};

type ScanResponse = {
  rootPath: string;
  summary: ScanSummary;
  skippedDirs: string[];
  previewFiles: Array<{
    relativePath: string;
    sizeBytes: number;
    category: string;
    label: string;
  }>;
  hasMoreFiles: boolean;
  defaultExcluded: ExclusionSummary;
  securityExcluded: ExclusionSummary;
  largeFiles: LargeFilesSummary;
};

type ProgressEvent =
  | { phase: "scan-start"; rootPath: string }
  | { phase: "scan-complete"; totalFiles: number; supportedFiles: number }
  | { phase: "file-start"; filePath: string; current: number; total: number }
  | { phase: "file-skipped"; filePath: string; reason: string; current: number; total: number }
  | { phase: "file-chunked"; filePath: string; chunkCount: number; current: number; total: number }
  | { phase: "file-embedded"; filePath: string; chunkCount: number; current: number; total: number }
  | { phase: "file-complete"; filePath: string; chunkCount: number; current: number; total: number }
  | { phase: "done"; filesProcessed: number; chunksCreated: number; filesSkipped: number; durationMs: number }
  | { phase: "error"; message: string };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const COMMON_PATHS = ["~/Documents", "~/Downloads", "~/Desktop", "~/Notes"];

type AgentStatus = {
  provider: string | null;
  hasCredential: boolean;
  embedding: string;
  ready: boolean;
  reason: string | null;
};

export default function SourcesPage() {
  const [path, setPath] = useState("");
  const [scanResult, setScanResult] = useState<ScanResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [ingesting, setIngesting] = useState(false);
  const [ingestingPath, setIngestingPath] = useState<string | null>(null);
  const [currentProgress, setCurrentProgress] = useState<ProgressEvent | null>(null);
  const [doneEvent, setDoneEvent] = useState<ProgressEvent | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  // Per-ingest filters (ephemeral, not persisted to source yet).
  const [excludedLabels, setExcludedLabels] = useState<Set<string>>(new Set());
  const [includeOverrides, setIncludeOverrides] = useState<Record<IncludeReason, boolean>>({
    log: false,
    lockfile: false,
    minified: false,
    transient: false,
    hidden: false,
  });
  const [includeLargeFiles, setIncludeLargeFiles] = useState<boolean>(true);

  const refreshSources = useCallback(async () => {
    try {
      const res = await fetch("/api/sources");
      if (!res.ok) return;
      const data = (await res.json()) as { sources: SourceRow[] };
      setSources(data.sources);
    } catch {
      // silent — leave existing list
    }
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  useEffect(() => {
    let cancelled = false;
    const loadAgent = async () => {
      try {
        const r = await fetch("/api/config", { cache: "no-store" });
        if (!r.ok) return;
        const s = (await r.json()) as AgentStatus;
        if (!cancelled) setAgentStatus(s);
      } catch {
        // banner in layout already surfaces the failure
      }
    };
    void loadAgent();
    const onFocus = () => void loadAgent();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim()) return;
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    setDoneEvent(null);
    try {
      const res = await fetch("/api/sources/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path.trim() }),
      });
      const data = (await res.json()) as ScanResponse | { error: string; message?: string };
      if (!res.ok || "error" in data) {
        setScanError("message" in data ? data.message ?? data.error : "Scan failed");
      } else {
        setScanResult(data);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  async function streamIngestion(absolutePath: string) {
    const filters = {
      excludeLabels: [...excludedLabels],
      includeOverrides,
      includeLargeFiles,
    };
    const res = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: absolutePath, filters }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new Error(text);
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
        try {
          const event = JSON.parse(line.slice(6)) as ProgressEvent;
          setCurrentProgress(event);
          if (event.phase === "done") setDoneEvent(event);
        } catch {
          // ignore parse errors on partial events
        }
      }
    }
  }

  async function handleAddAndIngest() {
    if (!scanResult) return;
    setIngesting(true);
    setIngestingPath(scanResult.rootPath);
    setDoneEvent(null);

    // 1. Register source (idempotent)
    try {
      const addRes = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: scanResult.rootPath, kind: "folder" }),
      });
      if (!addRes.ok) {
        const err = (await addRes.json()) as { message?: string; error: string };
        throw new Error(err.message ?? err.error);
      }
    } catch (err) {
      setCurrentProgress({
        phase: "error",
        message: `Failed to register: ${err instanceof Error ? err.message : String(err)}`,
      });
      setIngesting(false);
      setIngestingPath(null);
      return;
    }

    // 2. Stream ingestion
    try {
      await streamIngestion(scanResult.rootPath);
      await refreshSources();
    } catch (err) {
      setCurrentProgress({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIngesting(false);
      setIngestingPath(null);
    }
  }

  /** Ingest (or re-ingest) an already-registered source. */
  async function handleIngestExisting(rowPath: string) {
    setIngesting(true);
    setIngestingPath(rowPath);
    setDoneEvent(null);
    setCurrentProgress(null);
    try {
      await streamIngestion(rowPath);
      await refreshSources();
    } catch (err) {
      setCurrentProgress({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIngesting(false);
      setIngestingPath(null);
    }
  }

  async function handleRemove(rowPath: string) {
    if (!confirm(`Unregister ${rowPath} and purge all its chunks?`)) return;
    try {
      await fetch("/api/sources", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: rowPath }),
      });
      await refreshSources();
    } catch {
      // silent
    }
  }

  return (
    <main className="min-h-screen px-6 py-12 max-w-5xl mx-auto">
      <header className="mb-10 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 text-cyan-300 hover:text-cyan-200 transition">
          <span className="text-2xl">←</span>
          <span className="text-lg">mnemos</span>
        </Link>
        <h1 className="text-2xl font-semibold text-gray-100">Sources</h1>
      </header>

      {/* Registered sources */}
      <section className="mb-12">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm uppercase tracking-wider text-gray-400">
            Registered ({sources.length})
          </h2>
          <p className="text-xs text-gray-500">
            Ingestion uses local embeddings (no API key needed). Chat requires an agent — see <Link href="/agent" className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">/agent</Link>.
          </p>
        </div>
        {sources.length === 0 ? (
          <p className="text-gray-500 text-sm">No sources registered yet. Add one below.</p>
        ) : (
          <ul className="space-y-2">
            {sources.map((s) => {
              const isThisRowIngesting = ingestingPath === s.path;
              const needsFirstIngest = s.chunkCount === 0;
              return (
                <li key={s.id} className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm text-gray-100 truncate">{s.path}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {s.kind} · {s.scope} · {s.chunkCount.toLocaleString()} chunks
                        {s.fileCount !== undefined && s.fileCount > 0 && (
                          <span> · {s.fileCount.toLocaleString()} files</span>
                        )}
                        {needsFirstIngest ? (
                          <span className="ml-2 text-amber-300">— not ingested yet</span>
                        ) : (
                          <span className="ml-2 text-gray-500">— last ingested {formatRelative(s.lastIngestedAt)}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => void handleIngestExisting(s.path)}
                        disabled={ingesting}
                        className={`rounded-md px-3 py-1 text-xs font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${
                          needsFirstIngest
                            ? "bg-amber-500 text-gray-900 hover:bg-amber-400"
                            : "border border-cyan-700 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
                        }`}
                      >
                        {isThisRowIngesting ? "Ingesting…" : needsFirstIngest ? "Ingest" : "Re-ingest"}
                      </button>
                      <button
                        onClick={() => handleRemove(s.path)}
                        disabled={ingesting}
                        className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {isThisRowIngesting && currentProgress && (
                    <div className="mt-3 border-t border-gray-800 pt-3">
                      <ProgressDisplay current={currentProgress} done={doneEvent} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Add new source */}
      <section className="mb-12">
        <h2 className="text-sm uppercase tracking-wider text-gray-400 mb-3">
          Add a source
        </h2>
        <form onSubmit={handleScan} className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/Documents/notes"
              disabled={scanning || ingesting}
              className="flex-1 rounded-md bg-gray-900 border border-gray-700 px-4 py-2.5 text-gray-100 font-mono text-sm focus:outline-none focus:border-cyan-500 transition disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={scanning || ingesting || !path.trim()}
              className="rounded-md bg-cyan-500 px-5 py-2.5 text-sm font-medium text-gray-900 hover:bg-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {scanning ? "Scanning…" : "Scan"}
            </button>
          </div>
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs text-gray-500 self-center mr-1">Suggestions:</span>
            {COMMON_PATHS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPath(p)}
                disabled={scanning || ingesting}
                className="text-xs font-mono text-gray-400 hover:text-cyan-300 transition disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
        </form>
        {scanError && (
          <p className="mt-3 text-sm text-red-400">{scanError}</p>
        )}
      </section>

      {/* Scan result */}
      {scanResult && (
        <section className="mb-12 rounded-lg border border-gray-800 bg-gray-900/40 p-6">
          <h2 className="text-sm uppercase tracking-wider text-gray-400 mb-3">
            Scan result
          </h2>
          <div className="mb-4">
            <div className="font-mono text-sm text-cyan-300">{scanResult.rootPath}</div>
            <div className="text-xs text-gray-400 mt-1">
              {scanResult.summary.totalFiles.toLocaleString()} files · {formatBytes(scanResult.summary.totalBytes)} total
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="rounded bg-gray-950/50 p-3 border border-cyan-900/50">
              <div className="text-xs uppercase text-cyan-400 mb-1">Will ingest</div>
              <div className="text-2xl font-semibold text-gray-100">{scanResult.summary.byCategory.supported}</div>
            </div>
            <div className="rounded bg-gray-950/50 p-3 border border-amber-900/50">
              <div className="text-xs uppercase text-amber-400 mb-1">Deferred</div>
              <div className="text-2xl font-semibold text-gray-100">{scanResult.summary.byCategory.deferred}</div>
            </div>
            <div className="rounded bg-gray-950/50 p-3 border border-gray-800">
              <div className="text-xs uppercase text-gray-500 mb-1">Skipped</div>
              <div className="text-2xl font-semibold text-gray-400">{scanResult.summary.byCategory.unsupported}</div>
            </div>
          </div>

          <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">By type — uncheck to skip</h3>
          <ul className="text-sm text-gray-300 space-y-1 mb-4">
            {Object.entries(scanResult.summary.byLabel)
              .filter(([label]) => {
                // Only show supported labels here; deferred/unsupported are split out below
                const supportedLabels = new Set(
                  scanResult.previewFiles
                    .filter((f) => f.category === "supported")
                    .map((f) => f.label),
                );
                return supportedLabels.has(label) || scanResult.previewFiles.length === 0;
              })
              .map(([label, count]) => {
                const checked = !excludedLabels.has(label);
                return (
                  <li key={label} className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-900/50">
                    <label className="flex items-center gap-2 cursor-pointer flex-1">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setExcludedLabels((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(label);
                            else next.add(label);
                            return next;
                          });
                        }}
                        className="accent-cyan-500"
                      />
                      <span className={checked ? "" : "text-gray-500 line-through"}>{label}</span>
                    </label>
                    <span className={`font-mono text-xs ${checked ? "text-gray-400" : "text-gray-600"}`}>{count}</span>
                  </li>
                );
              })}
          </ul>

          {scanResult.defaultExcluded.totalCount > 0 && (
            <div className="mb-4 rounded-md border border-gray-800 bg-gray-950/50 p-3">
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">
                Hidden by defaults — {scanResult.defaultExcluded.totalCount} files
              </div>
              <p className="text-xs text-gray-500 mb-2">
                Mnemos auto-skips noise that hurts RAG quality. Toggle a tier on if you really want it indexed.
              </p>
              <ul className="space-y-1.5">
                {(Object.keys(INCLUDE_REASON_LABELS) as IncludeReason[]).map((reason) => {
                  const count = scanResult.defaultExcluded.byReason[reason] ?? 0;
                  if (count === 0) return null;
                  return (
                    <li key={reason} className="flex items-center justify-between text-xs">
                      <label className="flex items-center gap-2 cursor-pointer flex-1">
                        <input
                          type="checkbox"
                          checked={includeOverrides[reason]}
                          onChange={(e) =>
                            setIncludeOverrides((prev) => ({ ...prev, [reason]: e.target.checked }))
                          }
                          className="accent-cyan-500"
                        />
                        <span className="text-gray-400">Include {INCLUDE_REASON_LABELS[reason]}</span>
                      </label>
                      <span className="font-mono text-gray-500">{count}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {scanResult.securityExcluded.totalCount > 0 && (
            <div className="mb-4 rounded-md border border-red-900/40 bg-red-950/20 p-3">
              <div className="text-xs uppercase tracking-wider text-red-300 mb-1">
                Security-blocked — {scanResult.securityExcluded.totalCount} file(s)
              </div>
              <p className="text-xs text-gray-400">
                Credential-like files (.env, keys, certs) — never ingested, even if explicitly requested.
                {" "}
                {Object.entries(scanResult.securityExcluded.byLabel).map(([label, n]) => `${n} ${label}`).join(", ")}.
              </p>
            </div>
          )}

          {scanResult.largeFiles.count > 0 && (
            <div className="mb-4 rounded-md border border-amber-900/40 bg-amber-950/20 p-3">
              <div className="flex items-center justify-between text-xs">
                <label className="flex items-center gap-2 cursor-pointer flex-1">
                  <input
                    type="checkbox"
                    checked={includeLargeFiles}
                    onChange={(e) => setIncludeLargeFiles(e.target.checked)}
                    className="accent-cyan-500"
                  />
                  <span className="text-amber-200">
                    Include {scanResult.largeFiles.count} file{scanResult.largeFiles.count === 1 ? "" : "s"} over 10 MB
                  </span>
                </label>
                <span className="font-mono text-amber-300/70">{formatBytes(scanResult.largeFiles.totalBytes)}</span>
              </div>
            </div>
          )}

          {scanResult.summary.deferredNotes.length > 0 && (
            <div className="text-xs text-amber-300/80 mb-4 space-y-1">
              {scanResult.summary.deferredNotes.map((n) => (
                <div key={n.label}>
                  {n.count} {n.label} — {n.note}
                </div>
              ))}
            </div>
          )}

          {scanResult.skippedDirs.length > 0 && (
            <details className="text-xs text-gray-500 mb-4">
              <summary className="cursor-pointer hover:text-gray-300">
                {scanResult.skippedDirs.length} dirs auto-skipped (node_modules, .git, etc.)
              </summary>
              <ul className="font-mono mt-2 space-y-0.5 pl-4">
                {scanResult.skippedDirs.slice(0, 20).map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </details>
          )}

          {(() => {
            const willIngest =
              scanResult.summary.byCategory.supported -
              [...excludedLabels].reduce(
                (sum, label) => sum + (scanResult.summary.byLabel[label] ?? 0),
                0,
              );
            return (
              <button
                onClick={handleAddAndIngest}
                disabled={ingesting || willIngest === 0}
                className="w-full rounded-md bg-amber-500 px-5 py-3 text-sm font-semibold text-gray-900 hover:bg-amber-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {ingesting ? "Ingesting…" : `Add to Mnemos · ${willIngest} file${willIngest === 1 ? "" : "s"}`}
              </button>
            );
          })()}
          {agentStatus && !agentStatus.ready && (
            <p className="text-xs text-gray-500 mt-2 text-center">
              Ingestion will run now (no LLM needed). Chat will be available once you{" "}
              <Link href="/agent" className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">configure an agent</Link>.
            </p>
          )}
        </section>
      )}

      {/* Ingestion progress */}
      {(ingesting || currentProgress) && (
        <section className="mb-12 rounded-lg border border-gray-800 bg-gray-900/40 p-6">
          <h2 className="text-sm uppercase tracking-wider text-gray-400 mb-3">
            Progress
          </h2>
          <ProgressDisplay current={currentProgress} done={doneEvent} />
        </section>
      )}
    </main>
  );
}

function ProgressDisplay({
  current,
  done,
}: {
  current: ProgressEvent | null;
  done: ProgressEvent | null;
}) {
  if (done && done.phase === "done") {
    return (
      <div className="space-y-2">
        <div className="text-cyan-300 font-medium">✓ Ingestion complete</div>
        <div className="text-sm text-gray-300 grid grid-cols-2 gap-2">
          <div>Files processed</div>
          <div className="text-right font-mono">{done.filesProcessed}</div>
          <div>Files skipped (unchanged)</div>
          <div className="text-right font-mono">{done.filesSkipped}</div>
          <div>Chunks created</div>
          <div className="text-right font-mono text-amber-300">{done.chunksCreated.toLocaleString()}</div>
          <div>Duration</div>
          <div className="text-right font-mono">{(done.durationMs / 1000).toFixed(1)}s</div>
        </div>
      </div>
    );
  }
  if (!current) {
    return <div className="text-sm text-gray-500">Waiting…</div>;
  }
  if (current.phase === "error") {
    return <div className="text-sm text-red-400">Error: {current.message}</div>;
  }
  if (current.phase === "scan-start") {
    return <div className="text-sm text-gray-300">Scanning {current.rootPath}…</div>;
  }
  if (current.phase === "scan-complete") {
    return (
      <div className="text-sm text-gray-300">
        Found {current.supportedFiles} supported files out of {current.totalFiles} total. Starting embed…
      </div>
    );
  }

  const pct = "current" in current && "total" in current && current.total > 0
    ? Math.round((current.current / current.total) * 100)
    : 0;
  const label = "filePath" in current ? current.filePath : "";

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{current.phase}</span>
        <span>
          {"current" in current ? `${current.current}/${current.total}` : ""} · {pct}%
        </span>
      </div>
      <div className="h-2 bg-gray-800 rounded overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-cyan-500 to-amber-500 transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-sm text-gray-300 font-mono truncate" title={label}>
        {label}
      </div>
      {"chunkCount" in current && (
        <div className="text-xs text-amber-300">
          {current.chunkCount.toLocaleString()} chunks
        </div>
      )}
    </div>
  );
}
