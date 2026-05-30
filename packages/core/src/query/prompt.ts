/**
 * RAG prompt assembly.
 *
 * Concatenates retrieved chunks + conversation memory + the user's question
 * into a single prompt that gets fed to the chat provider. The shape is
 * provider-agnostic — Mnemos's ChatMessage[] format works with Anthropic,
 * OpenAI, Gemini, Ollama, and llama.cpp.
 *
 * Design decisions:
 * - Numbered chunks ([1], [2], ...) so the model can cite consistently
 * - System message includes the "use ONLY this context" guard
 * - User question is LAST in the messages array (most-attended position)
 * - Conversation memory is interleaved as alternating user/assistant turns
 */

import type { ChatMessage } from "@mnemos/plugin-sdk";
import type { SearchHit } from "@mnemos/db";

export type AssembledPrompt = {
  messages: ChatMessage[];
  citationMap: Map<number, SearchHit>;
};

const SYSTEM_PROMPT = `You are Mnemos, a personal RAG assistant with access to the user's own files.

Use ONLY the retrieved context below to answer the user's question. The retrieved chunks are numbered [1], [2], etc. When you draw on a chunk, cite it inline as [N]. If the retrieved context doesn't contain the answer, say so explicitly — do not fabricate facts.

Each chunk header lists the source file path, when it was last modified, and the file type. **Use this metadata when answering "when", "where", or "what kind" questions** — e.g. if the user asks when something happened, the file's modified-date is your strongest signal even if the body text doesn't contain a date. If the user asks for a list (companies, items, etc.), enumerate from the chunks rather than answering with a single citation.

You can quote short passages from the context verbatim. Prefer direct quotes over paraphrase when the original wording is precise (file paths, code, numbers, names).

If multiple chunks contradict each other, surface the contradiction rather than picking one silently.`;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatDate(epochMs: number): string {
  if (!epochMs) return "unknown";
  const d = new Date(epochMs);
  // YYYY-MM-DD — terse, ISO-compatible, language-neutral. Models parse this reliably.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function assemblePrompt(
  userQuery: string,
  retrievedChunks: SearchHit[],
  conversationMemory: ChatMessage[],
  verifiedAnswer?: { question: string; answer: string },
): AssembledPrompt {
  const citationMap = new Map<number, SearchHit>();
  const contextLines: string[] = [];

  retrievedChunks.forEach((hit, idx) => {
    const ref = idx + 1;
    citationMap.set(ref, hit);
    const truncatedText = hit.text.length > 1200 ? `${hit.text.slice(0, 1200)}…` : hit.text;
    // Header surfaces: file path, last-modified date, loader (file kind), and
    // size. The chars-offset range stays for citation context but is labeled
    // "chars" not "lines" — the offsets are byte positions in the source text,
    // not line numbers (chunker.ts:14-15, 39-73 confirm this).
    contextLines.push(
      `[${ref}] ${hit.filePath} · modified ${formatDate(hit.fileMtime)} · ${hit.loader} · ${formatFileSize(hit.fileSizeBytes)} · chars ${hit.startOffset}-${hit.endOffset}`,
      truncatedText,
      "",
    );
  });

  const contextBlock =
    contextLines.length > 0
      ? `== Retrieved Context ==\n${contextLines.join("\n")}`
      : `== Retrieved Context ==\n(No relevant chunks found in the indexed sources for this query.)`;

  // A previously operator-verified answer for a similar question — placed above
  // the retrieved context so even a small model reads the confirmed fact, while
  // still being told to verify against the chunks and cite.
  const verifiedBlock = verifiedAnswer
    ? `== Verified Answer (the user previously confirmed this for a closely-matching question) ==\nQ: ${verifiedAnswer.question}\nA: ${verifiedAnswer.answer}\n\nTreat this as authoritative for the matching fact. Still cross-check the retrieved context and cite sources.\n\n`
    : "";

  const messages: ChatMessage[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n${verifiedBlock}${contextBlock}` },
    // Only past turns from this session (skip the current user turn — added below)
    ...conversationMemory.filter((m) => m.role !== "system"),
    { role: "user", content: userQuery },
  ];

  return { messages, citationMap };
}
