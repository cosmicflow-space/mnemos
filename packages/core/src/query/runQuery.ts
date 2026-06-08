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
  countChunksForFile,
  getCorpusStats,
  type MnemosDb,
  type SearchHit,
} from "@mnemos/db";
import type {
  ChatProvider,
  ChatMessage,
  EmbeddingProvider,
} from "@mnemos/plugin-sdk";
import { assemblePrompt, assembleDirectPrompt } from "./prompt";

/**
 * Count/inventory intent — questions about the library as a whole rather than
 * its contents. Only these get the (whole-index) corpus stats injected, so
 * normal queries pay no aggregate-query latency and carry no source paths in
 * their prompt. Conservative: a miss just falls back to retrieved-context.
 */
export function isInventoryQuestion(query: string): boolean {
  return /\bhow many\b|\bhow much\b|\bnumber of\b|\bcount\b|\btotal\b|\binventory\b|\bwhat (kind|type)s? of\b|\bwhich (source|folder|file|document)s?\b|\blist (all |my |the )*(file|document|source)s\b/i.test(
    query,
  );
}

/** Strip control chars/newlines and cap length before putting an indexed path
 * into the prompt — keeps untrusted path text out of the high-priority system
 * block as an instruction-injection vector, and bounds prompt size. */
function sanitizeForPrompt(s: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
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
        /** The file this chunk belongs to — lets a caller offer `/focus <n>` on a cited source. */
        fileId: number;
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
      /** True when this was a direct-to-model query (`!` prefix) — no retrieval. */
      direct: boolean;
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
  /** Direct-to-model mode (`!` prefix): skip embed + retrieval + verified/corpus
   * injection. The model answers from its own knowledge + conversation memory,
   * plus a session-facts note. No document content leaves the machine. */
  direct?: boolean;
  /** File Focus Mode: scope retrieval to these file ids only. A small focused
   * file is loaded WHOLE (all content chunks, in order) so summarize/explore
   * work; a large one falls back to vector search within it. Ignored in `direct`
   * mode (which bypasses retrieval entirely). */
  scopeFileIds?: number[];
};

// In focus mode, load the whole file when its content fits this many chunks
// (~8–16k tokens for typical chunk sizes); above it, scope vector search instead.
const FOCUS_WHOLE_FILE_BUDGET = 40;

export async function* runQuery(
  db: MnemosDb,
  // Null in direct mode: retrieval is skipped, so callers must be able to run a
  // `!` query even when the embedder is missing or still warming up. The RAG
  // path guards for non-null below.
  embedder: EmbeddingProvider | null,
  chat: ChatProvider,
  opts: RunQueryOptions,
): AsyncGenerator<QueryEvent, void, unknown> {
  const start = Date.now();
  const topK = opts.topK ?? 8;
  const memoryTurns = opts.maxMemoryTurns ?? 10;

  // Direct-to-model mode: the user opted out of retrieval for this message
  // (`!` prefix). Skip embed/search/verified/corpus entirely — answer from
  // conversation memory + a session-facts note. Emits an empty `retrieved` set
  // so every channel renders "no sources"; the shared tail audits direct:true
  // with [] chunks, keeping it provably distinct from a RAG query.
  if (opts.direct) {
    const memory = getRecentMessages(db, opts.sessionId, memoryTurns).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    // `opts.model` is client-provided — sanitize before interpolating into the
    // system prompt so a crafted model name (newlines / fake instructions) can't
    // smuggle text into the high-priority block. Provider id/name are static
    // registry constants. (Found in partner review.)
    const sessionFacts = `Active chat provider: ${chat.displayName} (id: ${chat.id}). Active model: ${opts.model ? sanitizeForPrompt(opts.model, 80) : "the provider's default"}.`;
    const { messages } = assembleDirectPrompt(opts.query, memory, sessionFacts);
    yield { phase: "retrieved", hits: [] };
    yield* streamAndPersist(db, chat, messages, [], undefined, opts, start);
    return;
  }

  // File Focus Mode: retrieval is scoped to the chosen file(s). A small focused
  // file is loaded WHOLE (every content chunk, in order) so "summarize this" /
  // "what does it say about X" work; a large one falls back to vector search
  // WITHIN the file. No metadata-expansion, corpus, or verified-answer injection —
  // the answer comes only from the focused file(s). Whole-file load needs no
  // embedder, so this runs before the embedder guard below.
  if (opts.scopeFileIds && opts.scopeFileIds.length > 0) {
    const ids = opts.scopeFileIds;
    const totalContent = ids.reduce((n, id) => n + countChunksForFile(db, id), 0);
    let hits: SearchHit[] = [];

    if (totalContent > 0 && totalContent <= FOCUS_WHOLE_FILE_BUDGET) {
      hits = ids.flatMap((id) => getContentChunksForFile(db, id, FOCUS_WHOLE_FILE_BUDGET, 0));
    } else {
      // Large (or unknown-size) focused file: scope vector search to it. Retrieve
      // wide globally, then keep only the focused file's chunks. Needs the embedder.
      if (!embedder) {
        yield { phase: "error", message: "Embedder unavailable — /done to leave focus and ask directly with !." };
        return;
      }
      let qv: number[];
      try {
        const [v] = await embedder.embed([opts.query]);
        if (!v) throw new Error("Embedder returned empty vector");
        qv = v;
      } catch (err) {
        yield { phase: "error", message: `embed failed: ${err instanceof Error ? err.message : String(err)}` };
        return;
      }
      const idset = new Set(ids);
      hits = vecSearch(db, qv, Math.max(topK * 6, 48)).filter((h) => idset.has(h.fileId)).slice(0, topK);
      // Query unrelated to the file's content → fall back to the file's opening chunks
      // so there's always grounded context to answer/summarize from.
      if (hits.length === 0) hits = ids.flatMap((id) => getContentChunksForFile(db, id, topK, 0));
    }

    yield {
      phase: "retrieved",
      hits: hits.map((h, idx) => ({
        ref: idx + 1,
        chunkId: h.chunkId,
        fileId: h.fileId,
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

    const focusMemory = getRecentMessages(db, opts.sessionId, memoryTurns).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const { messages } = assemblePrompt(opts.query, hits, focusMemory, undefined, undefined);
    yield* streamAndPersist(db, chat, messages, hits, undefined, opts, start);
    return;
  }

  // RAG path needs the embedder. Entrypoints only pass null in direct mode
  // (handled above), but guard so a missing embedder fails cleanly with a hint.
  if (!embedder) {
    yield {
      phase: "error",
      message: "Embedder unavailable — retrieval can't run. Prefix your message with ! to ask the model directly.",
    };
    return;
  }

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
  // When a file surfaced ONLY via its metadata chunk, splice that file's content
  // chunks in *immediately after* the metadata hit (not at the tail — so the
  // answer isn't re-buried late in the prompt), bounded by a fixed budget so a
  // high topK can't balloon prompt size.
  const filesWithContent = new Set(
    hits.filter((h) => h.ordinal >= 0).map((h) => h.fileId),
  );
  const seenChunks = new Set(hits.map((h) => h.chunkId));
  const expandedFiles = new Set<number>();
  const PER_FILE_CONTENT = 3;
  let injectBudget = 6; // total content chunks pulled in, independent of topK
  const expanded: SearchHit[] = [];
  for (const h of hits) {
    expanded.push(h);
    if (
      injectBudget <= 0 ||
      h.ordinal !== -1 ||
      filesWithContent.has(h.fileId) ||
      expandedFiles.has(h.fileId)
    ) {
      continue;
    }
    expandedFiles.add(h.fileId);
    const want = Math.min(PER_FILE_CONTENT, injectBudget);
    for (const c of getContentChunksForFile(db, h.fileId, want, h.distance)) {
      if (seenChunks.has(c.chunkId)) continue;
      seenChunks.add(c.chunkId);
      expanded.push(c); // adjacent to the metadata hit that pulled it in
      injectBudget -= 1;
      if (injectBudget <= 0) break;
    }
  }
  hits = expanded;

  // Emit citations early so the UI can show "looking at 8 chunks..." before
  // the model starts producing text. UX win when the model is slow to first token.
  yield {
    phase: "retrieved",
    hits: hits.map((h, idx) => ({
      ref: idx + 1,
      chunkId: h.chunkId,
      fileId: h.fileId,
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

  // 4. Assemble prompt.
  // For count/inventory questions ONLY, inject whole-index totals (COUNT-based,
  // not derived from `hits`) so "how many files/documents do I have" is answered
  // from the truth instead of the top-K that matched. Gated so normal queries
  // pay no aggregate-query latency and carry no source paths in their prompt.
  let corpusFacts: string | undefined;
  if (isInventoryQuestion(opts.query)) {
    const stats = getCorpusStats(db);
    const typeSummary = stats.byType
      .slice(0, 6)
      .map((t) => `${t.fileCount} ${t.loader}`)
      .join(", ");
    const sourceSummary = stats.sources
      .slice(0, 5)
      .map((s) => `${sanitizeForPrompt(s.path)} (${s.fileCount} files)`)
      .join("; ");
    corpusFacts =
      `${stats.totalFiles} files, ${stats.totalChunks} chunks across ${stats.sources.length} source(s).` +
      (typeSummary ? ` By file type: ${typeSummary}.` : "") +
      (sourceSummary
        ? ` Sources: ${sourceSummary}${stats.sources.length > 5 ? ", …" : ""}.`
        : "");
  }

  const { messages } = assemblePrompt(opts.query, hits, memory, verifiedAnswer, corpusFacts);

  yield* streamAndPersist(db, chat, messages, hits, verifiedAnswer, opts, start);
}

/**
 * Shared tail for both the RAG and direct paths: persist the user turn, stream
 * the chat provider, persist the assistant turn, append the audit event, and
 * emit `done`. Keeping this in one place means direct mode and RAG mode can't
 * drift in how they record token usage, citations, or audit data.
 *
 * `hits` is the retrieved set — empty in direct mode, so citationChunkIds and
 * the audit's retrievedChunkIds are both `[]`. `opts.direct` flows into the
 * audit + done events so a direct query is provably distinct from a RAG one.
 */
async function* streamAndPersist(
  db: MnemosDb,
  chat: ChatProvider,
  messages: ChatMessage[],
  hits: SearchHit[],
  verifiedAnswer: { question: string; answer: string } | undefined,
  opts: RunQueryOptions,
  start: number,
): AsyncGenerator<QueryEvent, void, unknown> {
  // Persist user message before streaming, so a crash mid-stream still leaves
  // the question in history. Tag it with `direct` too so the *whole* turn (both
  // rows) is marked — keeps the column meaningful for export/replay, not just
  // the assistant row the UI badges.
  appendMessage(db, {
    sessionId: opts.sessionId,
    role: "user",
    content: opts.query,
    direct: opts.direct ?? false,
  });

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

  // Persist + audit
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
    direct: opts.direct ?? false,
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
    direct: opts.direct ?? false,
    ...(opts.scopeFileIds?.length ? { focusFileIds: opts.scopeFileIds } : {}),
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
    direct: opts.direct ?? false,
  };
}

/** Rough token estimate: ~4 chars per token. Good enough for audit display. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
