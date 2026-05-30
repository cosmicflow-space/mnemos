/**
 * Query orchestrator.
 *
 * The read-path counterpart to `ingestFolder`. For a user query:
 *   1. Embed query via the embedding provider
 *   2. Retrieve top-K chunks from sqlite-vec (cosine distance)
 *   3. Pull conversation memory (last N turns from this session)
 *   4. Assemble RAG prompt with numbered citations
 *   5. Stream the chat provider's response as deltas
 *   6. On completion: persist user + assistant messages, append audit event
 *
 * The function is an async generator that yields `QueryEvent` items —
 * citation list first (so UI can render reference list before any text
 * arrives), then text deltas, then a final summary event.
 */

import {
  vecSearch,
  appendMessage,
  appendAudit,
  getRecentMessages,
  searchVerifiedAnswers,
  getChunksByIds,
  getContentChunksForFile,
  type MnemosDb,
  type SearchHit,
} from "@mnemos/db";
import type {
  ChatProvider,
  EmbeddingProvider,
} from "@mnemos/plugin-sdk";
import { assemblePrompt } from "./prompt";
import { hashString } from "../ingest/hash";

// Max L2 distance for a verified answer to count as "the same question". On
// unit-norm embeddings this is ≈ cosine 0.9 — deliberately strict so a merely
// related question never injects the wrong confirmed answer. Tunable.
const VERIFIED_MATCH_MAX_DISTANCE = 0.45;

export type QueryEvent =
  | { phase: "embed"; query: string }
  | {
      phase: "retrieved";
      hits: Array<{
        ref: number;
        chunkId: number;
        filePath: string;
        sourcePath: string;
        snippet: string;
        /** Full chunk text — this is exactly what is assembled into the prompt
         * and sent to the model. Surfaced so the UI can show "what was sent". */
        text: string;
        /** Source file modification time (epoch ms) for the sources panel. */
        fileMtime: number;
        startOffset: number;
        endOffset: number;
        distance: number;
      }>;
    }
  | { phase: "delta"; delta: string }
  | {
      phase: "done";
      sessionId: string;
      assistantMessageId: number;
      tokenCounts: { in: number | null; out: number | null };
      provider: string;
      model: string | null;
      durationMs: number;
      citationChunkIds: number[];
      /** True when a previously-verified answer was injected for this query. */
      verifiedAnswerUsed: boolean;
    }
  | { phase: "error"; message: string };

export type RunQueryOptions = {
  query: string;
  sessionId: string;
  topK?: number;
  maxMemoryTurns?: number;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export async function* runQuery(
  db: MnemosDb,
  embedder: EmbeddingProvider,
  chat: ChatProvider,
  opts: RunQueryOptions,
): AsyncGenerator<QueryEvent, void, unknown> {
  const start = Date.now();
  const topK = opts.topK ?? 8;
  const memoryTurns = opts.maxMemoryTurns ?? 10;

  yield { phase: "embed", query: opts.query };

  // 1. Embed query
  let queryVector: number[];
  try {
    const [v] = await embedder.embed([opts.query]);
    if (!v) throw new Error("Embedder returned empty vector");
    queryVector = v;
  } catch (err) {
    yield {
      phase: "error",
      message: `embed failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  // 2. Retrieve top-K
  let hits: SearchHit[] = [];
  try {
    hits = vecSearch(db, queryVector, topK);
  } catch (err) {
    yield {
      phase: "error",
      message: `retrieve failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  // 2b. Metadata-chunk expansion. The synthetic per-file metadata chunk
  // (ordinal -1: path/size/mtime/type) is a strong lexical match for questions
  // that name a file ("VIN in ipostal?") but holds no answer — so it can
  // out-rank and crowd out its own file's content, especially in a large index.
  // When a file surfaced only via its metadata chunk, pull in that file's
  // content so "found the file" implies "can answer about its contents".
  const filesWithContent = new Set(
    hits.filter((h) => h.ordinal >= 0).map((h) => h.fileId),
  );
  const seenChunks = new Set(hits.map((h) => h.chunkId));
  const PER_FILE_CONTENT = 3;
  const maxInjected = topK;
  const injected: SearchHit[] = [];
  for (const h of hits) {
    if (injected.length >= maxInjected) break;
    if (h.ordinal !== -1 || filesWithContent.has(h.fileId)) continue;
    for (const c of getContentChunksForFile(db, h.fileId, PER_FILE_CONTENT, h.distance)) {
      if (seenChunks.has(c.chunkId)) continue;
      seenChunks.add(c.chunkId);
      injected.push(c);
      if (injected.length >= maxInjected) break;
    }
  }
  if (injected.length > 0) hits = [...hits, ...injected];

  // Emit citations early so the UI can show "looking at 8 chunks..." before
  // the model starts producing text. UX win when the model is slow to first token.
  yield {
    phase: "retrieved",
    hits: hits.map((h, idx) => ({
      ref: idx + 1,
      chunkId: h.chunkId,
      filePath: h.filePath,
      sourcePath: h.sourcePath,
      snippet: h.text.length > 200 ? `${h.text.slice(0, 200)}…` : h.text,
      text: h.text,
      fileMtime: h.fileMtime,
      startOffset: h.startOffset,
      endOffset: h.endOffset,
      distance: h.distance,
    })),
  };

  // 3. Memory
  const memory = getRecentMessages(db, opts.sessionId, memoryTurns).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 3b. Verified-answer memory: if a closely-matching question was confirmed
  // before AND its grounding chunks are unchanged, inject the confirmed answer
  // so even a small model nails it. Lazy invalidation: re-hash the source chunks
  // and skip if they've changed (re-ingest purges old chunk IDs → mismatch).
  let verifiedAnswer: { question: string; answer: string } | undefined;
  try {
    const [match] = searchVerifiedAnswers(db, queryVector, 1);
    if (match && match.distance <= VERIFIED_MATCH_MAX_DISTANCE) {
      const fetched = getChunksByIds(db, match.sourceChunkIds);
      const stillValid =
        fetched.length === match.sourceChunkIds.length &&
        hashString(fetched.map((c) => c.text).join("\n")) === match.sourceHash;
      if (stillValid) {
        verifiedAnswer = { question: match.question, answer: match.answer };
      }
    }
  } catch {
    // Verified-answer lookup is a best-effort boost; never block the query.
  }

  // 4. Assemble prompt
  const { messages } = assemblePrompt(opts.query, hits, memory, verifiedAnswer);

  // Persist user message before streaming, so a crash mid-stream still leaves
  // the question in history.
  appendMessage(db, {
    sessionId: opts.sessionId,
    role: "user",
    content: opts.query,
  });

  // 5. Stream chat
  let assistantText = "";
  // Provider-reported token usage arrives on the final chunk (see ChatChunk.usage).
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  try {
    for await (const chunk of chat.chat(messages, {
      model: opts.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      signal: opts.signal,
    })) {
      if (chunk.delta) {
        assistantText += chunk.delta;
        yield { phase: "delta", delta: chunk.delta };
      }
      if (chunk.usage) {
        if (typeof chunk.usage.inputTokens === "number") tokensIn = chunk.usage.inputTokens;
        if (typeof chunk.usage.outputTokens === "number") tokensOut = chunk.usage.outputTokens;
      }
    }
  } catch (err) {
    yield {
      phase: "error",
      message: `chat failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  const citationChunkIds = hits.map((h) => h.chunkId);
  const durationMs = Date.now() - start;

  // 6. Persist + audit
  const assistantMessageId = appendMessage(db, {
    sessionId: opts.sessionId,
    role: "assistant",
    content: assistantText,
    citations: citationChunkIds,
    provider: chat.id,
    ...(opts.model ? { model: opts.model } : {}),
    ...(tokensIn !== null ? { tokensIn } : {}),
    ...(tokensOut !== null ? { tokensOut } : {}),
    latencyMs: durationMs,
  });

  appendAudit(db, "query", {
    sessionId: opts.sessionId,
    query: opts.query,
    provider: chat.id,
    model: opts.model ?? null,
    retrievedChunkIds: citationChunkIds,
    promptTokens: estimateTokens(messages.map((m) => m.content).join("\n")),
    completionLength: assistantText.length,
    durationMs,
  });

  yield {
    phase: "done",
    sessionId: opts.sessionId,
    assistantMessageId,
    tokenCounts: { in: tokensIn, out: tokensOut },
    provider: chat.id,
    model: opts.model ?? null,
    durationMs,
    citationChunkIds,
    verifiedAnswerUsed: Boolean(verifiedAnswer),
  };
}

/** Rough token estimate: ~4 chars per token. Good enough for audit display. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
