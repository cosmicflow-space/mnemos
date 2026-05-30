import { describe, it, expect } from "vitest";
import {
  registerIngestController,
  unregisterIngestController,
  isIngesting,
  pauseIngest,
  pauseAllIngest,
} from "./lib/ingest-control";

describe("ingest-control", () => {
  it("registers, reports, and aborts a controller", () => {
    const c = new AbortController();
    registerIngestController(101, c);
    expect(isIngesting(101)).toBe(true);
    expect(c.signal.aborted).toBe(false);

    expect(pauseIngest(101)).toBe(true); // a run was in flight
    expect(c.signal.aborted).toBe(true);

    unregisterIngestController(101);
    expect(isIngesting(101)).toBe(false);
    expect(pauseIngest(101)).toBe(false); // nothing to pause
  });

  it("pauseAll aborts every registered controller", () => {
    const a = new AbortController();
    const b = new AbortController();
    registerIngestController(201, a);
    registerIngestController(202, b);
    try {
      const n = pauseAllIngest();
      expect(n).toBeGreaterThanOrEqual(2);
      expect(a.signal.aborted).toBe(true);
      expect(b.signal.aborted).toBe(true);
    } finally {
      unregisterIngestController(201);
      unregisterIngestController(202);
    }
  });
});
