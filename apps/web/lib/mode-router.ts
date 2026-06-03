/**
 * Mode router — the deterministic classifier that runs BEFORE any model call.
 *
 * Every input maps to exactly one of the four interaction modes (see
 * docs/agent/ARCHITECTURE.md §2). It is pure string logic with no model
 * involvement, so it cannot be steered into changing the trust level. The
 * prefix grammar (`!`/`+`) is delegated verbatim to `parseQueryRoute`, so
 * Direct/RAG behavior is preserved exactly — this router only adds the Agent and
 * Command modes (and the sticky-session handling) on top.
 *
 * Precedence (highest first):
 *   1. `/done` while in an Agent session → leave the session
 *   2. `/run …`                          → Command (one-shot)
 *   3. `!`/`!!`/`!!!` prefix             → Direct        (per-message, even mid-session)
 *   4. `+`/`++` prefix                    → RAG + frontier (per-message, even mid-session)
 *   5. `/agent …`                         → Agent (opens; continues if already in a session)
 *   6. in an Agent session                → Agent (continue the loop)
 *   7. otherwise                          → RAG (default)
 */

import { parseQueryRoute, type RouteTier } from "./query-routing";

export type ModeDecision =
  | { mode: "noop" }
  | { mode: "exit-agent" }
  | { mode: "command"; goal: string }
  | { mode: "agent"; goal: string; opened: boolean }
  | { mode: "direct"; tier: RouteTier; q: string }
  | { mode: "rag"; tier: RouteTier; q: string };

export type ModeRouterContext = {
  /** True when an Agent session is currently open (sticky mode). */
  inAgentSession?: boolean;
};

const RUN_RE = /^\/run(?:\s|$)/i;
const AGENT_RE = /^\/agent(?:\s|$)/i;

/** Classify a raw user input into exactly one mode. Pure; no side effects. */
export function classifyMode(input: string, ctx: ModeRouterContext = {}): ModeDecision {
  const raw = input.trim();
  const inSession = ctx.inAgentSession ?? false;
  if (!raw) return { mode: "noop" };

  // 1. `/done` leaves an open Agent session (no-op otherwise — falls through).
  if (inSession && raw.toLowerCase() === "/done") return { mode: "exit-agent" };

  // 2. `/run` — a one-shot command, highest non-exit precedence.
  if (RUN_RE.test(raw)) return { mode: "command", goal: raw.replace(RUN_RE, "").trim() };

  // 3–4. Prefix grammar — a per-message override that works even mid-session.
  const route = parseQueryRoute(raw);
  if (route.sigil.startsWith("!")) return { mode: "direct", tier: route.tier, q: route.q };
  if (route.sigil.startsWith("+")) return { mode: "rag", tier: route.tier, q: route.q };

  // 5. `/agent` opens a session (or continues one already open).
  if (AGENT_RE.test(raw)) {
    return { mode: "agent", goal: raw.replace(AGENT_RE, "").trim(), opened: !inSession };
  }

  // 6. Any plain input inside an open session continues the agent loop.
  if (inSession) return { mode: "agent", goal: raw, opened: false };

  // 7. Default — RAG over your files, local tier (route carries the cleaned q).
  return { mode: "rag", tier: route.tier, q: route.q };
}
