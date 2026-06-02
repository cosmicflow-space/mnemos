/**
 * Prefix-based query routing — the "smart routing" sigils.
 *
 * Two orthogonal axes encoded as leading sigils:
 *   - `!`  family = SKIP retrieval (ask the model directly, not your files)
 *   - `+`  family = USE retrieval (RAG over your files) but with a frontier brain
 *   - repeats      = escalate the model tier (cheap → flagship)
 *
 *   (no prefix)  RAG  · local model        ← default, fully local
 *   !            direct · local model
 *   !!           direct · frontier cheapest
 *   !!!          direct · frontier flagship
 *   +            RAG    · frontier cheapest
 *   ++           RAG    · frontier flagship
 *
 * All triggers are inert in Telegram (unlike `/`, `#`, `@`), so the exact same
 * syntax works in the web chat and the bot. This module is pure string logic
 * with no Node/React deps, so the client (optimistic UI), the API route, and
 * the Telegram poller all share one source of truth for parsing.
 */

export type RouteTier = "local" | "frontier-cheap" | "frontier-flagship";

export type QueryRoute = {
  /** True → skip retrieval entirely (the `!` family). */
  direct: boolean;
  /** Which model tier to route to. */
  tier: RouteTier;
  /** The question with the routing sigil stripped. */
  q: string;
  /** The matched sigil ("" when none) — handy for labels/telemetry. */
  sigil: string;
};

// Longest sigil first so `!!!` wins over `!!` wins over `!` (and `++` over `+`).
const PREFIXES: ReadonlyArray<{ sigil: string; direct: boolean; tier: RouteTier }> = [
  { sigil: "!!!", direct: true, tier: "frontier-flagship" },
  { sigil: "!!", direct: true, tier: "frontier-cheap" },
  { sigil: "!", direct: true, tier: "local" },
  { sigil: "++", direct: false, tier: "frontier-flagship" },
  { sigil: "+", direct: false, tier: "frontier-cheap" },
];

/** Parse a raw user message into its routing decision + the cleaned question. */
export function parseQueryRoute(input: string): QueryRoute {
  const raw = input.trim();
  for (const { sigil, direct, tier } of PREFIXES) {
    if (raw.startsWith(sigil)) {
      return { direct, tier, q: raw.slice(sigil.length).trim(), sigil };
    }
  }
  return { direct: false, tier: "local", q: raw, sigil: "" };
}

/** True when the tier requires a frontier (key-needing) provider. */
export function isFrontierTier(tier: RouteTier): boolean {
  return tier === "frontier-cheap" || tier === "frontier-flagship";
}
