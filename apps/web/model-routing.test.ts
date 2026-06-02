import { describe, it, expect } from "vitest";
import { resolveFrontierModel } from "./lib/model-routing";

type FakeModel = { id: string; inputCostPer1M?: number; outputCostPer1M?: number };

function fakeProvider(id: string, requiresKey: boolean, models: FakeModel[]) {
  return {
    id,
    displayName: id,
    credentialSchema: {
      type: id,
      displayName: id,
      fields: requiresKey ? [{ key: "apiKey", label: "API Key", type: "password", required: true }] : [],
    },
    async listModels() {
      return models;
    },
    async initialize() {},
    async *chat() {},
  };
}

// A local provider (no key) plus two frontier providers with differing prices.
const ollama = fakeProvider("ollama", false, [{ id: "llama3.2:3b" }]);
const anthropic = fakeProvider("anthropic", true, [
  { id: "claude-haiku", inputCostPer1M: 0.8, outputCostPer1M: 4 }, // total 4.8
  { id: "claude-opus", inputCostPer1M: 15, outputCostPer1M: 75 }, // total 90 (priciest)
]);
const openai = fakeProvider("openai", true, [
  { id: "gpt-mini", inputCostPer1M: 0.15, outputCostPer1M: 0.6 }, // total 0.75 (cheapest)
  { id: "gpt-pro", inputCostPer1M: 10, outputCostPer1M: 30 }, // total 40
]);

function registryOf(...providers: ReturnType<typeof fakeProvider>[]) {
  return { chatProviders: new Map(providers.map((p) => [p.id, p])) } as unknown as Parameters<
    typeof resolveFrontierModel
  >[0];
}

describe("resolveFrontierModel", () => {
  it("cheap tier picks the lowest-cost model across configured frontier providers", async () => {
    const { resolved } = await resolveFrontierModel(registryOf(ollama, anthropic, openai), "frontier-cheap", () => true);
    expect(resolved).toEqual({ providerId: "openai", model: "gpt-mini" });
  });

  it("flagship tier picks the highest-cost model", async () => {
    const { resolved } = await resolveFrontierModel(registryOf(ollama, anthropic, openai), "frontier-flagship", () => true);
    expect(resolved).toEqual({ providerId: "anthropic", model: "claude-opus" });
  });

  it("excludes local (no-key) providers and skips unconfigured frontier ones", async () => {
    // Only anthropic configured → openai's cheaper models are not eligible.
    const { resolved } = await resolveFrontierModel(
      registryOf(ollama, anthropic, openai),
      "frontier-cheap",
      (id) => id === "anthropic",
    );
    expect(resolved).toEqual({ providerId: "anthropic", model: "claude-haiku" });
  });

  it("returns null + a provider to suggest when no frontier is configured", async () => {
    const { resolved, suggestProviderId } = await resolveFrontierModel(
      registryOf(ollama, anthropic, openai),
      "frontier-cheap",
      () => false,
    );
    expect(resolved).toBeNull();
    // First frontier provider encountered (ollama is local, so skipped).
    expect(suggestProviderId).toBe("anthropic");
  });
});
