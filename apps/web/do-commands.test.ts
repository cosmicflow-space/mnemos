import { describe, it, expect, vi, beforeEach } from "vitest";

// The gate reads PIN state and the selection buffer; stub those so the decision
// logic is tested in isolation (no real ~/.mnemos/.pin.json or DB needed).
vi.mock("./lib/do-pin", () => ({
  pinExists: vi.fn(),
  lockedMs: vi.fn(),
  windowValid: vi.fn(),
}));
vi.mock("./lib/do-state", () => ({
  getBuffer: vi.fn(),
}));
vi.mock("./lib/do-runner", () => ({
  parseSelection: vi.fn(),
}));

import { ragGate, resolveRag, RAG_BULK_THRESHOLD } from "./lib/do-commands";
import { pinExists, lockedMs, windowValid } from "./lib/do-pin";
import { getBuffer } from "./lib/do-state";
import { parseSelection } from "./lib/do-runner";

const mPinExists = vi.mocked(pinExists);
const mLockedMs = vi.mocked(lockedMs);
const mWindowValid = vi.mocked(windowValid);
const mGetBuffer = vi.mocked(getBuffer);
const mParseSelection = vi.mocked(parseSelection);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ragGate — the write-gate decision (shared by web + Telegram)", () => {
  const paths = ["/home/u/a.pdf"];

  it("requires bootstrap when no PIN is set", () => {
    mPinExists.mockReturnValue(false);
    expect(ragGate(paths)).toEqual({ kind: "setup" });
  });

  it("reports a lockout while cooling off", () => {
    mPinExists.mockReturnValue(true);
    mLockedMs.mockReturnValue(60_000);
    expect(ragGate(paths)).toEqual({ kind: "locked", ms: 60_000 });
  });

  it("proceeds without a PIN inside an open cadence window (small add)", () => {
    mPinExists.mockReturnValue(true);
    mLockedMs.mockReturnValue(0);
    mWindowValid.mockReturnValue(true);
    expect(ragGate(paths)).toEqual({ kind: "ready", anomaly: false });
  });

  it("requires a PIN when the window has lapsed", () => {
    mPinExists.mockReturnValue(true);
    mLockedMs.mockReturnValue(0);
    mWindowValid.mockReturnValue(false);
    expect(ragGate(paths)).toEqual({ kind: "pin", anomaly: false, count: 1 });
  });

  it("forces a PIN on a bulk add even inside an open window (anomaly)", () => {
    mPinExists.mockReturnValue(true);
    mLockedMs.mockReturnValue(0);
    mWindowValid.mockReturnValue(true);
    const bulk = Array.from({ length: RAG_BULK_THRESHOLD + 1 }, (_, i) => `/home/u/${i}.txt`);
    expect(ragGate(bulk)).toEqual({ kind: "pin", anomaly: true, count: bulk.length });
  });
});

describe("resolveRag — selection → concrete paths", () => {
  it("reports an empty buffer", () => {
    mGetBuffer.mockReturnValue(null);
    expect(resolveRag("sess:x", "1")).toEqual({ kind: "empty" });
  });

  it("passes through a malformed-selection error", () => {
    mGetBuffer.mockReturnValue({ verb: "fs", items: ["/a", "/b"] });
    mParseSelection.mockReturnValue({ error: "out of range" });
    expect(resolveRag("sess:x", "9")).toEqual({ kind: "error", message: "out of range" });
  });

  it("maps 1-based indices to the buffered paths", () => {
    mGetBuffer.mockReturnValue({ verb: "fs", items: ["/a", "/b", "/c"] });
    mParseSelection.mockReturnValue({ indices: [1, 3] });
    expect(resolveRag("sess:x", "1 3")).toEqual({ kind: "paths", paths: ["/a", "/c"] });
  });

  it("reports a valid-but-empty selection", () => {
    mGetBuffer.mockReturnValue({ verb: "fs", items: ["/a"] });
    mParseSelection.mockReturnValue({ indices: [] });
    expect(resolveRag("sess:x", "none")).toEqual({ kind: "none" });
  });
});
