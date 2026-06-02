import { describe, it, expect } from "vitest";
import { parseQueryRoute, isFrontierTier } from "./lib/query-routing";

describe("parseQueryRoute", () => {
  it("treats no prefix as RAG + local (the default)", () => {
    expect(parseQueryRoute("what is in my taxes?")).toEqual({
      direct: false,
      tier: "local",
      q: "what is in my taxes?",
      sigil: "",
    });
  });

  it("maps the ! family to direct mode at escalating tiers", () => {
    expect(parseQueryRoute("!who am I")).toMatchObject({ direct: true, tier: "local", q: "who am I" });
    expect(parseQueryRoute("!!who am I")).toMatchObject({ direct: true, tier: "frontier-cheap", q: "who am I" });
    expect(parseQueryRoute("!!!who am I")).toMatchObject({ direct: true, tier: "frontier-flagship", q: "who am I" });
  });

  it("maps the + family to RAG + frontier at escalating tiers", () => {
    expect(parseQueryRoute("+summarize my notes")).toMatchObject({ direct: false, tier: "frontier-cheap", q: "summarize my notes" });
    expect(parseQueryRoute("++summarize my notes")).toMatchObject({ direct: false, tier: "frontier-flagship", q: "summarize my notes" });
  });

  it("matches the longest sigil first (!!! over !! over !)", () => {
    expect(parseQueryRoute("!!!x").tier).toBe("frontier-flagship");
    expect(parseQueryRoute("!!x").tier).toBe("frontier-cheap");
    expect(parseQueryRoute("!x").tier).toBe("local");
    expect(parseQueryRoute("++x").tier).toBe("frontier-flagship");
    expect(parseQueryRoute("+x").tier).toBe("frontier-cheap");
  });

  it("trims whitespace around the sigil and the question", () => {
    expect(parseQueryRoute("  !!  hello there  ")).toMatchObject({ direct: true, tier: "frontier-cheap", q: "hello there" });
  });

  it("only triggers on a LEADING sigil (mid-text ! is part of the question)", () => {
    expect(parseQueryRoute("what does 2 != 3 mean?")).toMatchObject({ direct: false, tier: "local", q: "what does 2 != 3 mean?" });
  });

  it("returns an empty q for a bare prefix (caller should ignore)", () => {
    expect(parseQueryRoute("!").q).toBe("");
    expect(parseQueryRoute("++").q).toBe("");
    expect(parseQueryRoute("   ").q).toBe("");
  });

  it("isFrontierTier is true only for frontier tiers", () => {
    expect(isFrontierTier("local")).toBe(false);
    expect(isFrontierTier("frontier-cheap")).toBe(true);
    expect(isFrontierTier("frontier-flagship")).toBe(true);
  });
});
