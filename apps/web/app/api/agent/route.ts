import { z } from "zod";
import { runAgentLoop, getChatProvider, buildWorkspaceFs, type AgentEvent, type ToolContext } from "@mnemos/core";
import {
  createSession,
  getSession,
  setSessionTitle,
  appendMessage,
  getRecentMessages,
  appendAudit,
  vecSearch,
  listSources,
  type MnemosDb,
} from "@mnemos/db";
import { randomUUID } from "node:crypto";
import { getDb, getRegistry, getDefaultEmbedder } from "@/lib/runtime";
import { credentialsForProvider, envKeyForProvider } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AgentRequest = z.object({
  goal: z.string().min(1).max(8000),
  sessionId: z.string().optional(),
  // Local-first default: the read-only agent runs on the local model unless the
  // caller opts into a frontier provider explicitly.
  providerId: z.string().optional().default("ollama"),
  model: z.string().optional(),
  maxSteps: z.number().int().min(1).max(10).optional(),
});

function ensureSession(db: MnemosDb, id?: string): { id: string; isNew: boolean } {
  if (id) {
    const existing = getSession(db, id);
    if (existing) return { id: existing.id, isNew: false };
  }
  const sid = randomUUID();
  createSession(db, sid);
  return { id: sid, isNew: true };
}

/**
 * POST /api/agent — run ONE bounded, read-only agent loop for a goal.
 *
 * Unlike `/run` (command execution, web/loopback-only), the agent is strictly
 * READ-ONLY: it investigates the registered workspace — semantic search plus
 * navigate/find/read/grep — and answers. No write, no exec, so it needs no exec
 * gate and is safe on any authenticated surface (web + Telegram). The injected
 * ToolContext carries only read-only capabilities (vector search + a confined,
 * realpath-bounded workspace view), so the read-only contract is honored at the
 * wiring point, not just by convention.
 *
 * Streams Server-Sent Events mirroring the loop's AgentEvents (step, tool_call,
 * observation, answer, done). On completion, persists goal + answer to the
 * session and audits the turn.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = AgentRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  const db = getDb();
  const registry = getRegistry();
  const providerId = parsed.data.providerId;

  let chatProvider;
  try {
    chatProvider = getChatProvider(registry, providerId);
  } catch {
    return Response.json({ error: "unknown_provider" }, { status: 400 });
  }

  const creds = credentialsForProvider(providerId);
  const missing = chatProvider.credentialSchema.fields.filter((f) => f.required && !creds[f.key]);
  if (missing.length > 0) {
    return Response.json(
      {
        error: "missing_credentials",
        provider: chatProvider.id,
        providerName: chatProvider.displayName,
        envVar: envKeyForProvider(providerId),
        fields: missing.map((f) => ({ key: f.key, label: f.label, description: f.description ?? null })),
      },
      { status: 400 },
    );
  }
  try {
    await chatProvider.initialize(creds);
  } catch (err) {
    return Response.json(
      { error: "provider_init_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // The agent's read-only search capability: embed the query, then vector-search.
  // Read-only (no writes/deletes); the only possible outbound traffic is the
  // configured embedder (local by default, but a key-based embedding provider if
  // the operator set one). This is the vetted read-only ToolContext the loop needs.
  let embedder: Awaited<ReturnType<typeof getDefaultEmbedder>>;
  try {
    embedder = await getDefaultEmbedder();
  } catch (err) {
    return Response.json(
      { error: "embedder_init_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  const ctx: ToolContext = {
    search: async (query: string, k: number) => {
      const [embedding] = await embedder.embed([query]);
      return embedding ? vecSearch(db, embedding, k) : [];
    },
    // Confined, read-only workspace view over the registered source roots — the
    // agent can navigate/find/read/grep within them, never outside.
    fs: buildWorkspaceFs(listSources(db).map((s) => s.path)),
  };

  const { id: sessionId, isNew } = ensureSession(db, parsed.data.sessionId);
  if (isNew) setSessionTitle(db, sessionId, parsed.data.goal.slice(0, 50));

  const conversationMemory = getRecentMessages(db, sessionId, 10).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      let answer = "";
      let steps = 0;
      let terminatedBy = "error";
      try {
        for await (const ev of runAgentLoop(chatProvider, {
          goal: parsed.data.goal,
          ctx,
          conversationMemory,
          model: parsed.data.model,
          maxSteps: parsed.data.maxSteps,
          // Propagate client disconnect: closing the tab aborts the model turn
          // and any tool work instead of running to the cap/timeout.
          signal: req.signal,
        })) {
          if (ev.phase === "answer") answer = ev.delta;
          if (ev.phase === "done") {
            steps = ev.steps;
            terminatedBy = ev.terminatedBy;
          }
          send(ev);
        }
        // If the client went away mid-run, don't persist/audit a partial turn.
        if (req.signal.aborted) return;
        // Persist the turn for continuity (sticky-session follow-ups read it).
        appendMessage(db, { sessionId, role: "user", content: parsed.data.goal });
        if (answer) appendMessage(db, { sessionId, role: "assistant", content: answer });
        appendAudit(db, "agent_loop", {
          sessionId,
          steps,
          terminatedBy,
          provider: providerId,
          readOnly: true,
          retrievalInContext: true,
        });
      } catch (err) {
        send({ phase: "done", steps, terminatedBy: "error" } as AgentEvent);
        appendAudit(db, "agent_loop", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
          readOnly: true,
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
