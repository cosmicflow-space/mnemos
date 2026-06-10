import { z } from "zod";
import { runQuery, getChatProvider } from "@mnemos/core";
import {
  createSession,
  getSession,
  setSessionTitle,
  type MnemosDb,
} from "@mnemos/db";
import { randomUUID } from "node:crypto";
import { getDb, getRegistry, getDefaultEmbedder } from "@/lib/runtime";
import { envKeyForProvider } from "@/lib/config";
import { parseQueryRoute, isFrontierTier } from "@/lib/query-routing";
import { resolveFrontierModel } from "@/lib/model-routing";
import { sessionKey, getFocus, setCited, clearCited, type FocusFile } from "@/lib/do-state";
import { isMetadataOnly, metadataOnlyText, titleFromQuery } from "@/lib/focus-util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QueryRequest = z.object({
  q: z.string().min(1).max(8000),
  sessionId: z.string().optional(),
  // Tier 1 (fully local) is the default privacy posture. If the caller omits
  // providerId, route the request to Ollama so the request stays on-machine.
  // Callers wanting an external provider must opt in explicitly via providerId.
  providerId: z.string().optional().default("ollama"),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topK: z.number().int().min(1).max(50).optional(),
  // `q` may carry a routing prefix (!, !!, !!!, +, ++); the server parses it
  // authoritatively (see parseQueryRoute) — direct mode + tier are derived, not
  // trusted from the client.
});

const PROVIDER_CREDENTIAL_ENV: Record<string, (creds: Record<string, string>) => void> = {
  anthropic: (c) => {
    if (process.env.ANTHROPIC_API_KEY) c.apiKey = process.env.ANTHROPIC_API_KEY;
  },
  openai: (c) => {
    if (process.env.OPENAI_API_KEY) c.apiKey = process.env.OPENAI_API_KEY;
  },
  codex: (c) => {
    // No key → the plugin uses the operator's `codex login` session.
    if (process.env.CODEX_API_KEY) c.apiKey = process.env.CODEX_API_KEY;
  },
  gemini: (c) => {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (key) c.apiKey = key;
  },
  ollama: (c) => {
    if (process.env.OLLAMA_BASE_URL) c.baseURL = process.env.OLLAMA_BASE_URL;
    if (process.env.MNEMOS_OLLAMA_MODEL) c.model = process.env.MNEMOS_OLLAMA_MODEL;
  },
};

function ensureSession(
  db: MnemosDb,
  sessionIdInput?: string,
): { id: string; isNew: boolean } {
  if (sessionIdInput) {
    const existing = getSession(db, sessionIdInput);
    if (existing) return { id: existing.id, isNew: false };
  }
  const id = randomUUID();
  createSession(db, id);
  return { id, isNew: true };
}

/**
 * POST /api/query
 * Body: { q, sessionId?, providerId?, model?, temperature?, topK? }
 *
 * Streams Server-Sent Events:
 *   { phase: 'embed', query }
 *   { phase: 'retrieved', hits: [...] }          ← UI shows citation pills immediately
 *   { phase: 'delta', delta: '...' }              ← repeated per token chunk
 *   { phase: 'done', sessionId, assistantMessageId, ... }
 *   { phase: 'error', message }
 *
 * sessionId is optional: if absent, a new session is created and returned
 * with the first 'done' event. The UI persists it locally for subsequent turns.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = QueryRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();

  // Parse the routing prefix (!, !!, !!!, +, ++) into a (direct, tier) decision
  // and the cleaned question. Server-authoritative: the client parses too (for
  // optimistic UI) but we re-derive here and never trust client-sent flags.
  const route = parseQueryRoute(parsed.data.q);
  if (!route.q) {
    return Response.json({ error: "empty_query" }, { status: 400 });
  }

  const registry = getRegistry();

  // Resolve the tier → (provider, model). The local tier keeps the caller's
  // selection; frontier tiers override it with the cheapest/flagship configured
  // frontier model. No frontier configured → guide the user to add a key.
  let providerId = parsed.data.providerId;
  let model = parsed.data.model;
  if (isFrontierTier(route.tier)) {
    const { resolved, suggestProviderId } = await resolveFrontierModel(registry, route.tier);
    if (!resolved) {
      const suggest = suggestProviderId
        ? registry.chatProviders.get(suggestProviderId)
        : undefined;
      return Response.json(
        {
          error: "missing_credentials",
          provider: suggestProviderId ?? "anthropic",
          providerName: suggest?.displayName ?? "a frontier provider",
          envVar: suggestProviderId ? envKeyForProvider(suggestProviderId) : null,
          fields: suggest
            ? suggest.credentialSchema.fields
                .filter((f) => f.required)
                .map((f) => ({ key: f.key, label: f.label, description: f.description ?? null }))
            : [],
          routingHint: `The "${route.sigil}" prefix routes to a frontier model — add an API key to use it, or drop the prefix to stay local.`,
        },
        { status: 400 },
      );
    }
    providerId = resolved.providerId;
    model = resolved.model;
  }

  const { id: sessionId, isNew: isNewSession } = ensureSession(db, parsed.data.sessionId);
  if (isNewSession) {
    setSessionTitle(db, sessionId, titleFromQuery(route.q));
  }

  // File Focus Mode (shared with Telegram via the session-keyed state): scope
  // retrieval to the active file(s) unless this is a direct (`!`) query, which
  // bypasses files entirely. Focus is scope; the `!`/`+` prefix is tier.
  const stateK = sessionKey(sessionId);
  const focus = route.direct ? null : getFocus(stateK);

  // If every focused file is metadata-only (no extractable text — e.g. a scanned
  // PDF), don't let the model improvise. Reply with the honest, located notice
  // and a reindex hint. A short SSE stream so the client renders it like a turn.
  if (focus && focus.every((f) => isMetadataOnly(f.fileId))) {
    const f0 = focus[0];
    const notice = f0 ? metadataOnlyText(f0.fileId, f0.name) : "This file has no readable text indexed.";
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ phase: "notice", message: notice })}\n\n`));
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ phase: "done", sessionId, metadataOnly: true })}\n\n`),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-mnemos-session-id": sessionId,
      },
    });
  }

  let chatProvider;
  try {
    chatProvider = getChatProvider(registry, providerId);
  } catch {
    return Response.json(
      {
        error: "unknown_provider",
        message: `Provider '${providerId}' not registered. Available: ${[...registry.chatProviders.keys()].join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Initialize chat provider with credentials from env
  const creds: Record<string, string> = {};
  const credHydrator = PROVIDER_CREDENTIAL_ENV[providerId];
  if (credHydrator) credHydrator(creds);

  // Schema-driven credential pre-check. Rather than let the provider throw a
  // raw "requires 'apiKey'" Error (which leaked to the UI as red JSON), we ask
  // the provider's own credentialSchema which required fields are missing and
  // return a structured, actionable error the UI can render nicely. Generic:
  // works for any provider without hardcoding provider IDs here.
  const missingFields = chatProvider.credentialSchema.fields.filter(
    (f) => f.required && !creds[f.key],
  );
  if (missingFields.length > 0) {
    return Response.json(
      {
        error: "missing_credentials",
        provider: chatProvider.id,
        providerName: chatProvider.displayName,
        // The env var to set in ~/.mnemos/.env (or via the /agent page).
        envVar: envKeyForProvider(providerId),
        // Each field carries its own human label + docs hint (e.g. the
        // "Get one at https://…/keys" URL lives in the field description).
        fields: missingFields.map((f) => ({
          key: f.key,
          label: f.label,
          description: f.description ?? null,
        })),
      },
      { status: 400 },
    );
  }

  try {
    await chatProvider.initialize(creds);
  } catch (err) {
    return Response.json(
      {
        error: "provider_init_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  // Direct mode skips retrieval entirely, so it must NOT require the embedder —
  // a `!` query should work even when the local embedder is missing or still
  // warming up. Only initialize it for RAG queries.
  let embedder: Awaited<ReturnType<typeof getDefaultEmbedder>> | null = null;
  if (!route.direct) {
    try {
      embedder = await getDefaultEmbedder();
    } catch (err) {
      return Response.json(
        {
          error: "embedder_init_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      // Cited files in display order, de-duplicated by file — so a normal answer
      // can offer `/focus <n>` to scope to one of its own sources (web parity
      // with Telegram). Suppressed when already focused or for a direct query.
      const citedFiles: FocusFile[] = [];
      const seenFiles = new Set<number>();
      try {
        for await (const ev of runQuery(db, embedder, chatProvider, {
          query: route.q,
          sessionId,
          model,
          temperature: parsed.data.temperature,
          topK: parsed.data.topK,
          direct: route.direct,
          scopeFileIds: focus?.map((f) => f.fileId),
        })) {
          if (ev.phase === "retrieved") {
            for (const h of ev.hits) {
              if (seenFiles.has(h.fileId)) continue;
              seenFiles.add(h.fileId);
              citedFiles.push({ fileId: h.fileId, name: h.filePath.split("/").pop() ?? h.filePath });
            }
          }
          send(ev);
        }
        const offerFocus = !focus && !route.direct && citedFiles.length > 0;
        if (offerFocus) setCited(stateK, citedFiles.slice(0, 8));
        else clearCited(stateK);
      } catch (err) {
        send({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-mnemos-session-id": sessionId,
    },
  });
}
