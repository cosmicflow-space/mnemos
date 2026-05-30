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

    unregisterIngestController(101, c);
    expect(isIngesting(101)).toBe(false);
    expect(pauseIngest(101)).toBe(false); // nothing to pause
  });

  it("instance-aware unregister won't evict a newer run's controller", () => {
    const oldC = new AbortController();
    const newC = new AbortController();
    registerIngestController(301, oldC);
    registerIngestController(301, newC); // a resume re-claimed the slot
    unregisterIngestController(301, oldC); // old run's cleanup must not touch newC
    expect(isIngesting(301)).toBe(true);
    unregisterIngestController(301, newC);
    expect(isIngesting(301)).toBe(false);
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
      unregisterIngestController(201, a);
      unregisterIngestController(202, b);
    }
  });
});
