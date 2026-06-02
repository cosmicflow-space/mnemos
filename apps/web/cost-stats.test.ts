import { describe, it, expect } from "vitest";
import { buildCostReport, formatCostText, type PricingMap } from "./lib/cost-stats";

const pricing: PricingMap = new Map([
  ["anthropic:claude-haiku", { inputPer1M: 0.8, outputPer1M: 4, pricedAsOf: "2026-05-30" }],
  ["anthropic:claude-opus", { inputPer1M: 15, outputPer1M: 75, pricedAsOf: "2026-06-01" }],
  ["ollama:qwen2.5:3b", { inputPer1M: 0, outputPer1M: 0, pricedAsOf: null }],
]);

// Frontier (key-needing) providers — classification is by provider, not cost.
const frontier = new Set(["anthropic", "openai"]);

// haiku: 1M in * 0.8 + 0.5M out * 4 = 0.8 + 2.0 = 2.8
// opus:  0.1M in * 15 + 0.1M out * 75 = 1.5 + 7.5 = 9.0
const totals = [
  { provider: "ollama", model: "qwen2.5:3b", tokensIn: 1000, tokensOut: 2000, messages: 5 },
  { provider: "anthropic", model: "claude-haiku", tokensIn: 1_000_000, tokensOut: 500_000, messages: 3 },
  { provider: "anthropic", model: "claude-opus", tokensIn: 100_000, tokensOut: 100_000, messages: 1 },
];

const sessions = [
  { sessionId: "s1", title: "Cheap chat", provider: "anthropic", model: "claude-haiku", tokensIn: 1_000_000, tokensOut: 500_000, messages: 3, firstAt: 1000, lastAt: 4000 },
  { sessionId: "s2", title: "Big think", provider: "anthropic", model: "claude-opus", tokensIn: 100_000, tokensOut: 100_000, messages: 1, firstAt: 5000, lastAt: 6000 },
  { sessionId: "s1", title: "Cheap chat", provider: "ollama", model: "qwen2.5:3b", tokensIn: 1000, tokensOut: 2000, messages: 5, firstAt: 500, lastAt: 8000 },
];

describe("buildCostReport", () => {
  const r = buildCostReport(totals, sessions, pricing, 2, frontier);

  it("sums cost across frontier models only", () => {
    expect(r.totalCost).toBeCloseTo(2.8 + 9.0, 5);
  });

  it("splits frontier vs local query counts", () => {
    expect(r.totalQueries).toBe(9);
    expect(r.frontierQueries).toBe(4); // 3 haiku + 1 opus
    expect(r.localQueries).toBe(5);
  });

  it("byModel excludes zero-cost (local) models and sorts by cost desc", () => {
    expect(r.byModel.map((m) => m.model)).toEqual(["claude-opus", "claude-haiku"]);
  });

  it("identifies the most expensive session by cost", () => {
    expect(r.mostExpensive?.title).toBe("Big think"); // s2 $9.0 > s1 $2.8
    expect(r.mostExpensive?.cost).toBeCloseTo(9.0, 5);
  });

  it("identifies the longest session by reply count, with duration", () => {
    expect(r.longest?.title).toBe("Cheap chat"); // s1: 3 + 5 = 8 replies
    expect(r.longest?.messages).toBe(8);
    expect(r.longest?.durationMs).toBe(8000 - 500);
  });

  it("surfaces the most recent pricing date used", () => {
    expect(r.pricedAsOf).toBe("2026-06-01");
  });

  it("counts a frontier turn with no recorded model as frontier (unpriced), not local/free", () => {
    const r2 = buildCostReport(
      [{ provider: "anthropic", model: null, tokensIn: 1000, tokensOut: 1000, messages: 2 }],
      [],
      pricing,
      1,
      frontier,
    );
    expect(r2.frontierQueries).toBe(2); // classified by provider, not by cost
    expect(r2.localQueries).toBe(0);
    expect(r2.unpricedFrontierQueries).toBe(2);
    expect(r2.totalCost).toBe(0); // can't price an unknown model
    // The "no frontier spending" message must NOT appear — it wasn't free/local.
    expect(formatCostText(r2)).not.toMatch(/No frontier spending/i);
    expect(formatCostText(r2)).toMatch(/couldn't be priced/);
  });
});

describe("formatCostText", () => {
  it("shows a no-spend message when everything ran locally", () => {
    const empty = buildCostReport(
      [{ provider: "ollama", model: "qwen2.5:3b", tokensIn: 10, tokensOut: 10, messages: 2 }],
      [],
      pricing,
      1,
      frontier,
    );
    expect(formatCostText(empty)).toMatch(/No frontier spending/i);
  });

  it("includes total + a model line when there is spend", () => {
    const text = formatCostText(buildCostReport(totals, sessions, pricing, 2, frontier));
    expect(text).toMatch(/Total to date/);
    expect(text).toContain("claude-opus");
  });
});
