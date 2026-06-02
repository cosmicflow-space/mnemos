/**
 * Server-side tier → (provider, model) resolution for prefix routing.
 *
 * A provider is treated as "frontier" if its credential schema requires a field
 * (i.e. it needs an API key) — this keeps the logic plugin-agnostic: local
 * providers like Ollama need no key and are excluded automatically, with no
 * hardcoded provider IDs. Among *configured* frontier providers we rank models
 * by total price (input + output per 1M tokens); the cheap tier takes the
 * lowest, the flagship tier the highest.
 */

import type { PluginRegistry } from "@mnemos/core";
import type { RouteTier } from "./query-routing";

export type ResolvedModel = { providerId: string; model: string };

type Candidate = ResolvedModel & { cost: number };

/** True when this provider needs an API key (→ frontier, non-local). */
function isFrontierProvider(p: { credentialSchema: { fields: { required?: boolean }[] } }): boolean {
  return p.credentialSchema.fields.some((f) => f.required);
}

/**
 * Resolve the chat provider + model for a frontier tier. Returns null when no
 * frontier provider is configured (caller should prompt the user to add a key).
 * Also returns the id of a frontier provider to *suggest* configuring, so the
 * "add a key" prompt can point somewhere concrete even when none is set up yet.
 */
export async function resolveFrontierModel(
  registry: PluginRegistry,
  tier: RouteTier,
  // Injectable for testing. Default is loaded lazily so unit tests that pass
  // their own predicate never pull in ./config (and its Next-only @/ aliases).
  isConfigured?: (id: string) => boolean,
): Promise<{ resolved: ResolvedModel | null; suggestProviderId: string | null }> {
  // Default check: a frontier provider is eligible only if we know its API-key
  // env var (envKeyForProvider != null) AND that key is set. The env-var guard
  // closes a gap where isProviderConfigured returns true for providers absent
  // from the key map (intended for local providers) — we never want to route to
  // a key-needing provider whose key we can't verify. (Found in partner review.)
  let checkConfigured = isConfigured;
  if (!checkConfigured) {
    const cfg = await import("./config");
    checkConfigured = (id: string) => cfg.envKeyForProvider(id) !== null && cfg.isProviderConfigured(id);
  }
  const candidates: Candidate[] = [];
  let suggestProviderId: string | null = null;

  for (const p of registry.chatProviders.values()) {
    if (!isFrontierProvider(p)) continue;
    // First frontier provider we see is the one we'll suggest configuring.
    if (suggestProviderId === null) suggestProviderId = p.id;
    if (!checkConfigured(p.id)) continue;
    let models;
    try {
      models = await p.listModels();
    } catch {
      continue;
    }
    for (const m of models) {
      candidates.push({
        providerId: p.id,
        model: m.id,
        cost: (m.inputCostPer1M ?? 0) + (m.outputCostPer1M ?? 0),
      });
    }
  }

  if (candidates.length === 0) return { resolved: null, suggestProviderId };

  // Sort by total price (a capability proxy — flagship ≈ priciest), with a
  // deterministic id tie-break so equal-priced models (e.g. two same-cost models
  // from one provider) don't flip based on list order. (Found in partner review.)
  candidates.sort(
    (a, b) =>
      a.cost - b.cost ||
      a.model.localeCompare(b.model) ||
      a.providerId.localeCompare(b.providerId),
  );
  const pick = tier === "frontier-flagship" ? candidates[candidates.length - 1] : candidates[0];
  if (!pick) return { resolved: null, suggestProviderId };
  return { resolved: { providerId: pick.providerId, model: pick.model }, suggestProviderId };
}
