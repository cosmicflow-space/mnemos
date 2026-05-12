import { NextResponse } from "next/server";
import { getRegistry } from "@/lib/runtime";

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

    return NextResponse.json({
      plugins: registry.plugins.map((p) => ({
        id: p.manifest.id,
        displayName: p.manifest.displayName,
        version: p.manifest.version,
        apiVersion: p.manifest.apiVersion,
      })),
      chatProviders: [...registry.chatProviders.values()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
        credentialType: p.credentialSchema.type,
      })),
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
