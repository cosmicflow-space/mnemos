/**
 * Phase 0 has no executable behavior to unit-test — its deliverable is the two
 * design docs. So the "test" for this phase is a consistency check on those
 * docs, runnable in `pnpm validate`, that keeps them coherent as later phases
 * edit them: every interaction mode stays covered, the prefix grammar is
 * preserved, and the exec model's consequence tiers stay documented.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ARCHITECTURE = readFileSync(join(here, "ARCHITECTURE.md"), "utf8");
const SECURITY = readFileSync(join(here, "SECURITY-POSTURE.md"), "utf8");

describe("agent design docs — Phase 0 consistency", () => {
  it("cover all four interaction modes in the architecture", () => {
    for (const token of ["Direct", "RAG", "/agent", "/run"]) {
      expect(ARCHITECTURE).toContain(token);
    }
  });

  it("govern the exec-capable modes in the security posture", () => {
    // The posture is about command execution, so it governs the two modes that
    // can run commands (and notes RAG content as an untrusted input).
    for (const token of ["/agent", "/run", "RAG"]) {
      expect(SECURITY).toContain(token);
    }
  });

  it("preserve the existing prefix grammar in the architecture", () => {
    for (const prefix of ["!", "!!", "!!!", "+", "++"]) {
      expect(ARCHITECTURE).toContain(prefix);
    }
  });

  it("document every consequence tier of the exec model", () => {
    for (const tier of ["`read`", "`write`", "`escalate`"]) {
      expect(SECURITY).toContain(tier);
    }
    // The defining stance: classify by consequence + argv-only execution.
    expect(SECURITY).toContain("argv");
    expect(SECURITY.toLowerCase()).toContain("never a shell");
  });
});
