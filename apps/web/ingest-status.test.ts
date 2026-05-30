import { describe, it, expect, beforeEach } from "vitest";
import {
  applyIngestProgress,
  getIngestStatus,
  clearIngestStatus,
  markIngestPaused,
} from "./lib/ingest-status";

describe("ingest-status registry", () => {
  beforeEach(() => {
    clearIngestStatus(1);
    clearIngestStatus(2);
  });

  it("tracks a run from scan-start through done (idle = absent)", () => {
    applyIngestProgress(1, "/tmp/s", { phase: "scan-start" });
    expect(getIngestStatus().overall).toBe("running");

    applyIngestProgress(1, "/tmp/s", { phase: "scan-complete", supportedFiles: 5 });
    applyIngestProgress(1, "/tmp/s", { phase: "file-start", filePath: "a.txt", current: 1, total: 5 });
    const mid = getIngestStatus().sources.find((s) => s.sourceId === 1);
    expect(mid?.filesTotal).toBe(5);
    expect(mid?.filesDone).toBe(0); // current 1 means 0 done
    expect(mid?.currentPath).toBe("a.txt");

    applyIngestProgress(1, "/tmp/s", { phase: "file-complete", current: 1, total: 5 });
    expect(getIngestStatus().sources.find((s) => s.sourceId === 1)?.filesDone).toBe(1);

    applyIngestProgress(1, "/tmp/s", { phase: "done" });
    expect(getIngestStatus().sources.find((s) => s.sourceId === 1)).toBeUndefined();
  });

  it("records error state with message", () => {
    applyIngestProgress(2, "/tmp/e", { phase: "scan-start" });
    applyIngestProgress(2, "/tmp/e", { phase: "error", message: "boom" });
    const snap = getIngestStatus();
    const s = snap.sources.find((x) => x.sourceId === 2);
    expect(s?.state).toBe("error");
    expect(s?.error).toBe("boom");
    expect(snap.overall).toBe("error");
  });

  it("surfaces error in the rollup even while another source is running", () => {
    applyIngestProgress(1, "/tmp/s1", { phase: "scan-start" }); // running
    applyIngestProgress(2, "/tmp/s2", { phase: "scan-start" });
    applyIngestProgress(2, "/tmp/s2", { phase: "error", message: "x" });
    const snap = getIngestStatus();
    expect(snap.running).toBe(1);
    expect(snap.errored).toBe(1);
    expect(snap.overall).toBe("error"); // error outranks running
  });

  it("markIngestPaused flips a running source to paused, preserving progress", () => {
    applyIngestProgress(1, "/tmp/s", { phase: "scan-complete", supportedFiles: 4 });
    applyIngestProgress(1, "/tmp/s", { phase: "file-start", filePath: "a", current: 2, total: 4 });
    markIngestPaused(1);
    const s = getIngestStatus().sources.find((x) => x.sourceId === 1);
    expect(s?.state).toBe("paused");
    expect(s?.filesDone).toBe(1); // current 2 → 1 done, preserved across pause
    expect(getIngestStatus().overall).toBe("paused");
  });

  it("clearIngestStatus removes a source's status", () => {
    applyIngestProgress(1, "/tmp/s", { phase: "scan-start" });
    expect(getIngestStatus().sources.some((s) => s.sourceId === 1)).toBe(true);
    clearIngestStatus(1);
    expect(getIngestStatus().sources.some((s) => s.sourceId === 1)).toBe(false);
  });
});
