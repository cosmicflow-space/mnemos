import { NextResponse } from "next/server";
import { totalmem, arch } from "node:os";
import { getDb } from "@/lib/runtime";
import { getModelLatencyStats } from "@mnemos/db";
import { rankModels, CURATED_MODELS, type ModelFacts } from "@/lib/model-ranking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A short, machine-tailored note on what size models will run comfortably. */
function machineFit(): { ramGB: number; arch: string; note: string } {
  const ramGB = Math.round(totalmem() / 1e9);
  const a = arch();
  const apple = a === "arm64";
  const band =
    ramGB < 8
      ? "stick to ~3B models"
      : ramGB < 16
        ? "3–7B models run well"
        : ramGB < 32
          ? "up to ~8–12B"
          : "up to ~12–27B — though a 3–8B model is the snappy sweet spot for RAG";
  return {
    ramGB,
    arch: a,
    note: `${ramGB} GB${apple ? " · Apple Silicon" : ` · ${a}`} — ${band}.`,
  };
}

function ollamaBase(): string {
  return process.env.OLLAMA_HOST ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
}

/** Parse Ollama's `parameter_size` ("3.2B", "270M", "27B") to billions. */
function parseParams(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^([\d.]+)\s*([BM])?/i.exec(s.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  return m[2]?.toUpperCase() === "M" ? n / 1000 : n;
}

async function fetchJson(url: string, body?: unknown, timeoutMs = 4000): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * GET /api/models/ranked?provider=ollama
 * Returns local models ranked balanced-first (speed × accuracy) with per-model
 * facts + measured tokens/sec, so the picker can recommend without trial-and-error.
 */
export async function GET(req: Request) {
  const provider = new URL(req.url).searchParams.get("provider") ?? "ollama";
  if (provider !== "ollama") {
    return NextResponse.json({ provider, ranked: [], reachable: true });
  }

  const base = ollamaBase();
  const tags = (await fetchJson(`${base}/api/tags`)) as
    | { models?: Array<{ name: string; size?: number }> }
    | null;
  if (!tags?.models) {
    return NextResponse.json({ provider, ranked: [], reachable: false });
  }

  // Measured speed per model (from recorded assistant messages).
  let tokPerSec = new Map<string, number>();
  try {
    for (const s of getModelLatencyStats(getDb())) {
      if (s.model && s.tokensPerSec != null) tokPerSec.set(s.model, s.tokensPerSec);
    }
  } catch {
    tokPerSec = new Map();
  }

  // Installed models: params + quantization from /api/show (parallel, bounded by
  // the small number of installed models).
  const installed: ModelFacts[] = await Promise.all(
    tags.models.map(async (m): Promise<ModelFacts> => {
      const show = (await fetchJson(`${base}/api/show`, { name: m.name })) as
        | { details?: { parameter_size?: string; quantization_level?: string } }
        | null;
      return {
        id: m.name,
        paramsB: parseParams(show?.details?.parameter_size),
        sizeBytes: m.size ?? null,
        quant: show?.details?.quantization_level ?? null,
        tokPerSec: tokPerSec.get(m.name) ?? null,
        installed: true,
      };
    }),
  );

  // Curated recommendations the user doesn't have yet — surfaced so they know good
  // options exist (with `ollama pull <id>`), ranked alongside installed ones.
  const installedIds = new Set(tags.models.map((m) => m.name));
  const curated: ModelFacts[] = CURATED_MODELS.filter((c) => !installedIds.has(c.id)).map((c) => ({
    id: c.id,
    paramsB: c.paramsB,
    sizeBytes: null,
    quant: null,
    tokPerSec: null,
    installed: false,
    note: c.note,
  }));

  return NextResponse.json({
    provider,
    reachable: true,
    ranked: rankModels([...installed, ...curated]),
    machine: machineFit(),
    docsUrl: "https://ollama.com/library",
  });
}
