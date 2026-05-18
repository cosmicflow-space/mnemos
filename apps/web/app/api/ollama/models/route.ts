import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ollama/models
 *
 * Asks the locally-running Ollama daemon for its installed model list. Used by
 * the /agent page to populate the model dropdown. Returns an empty list if
 * Ollama isn't reachable — caller renders a "start ollama serve" hint.
 */
export async function GET() {
  const base = process.env.OLLAMA_HOST ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      return NextResponse.json({ reachable: false, baseUrl: base, models: [] });
    }
    const data = (await r.json()) as { models?: Array<{ name: string; size?: number }> };
    return NextResponse.json({
      reachable: true,
      baseUrl: base,
      models: (data.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size ?? null,
      })),
    });
  } catch {
    return NextResponse.json({ reachable: false, baseUrl: base, models: [] });
  }
}
