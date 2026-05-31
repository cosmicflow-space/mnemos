import { describe, it, expect } from "vitest";
import { rankModels, qualityTier, speedTier, type ModelFacts } from "./lib/model-ranking";

const facts = (id: string, paramsB: number | null, tokPerSec: number | null = null): ModelFacts => ({
  id,
  paramsB,
  sizeBytes: null,
  quant: null,
  tokPerSec,
});

describe("model-ranking", () => {
  it("puts a fast, accurate 3–8B instruct model first (the balanced pick)", () => {
    const ranked = rankModels([
      facts("gemma3:27b", 27),
      facts("gemma3:4b", 4),
      facts("llama3.2:3b", 3),
      facts("gemma3:1b", 1),
      facts("qwen2.5-coder:14b", 14),
    ]);
    expect(ranked[0]?.id).toBe("llama3.2:3b");
    expect(ranked[0]?.recommended).toBe(true);
    // the big slow model and the coder model are not the recommendation
    expect(ranked.find((m) => m.id === "qwen2.5-coder:14b")?.recommended).toBe(false);
  });

  it("treats coder models as code-focused (mixed for prose RAG)", () => {
    expect(qualityTier("qwen2.5-coder:7b", 7)).toBe("code");
    expect(qualityTier("starcoder2:3b", 3)).toBe("code");
  });

  it("flags reasoning models (they're accurate but slow to think)", () => {
    expect(qualityTier("deepseek-r1:70b", 70)).toBe("reasoning");
    expect(qualityTier("qwq:32b", 32)).toBe("reasoning");
  });

  it("rates tiny (<2B) models basic and small gemma only fair", () => {
    expect(qualityTier("gemma3:1b", 1)).toBe("basic");
    expect(qualityTier("gemma3:4b", 4)).toBe("fair");
    expect(qualityTier("llama3.2:3b", 3)).toBe("strong");
  });

  it("uses measured tok/s for speed when available, else param size", () => {
    expect(speedTier(27, 18)).toBe("fast"); // measured fast overrides big size
    expect(speedTier(27, null)).toBe("slow"); // no measurement → estimate by size
    expect(speedTier(3, null)).toBe("fast");
    expect(speedTier(8, 6)).toBe("moderate");
  });

  it("ranks exactly one model as recommended", () => {
    const ranked = rankModels([facts("a:3b", 3), facts("b:7b", 7), facts("c:1b", 1)]);
    expect(ranked.filter((m) => m.recommended)).toHaveLength(1);
  });
});
