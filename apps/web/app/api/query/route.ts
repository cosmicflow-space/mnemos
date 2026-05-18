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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QueryRequest = z.object({
  q: z.string().min(1).max(8000),
  sessionId: z.string().optional(),
  providerId: z.string().optional().default("anthropic"),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topK: z.number().int().min(1).max(50).optional(),
});

const PROVIDER_CREDENTIAL_ENV: Record<string, (creds: Record<string, string>) => void> = {
  anthropic: (c) => {
    if (process.env.ANTHROPIC_API_KEY) c.apiKey = process.env.ANTHROPIC_API_KEY;
  },
  openai: (c) => {
    if (process.env.OPENAI_API_KEY) c.apiKey = process.env.OPENAI_API_KEY;
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

/** Truncate a user query into a sidebar-friendly title. Cuts on a word
 * boundary near 50 chars and strips trailing punctuation. Falls back to a
 * hard slice if no whitespace nearby. */
function titleFromQuery(q: string): string {
  const cleaned = q.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 50) return cleaned;
  const truncated = cleaned.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated;
  return cut.replace(/[.,;:!?\-]+$/, "") + "…";
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
  const { id: sessionId, isNew: isNewSession } = ensureSession(db, parsed.data.sessionId);
  if (isNewSession) {
    setSessionTitle(db, sessionId, titleFromQuery(parsed.data.q));
  }

  const registry = getRegistry();

  let chatProvider;
  try {
    chatProvider = getChatProvider(registry, parsed.data.providerId);
  } catch {
    return Response.json(
      {
        error: "unknown_provider",
        message: `Provider '${parsed.data.providerId}' not registered. Available: ${[...registry.chatProviders.keys()].join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Initialize chat provider with credentials from env
  const creds: Record<string, string> = {};
  const credHydrator = PROVIDER_CREDENTIAL_ENV[parsed.data.providerId];
  if (credHydrator) credHydrator(creds);
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

  let embedder;
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      try {
        for await (const ev of runQuery(db, embedder, chatProvider, {
          query: parsed.data.q,
          sessionId,
          model: parsed.data.model,
          temperature: parsed.data.temperature,
          topK: parsed.data.topK,
        })) {
          send(ev);
        }
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
