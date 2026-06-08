/**
 * Surface-agnostic `/do` orchestration shared by the Telegram poller and the
 * web chat. The security-relevant decisions — turning a selection into concrete
 * paths, and the PIN/anomaly write-gate — live here exactly ONCE, so the two
 * surfaces can never drift on what is allowed. Each surface keeps only its own
 * formatting (Telegram text vs. web JSON) and notification mechanism.
 */

import { parseSelection } from "./do-runner";
import { getBuffer } from "./do-state";
import { pinExists, lockedMs, windowValid } from "./do-pin";

/** Adding more files than this in one shot is an anomaly → force a PIN even
 * inside an open cadence window (defeats a prompt-injected mass-add). */
export const RAG_BULK_THRESHOLD = 10;

export type RagResolution =
  | { kind: "empty" } // nothing in the buffer yet — run a finder first
  | { kind: "error"; message: string } // malformed selection
  | { kind: "none" } // valid syntax, but it selected zero files
  | { kind: "paths"; paths: string[] };

/** Resolve a `/do rag <sel>` argument against the conversation's selection
 * buffer into concrete absolute paths (boundary re-checked later, at write). */
export function resolveRag(key: string, arg: string): RagResolution {
  const buf = getBuffer(key);
  if (!buf || buf.items.length === 0) return { kind: "empty" };
  const sel = parseSelection(arg, buf.items.length);
  if ("error" in sel) return { kind: "error", message: sel.error };
  if (sel.indices.length === 0) return { kind: "none" };
  const paths = sel.indices
    .map((i) => buf.items[i - 1])
    .filter((p): p is string => Boolean(p));
  return { kind: "paths", paths };
}

export type RagGate =
  | { kind: "setup" } // no PIN configured — bootstrap one first
  | { kind: "locked"; ms: number } // too many wrong PINs, cooling off
  | { kind: "ready"; anomaly: boolean } // inside the window, proceed now
  | { kind: "pin"; anomaly: boolean; count: number }; // a PIN is required

/** Decide whether an add of these paths may proceed now, needs a PIN, needs
 * bootstrap, or is locked out. The single source of truth for the write-gate. */
export function ragGate(paths: string[]): RagGate {
  if (!pinExists()) return { kind: "setup" };
  const locked = lockedMs();
  if (locked > 0) return { kind: "locked", ms: locked };
  const anomaly = paths.length > RAG_BULK_THRESHOLD;
  const ready = windowValid() && !anomaly;
  return ready ? { kind: "ready", anomaly } : { kind: "pin", anomaly, count: paths.length };
}
