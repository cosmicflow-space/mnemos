import { NextResponse } from "next/server";
import { getRegistry } from "@/lib/runtime";
import { envKeyForProvider, isProviderConfigured } from "@/lib/config";

export const runtime = "nodejs";

/**
 * GET /api/providers
 *
 * Returns the list of plugins, chat providers, embedding providers, and
 * document loaders registered at startup. Read-only; safe without credentials.
 */
export async function GET() {
  try {
    const registry = getRegistry();

    // Resolve each chat provider's models (with pricing) so the UI can render a
    // model dropdown and per-model cost. listModels() may hit the network
    // (Ollama probes its daemon), so it's awaited per provider and guarded —
    // an unreachable provider yields an empty model list, not a 500.
    const chatProviders = await Promise.all(
      [...registry.chatProviders.values()].map(async (p) => {
        // A provider "needs a key" if its schema declares any required field.
        const requiredField = p.credentialSchema.fields.find((f) => f.required);
        let models: Array<{
          id: string;
          displayName: string;
          contextWindow: number;
          inputCostPer1M: number | null;
          outputCostPer1M: number | null;
          pricedAsOf: string | null;
        }> = [];
        try {
          models = (await p.listModels()).map((m) => ({
            id: m.id,
            displayName: m.displayName,
            contextWindow: m.contextWindow,
            inputCostPer1M: m.inputCostPer1M ?? null,
            outputCostPer1M: m.outputCostPer1M ?? null,
            pricedAsOf: m.pricedAsOf ?? null,
          }));
        } catch {
          models = [];
        }
        // Default to the cheapest priced model (RAG over your docs doesn't need
        // a flagship); fall back to the first model when none carry pricing.
        const priced = models.filter(
          (m) => m.inputCostPer1M != null || m.outputCostPer1M != null,
        );
        const cost = (m: (typeof models)[number]) =>
          (m.inputCostPer1M ?? 0) + (m.outputCostPer1M ?? 0);
        const defaultModel =
          (priced.length
            ? [...priced].sort((a, b) => cost(a) - cost(b))[0]
            : models[0]
          )?.id ?? null;
        return {
          id: p.id,
          displayName: p.displayName,
          credentialType: p.credentialSchema.type,
          needsKey: Boolean(requiredField),
          configured: isProviderConfigured(p.id),
          envVar: envKeyForProvider(p.id),
          credentialLabel: requiredField?.label ?? null,
          credentialDescription: requiredField?.description ?? null,
          models,
          defaultModel,
        };
      }),
    );

    return NextResponse.json({
      plugins: registry.plugins.map((p) => ({
        id: p.manifest.id,
        displayName: p.manifest.displayName,
        version: p.manifest.version,
        apiVersion: p.manifest.apiVersion,
      })),
      chatProviders,
      embeddingProviders: [...registry.embeddingProviders.values()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
        dimensions: p.dimensions,
        credentialType: p.credentialSchema.type,
      })),
      documentLoaders: [...registry.documentLoaders.values()].map((l) => ({
        id: l.id,
        extensions: [...l.extensions],
      })),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "registry_load_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
