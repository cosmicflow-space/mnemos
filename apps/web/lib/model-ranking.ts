/**
 * Rank local (Ollama) models for the picker so users don't have to trial-and-error
 * their way to a good one (as we did: gemma3:27b ~32s, gemma3:4b slow AND wrong,
 * llama3.2:3b ~10s with grounded citations).
 *
 * Two axes:
 *  - **Speed** is real when we have it: measured tokens/sec from the audit log
 *    (chat_message latency + tokens_out). Falls back to a param-size estimate for
 *    models you haven't run yet.
 *  - **Accuracy** can't be auto-measured without ground truth, so it's a CURATED
 *    heuristic encoding what holds up for grounded RAG: instruct models ≥3B are
 *    strong; tiny (<2B) are shallow; coder models are mixed for prose; reasoning
 *    (r1/qwq) models are accurate but slow to "think". Small gemma underperformed
 *    in testing, so ≤4B gemma is "fair", not "strong".
 *
 * Balance score = speed × quality, so a fast *and* accurate 3–8B model floats to
 * the top (the recommended default); the list fans out from there.
 */

export type SpeedTier = "fast" | "moderate" | "slow";
export type QualityTier = "strong" | "fair" | "basic" | "code" | "reasoning";

export type ModelFacts = {
  id: string;
  paramsB: number | null; // billions of params (from Ollama /api/show)
  sizeBytes: number | null;
  quant: string | null;
  tokPerSec: number | null; // measured, from the audit log; null if never run
  installed?: boolean; // present on your machine? (false = a curated suggestion)
  note?: string; // short curated hint, for recommended-but-not-installed models
};

/**
 * A small curated set of strong local models to recommend even when they're NOT
 * installed — so a new user who doesn't know what exists gets pointed at good
 * choices (with `ollama pull <id>`), not just shown whatever they happen to have.
 * Kept short and conservative; the ranking + machine fit still decide order.
 */
export type CuratedModel = { id: string; paramsB: number; note: string };
export const CURATED_MODELS: readonly CuratedModel[] = [
  { id: "llama3.2:3b", paramsB: 3, note: "fast + grounded — great default" },
  { id: "qwen2.5:3b", paramsB: 3, note: "fast, accurate for its size" },
  { id: "qwen2.5:7b", paramsB: 7, note: "stronger answers, still quick" },
  { id: "llama3.1:8b", paramsB: 8, note: "solid all-rounder" },
  { id: "mistral:7b", paramsB: 7, note: "well-rounded, widely used" },
  { id: "gemma3:12b", paramsB: 12, note: "high quality, slower on CPU" },
];

export type RankedModel = ModelFacts & {
  speed: SpeedTier;
  quality: QualityTier;
  score: number;
  recommended: boolean;
};

export function speedTier(paramsB: number | null, tokPerSec: number | null): SpeedTier {
  if (tokPerSec != null) return tokPerSec >= 12 ? "fast" : tokPerSec >= 5 ? "moderate" : "slow";
  if (paramsB == null) return "moderate";
  return paramsB <= 4 ? "fast" : paramsB <= 13 ? "moderate" : "slow";
}

export function qualityTier(id: string, paramsB: number | null): QualityTier {
  const n = id.toLowerCase();
  if (n.includes("coder") || n.includes("-code") || n.includes("starcoder")) return "code";
  if (n.includes("-r1") || n.includes("qwq") || n.includes("reason") || n.includes("deepseek-r")) return "reasoning";
  if (paramsB != null && paramsB < 2) return "basic";
  if (n.startsWith("gemma") && paramsB != null && paramsB < 5) return "fair"; // gemma small (incl. "4b" ≈ 4.3B) underperformed in testing
  if (paramsB != null && paramsB >= 3) return "strong";
  return "fair";
}

const SPEED_WEIGHT: Record<SpeedTier, number> = { fast: 3, moderate: 2, slow: 1 };
const QUALITY_WEIGHT: Record<QualityTier, number> = {
  strong: 3,
  fair: 2,
  reasoning: 1.5,
  code: 1,
  basic: 0.5,
};

/** Balance score — rewards models strong on BOTH speed and accuracy. */
export function balanceScore(speed: SpeedTier, quality: QualityTier): number {
  return SPEED_WEIGHT[speed] * QUALITY_WEIGHT[quality];
}

/** Rank balanced-first: highest score wins; ties break toward the smaller (snappier)
 * model. The top entry is flagged `recommended`. */
export function rankModels(models: ModelFacts[]): RankedModel[] {
  const ranked = models
    .map((m): RankedModel => {
      const speed = speedTier(m.paramsB, m.tokPerSec);
      const quality = qualityTier(m.id, m.paramsB);
      return { ...m, speed, quality, score: balanceScore(speed, quality), recommended: false };
    })
    .sort((a, b) => b.score - a.score || (a.paramsB ?? 99) - (b.paramsB ?? 99) || a.id.localeCompare(b.id));
  if (ranked[0]) ranked[0].recommended = true;
  return ranked;
}
