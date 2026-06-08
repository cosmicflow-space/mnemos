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

export type InputCommand = {
  cmd: string;
  /** Full sentence for /tips and /help. */
  desc: string;
  /** Compact label for the glanceable web input legend. */
  short: string;
};

/** Slash commands — the working-set + focus workflow, identical on web and the
 * Telegram bot. One source of truth so the legend, /tips, and /help never drift. */
export const INPUT_COMMANDS: readonly InputCommand[] = [
  { cmd: "/do", desc: "List your Mnemos aliases (vetted helper scripts).", short: "list aliases" },
  { cmd: "/do fs <name>", desc: "Find files on disk by (fuzzy) name — type part of it, any order.", short: "find files" },
  { cmd: "/do rag <n>", desc: "Add files you found to the index (1 · 1-3 · all). Guarded by your PIN.", short: "add to index" },
  { cmd: "/focus <name>", desc: "Scope the chat to one indexed file by name (or /focus <n> for a numbered source).", short: "focus a file" },
  { cmd: "/done", desc: "Leave focus — back to searching all your files.", short: "exit focus" },
  { cmd: "/reindex", desc: "Re-extract the focused file (scanned PDFs run OCR).", short: "re-extract" },
];

const FRONTIER_NOTE =
  "Frontier prefixes (!!, !!!, +, ++) use a configured API-key provider; Mnemos asks you to add a key if none is set.";

const COMMANDS_NOTE = "Also: /tips (these shortcuts) · /cost (frontier spend to date) · /new (fresh thread).";

/** Plain text for Telegram (no parse_mode, so it can't break rendering). */
export function formatTipsText(): string {
  const lines = INPUT_TIPS.map((t) => `${t.syntax}  —  ${t.desc}`);
  const cmds = INPUT_COMMANDS.map((c) => `${c.cmd}  —  ${c.desc}`);
  return (
    `💡 Input shortcuts — prefix your message:\n\n${lines.join("\n")}\n\n${FRONTIER_NOTE}\n\n` +
    `📂 Find & focus your files:\n\n${cmds.join("\n")}\n\n${COMMANDS_NOTE}`
  );
}

/** Markdown for the web chat — rendered in an assistant bubble by /tips. */
export function formatTipsMarkdown(): string {
  const rows = INPUT_TIPS.map((t) => `| \`${t.syntax}\` | ${t.desc} |`).join("\n");
  const cmdRows = INPUT_COMMANDS.map((c) => `| \`${c.cmd}\` | ${c.desc} |`).join("\n");
  return (
    `**💡 Input shortcuts** — prefix your message to route it:\n\n| Prefix | What it does |\n|---|---|\n${rows}\n\n${FRONTIER_NOTE}\n\n` +
    `**📂 Find & focus your files** — the same commands work on the Telegram bot:\n\n| Command | What it does |\n|---|---|\n${cmdRows}\n\n${COMMANDS_NOTE}`
  );
}
