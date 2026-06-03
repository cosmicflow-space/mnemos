import { describe, it, expect } from "vitest";
import {
  INPUT_TIPS,
  SLASH_COMMANDS,
  commandsForSurface,
  formatTipsText,
  formatTipsMarkdown,
  tipColor,
} from "./lib/input-tips";

describe("input tips", () => {
  it("has a row for the default and each routing prefix", () => {
    const syntaxes = INPUT_TIPS.map((t) => t.syntax);
    for (const s of ["(no prefix)", "!", "!!", "!!!", "+", "++"]) {
      expect(syntaxes).toContain(s);
    }
  });

  it("every tip carries a full desc and a compact short label (legend renders from short)", () => {
    for (const t of INPUT_TIPS) {
      expect(t.desc.length).toBeGreaterThan(0);
      expect(t.short.length).toBeGreaterThan(0);
    }
  });

  it("tipColor keys off the sigil family", () => {
    expect(tipColor("!")).toBe("amber");
    expect(tipColor("!!!")).toBe("amber");
    expect(tipColor("+")).toBe("sky");
    expect(tipColor("++")).toBe("sky");
    expect(tipColor("(no prefix)")).toBe("muted");
  });

  it("both formatters surface every tip (single source of truth)", () => {
    const text = formatTipsText();
    const md = formatTipsMarkdown();
    for (const t of INPUT_TIPS) {
      expect(text).toContain(t.syntax);
      expect(text).toContain(t.desc);
      expect(md).toContain(t.syntax);
      expect(md).toContain(t.desc);
    }
  });

  it("markdown renders a table; text stays plain (no pipes)", () => {
    expect(formatTipsMarkdown()).toContain("| Prefix | What it does |");
    expect(formatTipsText()).not.toContain("|");
  });

  it("registers the live commands and lists them on their surfaces", () => {
    const live = SLASH_COMMANDS.filter((c) => c.status === "live").map((c) => c.name);
    expect(live).toEqual(expect.arrayContaining(["/tips", "/cost"]));
    // Live commands appear in their surface's /tips.
    expect(formatTipsText()).toContain("/cost"); // telegram
    expect(formatTipsText()).toContain("/new"); // telegram-only
    expect(formatTipsMarkdown()).toContain("/cost"); // web
  });

  it("lists /agent live on Telegram (read-only) and a planned command on web", () => {
    // /agent is read-only, so it's live on Telegram now; the web sticky-session
    // UI lands later. A still-planned command (/run) shows as coming-soon on web.
    expect(formatTipsText()).toContain("/agent");
    expect(formatTipsMarkdown()).toContain("/run");
  });

  it("commandsForSurface splits live vs planned for a surface", () => {
    const web = commandsForSurface("web");
    expect(web.live.map((c) => c.name)).toContain("/tips");
    expect(web.planned.map((c) => c.name)).toContain("/run");
    // /agent is live on Telegram now; /run (exec) is not offered there yet.
    const tg = commandsForSurface("telegram");
    expect(tg.live.map((c) => c.name)).toContain("/agent");
    expect(tg.live.map((c) => c.name)).not.toContain("/run");
  });

  it("registry covers every command the web chat actually dispatches (no drift)", () => {
    // The web chat send() handles these slash commands today; each MUST be a
    // web-live registry entry or /tips silently omits a working command.
    const WEB_DISPATCHED = ["/tips", "/help", "/cost"];
    const webLive = new Set(commandsForSurface("web").live.map((c) => c.name));
    for (const name of WEB_DISPATCHED) {
      expect(webLive.has(name)).toBe(true);
    }
  });
});
