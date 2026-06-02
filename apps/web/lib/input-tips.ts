/**
 * Single source of truth for input-syntax help ("/tips").
 *
 * Shown via `/tips` (and `/help`) on both the Telegram bot and the web chat,
 * and mirrored by the web input legend. As the input language grows (more
 * routing prefixes, future shortcuts), add a row here — every surface updates.
 * Pure data + formatters, no Node/React deps, so client and server share it.
 */

export type InputTip = {
  syntax: string;
  /** Full sentence for /tips and /help. */
  desc: string;
  /** Compact label for the glanceable web input legend. */
  short: string;
};

export const INPUT_TIPS: readonly InputTip[] = [
  { syntax: "(no prefix)", desc: "Search your files, answered by your local model (default).", short: "your files (local)" },
  { syntax: "!", desc: "Ask the model directly — skip your files.", short: "ask the model" },
  { syntax: "!!", desc: "Ask a frontier model directly (needs an API key).", short: "frontier" },
  { syntax: "!!!", desc: "Ask the top frontier model — best reasoning, higher cost.", short: "top frontier" },
  { syntax: "+", desc: "Search your files, answered by a frontier model.", short: "files + frontier" },
  { syntax: "++", desc: "Search your files, answered by the top frontier model.", short: "files + top frontier" },
];

/** Color hint for the legend chip, derived from the sigil (no per-row metadata
 * needed): `!` family = direct (amber), `+` family = frontier-RAG (sky). */
export function tipColor(syntax: string): "amber" | "sky" | "muted" {
  if (syntax.startsWith("!")) return "amber";
  if (syntax.startsWith("+")) return "sky";
  return "muted";
}

const FRONTIER_NOTE =
  "Frontier prefixes (!!, !!!, +, ++) use a configured API-key provider; Mnemos asks you to add a key if none is set.";

const COMMANDS_NOTE = "Commands: /tips (these shortcuts) · /cost (frontier spend to date).";

/** Plain text for Telegram (no parse_mode, so it can't break rendering). */
export function formatTipsText(): string {
  const lines = INPUT_TIPS.map((t) => `${t.syntax}  —  ${t.desc}`);
  return `💡 Input shortcuts — prefix your message:\n\n${lines.join("\n")}\n\n${FRONTIER_NOTE}\n\n${COMMANDS_NOTE}`;
}

/** Markdown for the web chat — rendered in an assistant bubble by /tips. */
export function formatTipsMarkdown(): string {
  const rows = INPUT_TIPS.map((t) => `| \`${t.syntax}\` | ${t.desc} |`).join("\n");
  return `**💡 Input shortcuts** — prefix your message to route it:\n\n| Prefix | What it does |\n|---|---|\n${rows}\n\n${FRONTIER_NOTE}\n\n**Commands:** \`/tips\` (these shortcuts) · \`/cost\` (frontier spend to date).`;
}
