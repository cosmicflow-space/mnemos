/**
 * Single source of truth for input help ("/tips") — both the prefix grammar and
 * the slash-command registry.
 *
 * Shown via `/tips` (and `/help`) on the Telegram bot and the web chat, and
 * mirrored by the web input legend. As the input language grows — a new routing
 * prefix, or a new slash command — add ONE entry here and every surface updates,
 * filtered by where the command actually works. Pure data + formatters, no
 * Node/React deps, so client, API route, and Telegram poller share it.
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

export type Surface = "web" | "telegram";

export type SlashCommand = {
  name: string;
  summary: string;
  /** Where the command is dispatched. Drives which surface's /tips lists it. */
  surfaces: readonly Surface[];
  /** "live" = works today; "planned" = lands in a later phase (shown as soon as
   * it's real). Keeps /tips honest about what you can actually test right now. */
  status: "live" | "planned";
};

/**
 * The slash-command registry. Each new command is added here once; `/tips`,
 * `/help`, and the legend render from it. Flip `status` to "live" the moment a
 * command is wired so it becomes discoverable + testable on its surfaces.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/new", summary: "Start a fresh conversation.", surfaces: ["telegram"], status: "live" },
  { name: "/tips", summary: "Show these input shortcuts and commands.", surfaces: ["web", "telegram"], status: "live" },
  { name: "/help", summary: "Show help.", surfaces: ["web", "telegram"], status: "live" },
  { name: "/cost", summary: "Frontier spend to date.", surfaces: ["web", "telegram"], status: "live" },
  // Agentic commands — flip to "live" / gain surfaces as each phase lands them.
  // /agent is read-only (gather + answer), so it's safe on Telegram now; the web
  // sticky-session UI lands in a later slice (then "web" joins its surfaces).
  { name: "/agent", summary: "Give a goal; I gather from your files (read-only) and answer.", surfaces: ["telegram"], status: "live" },
  { name: "/run", summary: "Run one safe, confirmed local command.", surfaces: ["web"], status: "planned" },
  { name: "/done", summary: "Exit the current agent session.", surfaces: ["web"], status: "planned" },
];

/** Commands relevant to a surface, split into what works now vs. what's coming. */
export function commandsForSurface(surface: Surface): { live: SlashCommand[]; planned: SlashCommand[] } {
  const here = SLASH_COMMANDS.filter((c) => c.surfaces.includes(surface));
  return {
    live: here.filter((c) => c.status === "live"),
    planned: here.filter((c) => c.status === "planned"),
  };
}

const FRONTIER_NOTE =
  "Frontier prefixes (!!, !!!, +, ++) use a configured API-key provider; Mnemos asks you to add a key if none is set.";

/** Plain text for Telegram (no parse_mode, so it must never contain a pipe). */
export function formatTipsText(): string {
  const lines = INPUT_TIPS.map((t) => `${t.syntax}  —  ${t.desc}`);
  const { live, planned } = commandsForSurface("telegram");
  const cmdLines = live.map((c) => `${c.name} — ${c.summary}`);
  const soon = planned.length
    ? `\n\nComing soon: ${planned.map((c) => c.name).join(", ")}`
    : "";
  return (
    `💡 Input shortcuts — prefix your message:\n\n${lines.join("\n")}\n\n${FRONTIER_NOTE}` +
    `\n\nCommands:\n${cmdLines.join("\n")}${soon}`
  );
}

/** Markdown for the web chat — rendered in an assistant bubble by /tips. */
export function formatTipsMarkdown(): string {
  const rows = INPUT_TIPS.map((t) => `| \`${t.syntax}\` | ${t.desc} |`).join("\n");
  const { live, planned } = commandsForSurface("web");
  const cmdRows = live.map((c) => `- \`${c.name}\` — ${c.summary}`).join("\n");
  const soon = planned.length
    ? `\n\n_Coming soon:_ ${planned.map((c) => `\`${c.name}\``).join(", ")}`
    : "";
  return (
    `**💡 Input shortcuts** — prefix your message to route it:\n\n` +
    `| Prefix | What it does |\n|---|---|\n${rows}\n\n${FRONTIER_NOTE}\n\n` +
    `**Commands:**\n${cmdRows}${soon}`
  );
}
