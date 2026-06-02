/**
 * Frontier-spend reporting for the `/cost` command.
 *
 * Token counts live in `chat_message` (provider-reported for frontier models);
 * pricing lives in the provider plugins. This module joins the two: a pure
 * `buildCostReport` (unit-testable, no DB/registry) plus `computeCostReport`
 * that wires the DB aggregates and the registry's pricing, and text/markdown
 * formatters shared by Telegram and the web chat.
 *
 * Cost is an ESTIMATE: tokens × per-model price, with the price's `pricedAsOf`
 * date surfaced so a stale rate is obvious.
 */

import type { PluginRegistry } from "@mnemos/core";
import {
  getUsageTotals,
  getSessionUsage,
  listSessions,
  type UsageTotal,
  type SessionUsageRow,
  type MnemosDb,
} from "@mnemos/db";

export type ModelPrice = { inputPer1M: number; outputPer1M: number; pricedAsOf: string | null };
export type PricingMap = Map<string, ModelPrice>;

const key = (provider: string | null, model: string | null) => `${provider ?? ""}:${model ?? ""}`;

function costOf(tokensIn: number, tokensOut: number, p: ModelPrice | undefined): number {
  if (!p) return 0;
  return (tokensIn / 1_000_000) * p.inputPer1M + (tokensOut / 1_000_000) * p.outputPer1M;
}

export type CostByModel = {
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  messages: number;
  cost: number;
};

export type CostReport = {
  totalCost: number;
  /** Most recent pricing date among the models actually used (or null). */
  pricedAsOf: string | null;
  /** Cost-bearing (frontier) models, highest cost first. */
  byModel: CostByModel[];
  sessionCount: number;
  totalQueries: number;
  frontierQueries: number;
  localQueries: number;
  /** Frontier queries we couldn't price (e.g. the row has a provider but no
   * stored model, or an unknown model) — counted as frontier, not hidden as free. */
  unpricedFrontierQueries: number;
  totalTokens: number;
  mostExpensive: { title: string; cost: number } | null;
  longest: { title: string; messages: number; durationMs: number } | null;
};

/** Pure: assemble the report from raw aggregates + a pricing map. No I/O.
 * `frontierProviders` (key-needing provider ids) classifies frontier vs local
 * by the *provider* — so a frontier turn with an unknown/missing model is still
 * counted as frontier rather than hidden as free. */
export function buildCostReport(
  totals: UsageTotal[],
  sessions: SessionUsageRow[],
  pricing: PricingMap,
  sessionCount: number,
  frontierProviders: ReadonlySet<string>,
): CostReport {
  const isFrontier = (provider: string | null) => Boolean(provider && frontierProviders.has(provider));

  const byModel: CostByModel[] = totals.map((t) => ({
    provider: t.provider,
    model: t.model,
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    messages: t.messages,
    cost: costOf(t.tokensIn, t.tokensOut, pricing.get(key(t.provider, t.model))),
  }));

  const totalCost = byModel.reduce((s, m) => s + m.cost, 0);
  const totalQueries = totals.reduce((s, t) => s + t.messages, 0);
  const frontierQueries = byModel
    .filter((m) => isFrontier(m.provider))
    .reduce((s, m) => s + m.messages, 0);
  const unpricedFrontierQueries = byModel
    .filter((m) => isFrontier(m.provider) && m.cost === 0)
    .reduce((s, m) => s + m.messages, 0);
  const totalTokens = totals.reduce((s, t) => s + t.tokensIn + t.tokensOut, 0);

  const datesUsed = totals
    .map((t) => pricing.get(key(t.provider, t.model))?.pricedAsOf)
    .filter((d): d is string => Boolean(d));
  const pricedAsOf = datesUsed.length ? [...datesUsed].sort().at(-1) ?? null : null;

  // Aggregate per session: cost, reply count, time span.
  const bySession = new Map<
    string,
    { title: string; cost: number; messages: number; firstAt: number; lastAt: number }
  >();
  for (const r of sessions) {
    const cur =
      bySession.get(r.sessionId) ??
      { title: r.title ?? "(untitled)", cost: 0, messages: 0, firstAt: r.firstAt, lastAt: r.lastAt };
    cur.cost += costOf(r.tokensIn, r.tokensOut, pricing.get(key(r.provider, r.model)));
    cur.messages += r.messages;
    cur.firstAt = Math.min(cur.firstAt, r.firstAt);
    cur.lastAt = Math.max(cur.lastAt, r.lastAt);
    bySession.set(r.sessionId, cur);
  }
  const sessionArr = [...bySession.values()];
  const priciest = sessionArr.reduce<(typeof sessionArr)[number] | null>(
    (a, b) => (a === null || b.cost > a.cost ? b : a),
    null,
  );
  const longest = sessionArr.reduce<(typeof sessionArr)[number] | null>(
    (a, b) => (a === null || b.messages > a.messages ? b : a),
    null,
  );

  return {
    totalCost,
    pricedAsOf,
    byModel: byModel.filter((m) => m.cost > 0).sort((a, b) => b.cost - a.cost),
    sessionCount,
    totalQueries,
    frontierQueries,
    localQueries: totalQueries - frontierQueries,
    unpricedFrontierQueries,
    totalTokens,
    mostExpensive: priciest && priciest.cost > 0 ? { title: priciest.title, cost: priciest.cost } : null,
    longest: longest ? { title: longest.title, messages: longest.messages, durationMs: Math.max(0, longest.lastAt - longest.firstAt) } : null,
  };
}

/**
 * Build a (provider:model → price) map plus the set of frontier (key-needing)
 * provider ids. ONLY frontier providers are queried: local providers have no
 * pricing (always free), and skipping them avoids a network call — e.g. Ollama's
 * `listModels()` hits `/api/tags` with no timeout, which would otherwise let a
 * read-only `/cost` report hang on a dead local endpoint. A provider is
 * "frontier" if its credential schema requires a field (plugin-agnostic — no
 * hardcoded ids).
 */
export async function buildPricing(
  registry: PluginRegistry,
): Promise<{ pricing: PricingMap; frontierProviders: Set<string> }> {
  const pricing: PricingMap = new Map();
  const frontierProviders = new Set<string>();
  for (const p of registry.chatProviders.values()) {
    const needsKey = p.credentialSchema.fields.some((f) => f.required);
    if (!needsKey) continue;
    frontierProviders.add(p.id);
    let models;
    try {
      models = await p.listModels();
    } catch {
      continue;
    }
    for (const m of models) {
      pricing.set(`${p.id}:${m.id}`, {
        inputPer1M: m.inputCostPer1M ?? 0,
        outputPer1M: m.outputCostPer1M ?? 0,
        pricedAsOf: m.pricedAsOf ?? null,
      });
    }
  }
  return { pricing, frontierProviders };
}

export async function computeCostReport(db: MnemosDb, registry: PluginRegistry): Promise<CostReport> {
  const { pricing, frontierProviders } = await buildPricing(registry);
  // Large limit → count every session (single-user local tool).
  const sessionCount = listSessions(db, 1_000_000).length;
  return buildCostReport(getUsageTotals(db), getSessionUsage(db), pricing, sessionCount, frontierProviders);
}

function money(n: number): string {
  return `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
}

function duration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const NO_SPEND =
  "💰 No frontier spending yet — every query has run locally (free). Use a frontier prefix (!! / !!! / + / ++) to route to Claude/GPT.";

/** Plain text for Telegram. */
export function formatCostText(r: CostReport): string {
  if (r.totalCost === 0 && r.frontierQueries === 0) return NO_SPEND;
  const lines = [
    `💰 Frontier spend (estimated${r.pricedAsOf ? `, pricing as of ${r.pricedAsOf}` : ""})`,
    ``,
    `Total to date: ${money(r.totalCost)}`,
    `Queries: ${r.totalQueries} (${r.frontierQueries} frontier / ${r.localQueries} local)`,
    `Sessions: ${r.sessionCount}`,
    `Tokens: ${r.totalTokens.toLocaleString("en-US")}`,
  ];
  if (r.byModel.length) {
    lines.push(``, `By model:`);
    for (const m of r.byModel) lines.push(`• ${m.provider}/${m.model}: ${money(m.cost)} (${m.messages} queries)`);
  }
  if (r.mostExpensive) lines.push(``, `Priciest session: ${money(r.mostExpensive.cost)} — ${r.mostExpensive.title}`);
  if (r.longest) {
    const d = r.longest.durationMs ? `, ${duration(r.longest.durationMs)}` : "";
    lines.push(`Longest session: ${r.longest.messages} replies${d} — ${r.longest.title}`);
  }
  if (r.unpricedFrontierQueries > 0) {
    lines.push(``, `⚠️ ${r.unpricedFrontierQueries} frontier ${r.unpricedFrontierQueries === 1 ? "query" : "queries"} couldn't be priced (no model recorded) — total may understate spend.`);
  }
  return lines.join("\n");
}

/** Markdown for the web chat. */
export function formatCostMarkdown(r: CostReport): string {
  if (r.totalCost === 0 && r.frontierQueries === 0) return NO_SPEND;
  const parts: string[] = [
    `**💰 Frontier spend** — estimated${r.pricedAsOf ? `, pricing as of ${r.pricedAsOf}` : ""}`,
    ``,
    `- **Total to date:** ${money(r.totalCost)}`,
    `- **Queries:** ${r.totalQueries} (${r.frontierQueries} frontier / ${r.localQueries} local)`,
    `- **Sessions:** ${r.sessionCount}`,
    `- **Tokens:** ${r.totalTokens.toLocaleString("en-US")}`,
  ];
  if (r.mostExpensive) parts.push(`- **Priciest session:** ${money(r.mostExpensive.cost)} — ${r.mostExpensive.title}`);
  if (r.longest) {
    const d = r.longest.durationMs ? `, ${duration(r.longest.durationMs)}` : "";
    parts.push(`- **Longest session:** ${r.longest.messages} replies${d} — ${r.longest.title}`);
  }
  if (r.byModel.length) {
    parts.push(``, `| Model | Cost | Queries | Tokens (in/out) |`, `|---|---|---|---|`);
    for (const m of r.byModel) {
      parts.push(`| ${m.provider}/${m.model} | ${money(m.cost)} | ${m.messages} | ${m.tokensIn.toLocaleString("en-US")} / ${m.tokensOut.toLocaleString("en-US")} |`);
    }
  }
  if (r.unpricedFrontierQueries > 0) {
    parts.push(``, `> ⚠️ ${r.unpricedFrontierQueries} frontier ${r.unpricedFrontierQueries === 1 ? "query" : "queries"} couldn't be priced (no model recorded) — total may understate spend.`);
  }
  return parts.join("\n");
}
