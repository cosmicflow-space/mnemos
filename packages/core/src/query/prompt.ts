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

You can quote short passages from the context verbatim. Prefer direct quotes over paraphrase when the original wording is precise (file paths, code, numbers, names).

If multiple chunks contradict each other, surface the contradiction rather than picking one silently.`;

export function assemblePrompt(
  userQuery: string,
  retrievedChunks: SearchHit[],
  conversationMemory: ChatMessage[],
): AssembledPrompt {
  const citationMap = new Map<number, SearchHit>();
  const contextLines: string[] = [];

  retrievedChunks.forEach((hit, idx) => {
    const ref = idx + 1;
    citationMap.set(ref, hit);
    const truncatedText = hit.text.length > 1200 ? `${hit.text.slice(0, 1200)}…` : hit.text;
    contextLines.push(
      `[${ref}] ${hit.filePath} (lines ~${hit.startOffset}-${hit.endOffset})`,
      truncatedText,
      "",
    );
  });

  const contextBlock =
    contextLines.length > 0
      ? `== Retrieved Context ==\n${contextLines.join("\n")}`
      : `== Retrieved Context ==\n(No relevant chunks found in the indexed sources for this query.)`;

  const messages: ChatMessage[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n${contextBlock}` },
    // Only past turns from this session (skip the current user turn — added below)
    ...conversationMemory.filter((m) => m.role !== "system"),
    { role: "user", content: userQuery },
  ];

  return { messages, citationMap };
}
