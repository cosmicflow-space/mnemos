/**
 * Recursive character text splitter.
 *
 * Splits long text into ~chunkSize character pieces, preferring breaks at
 * larger separators (paragraph, line, sentence) before falling back to word
 * and character boundaries.
 *
 * Character-based rather than token-based because:
 *   - No tokenizer dependency
 *   - Stable across all embedding providers
 *   - For BGE-small (default), ~1000 chars maps to ~250-300 tokens which is
 *     well within the model's window
 *
 * Offsets returned are byte positions in the source text. Overlap is approximate
 * in v0.1 — exact-byte overlap is over-engineered for personal-RAG retrieval.
 */

export type ChunkResult = {
  text: string;
  startOffset: number;
  endOffset: number;
  ordinal: number;
};

export type ChunkerOptions = {
  /** Target chunk size in characters. Default 1000. */
  chunkSize?: number;
  /** Approximate overlap between consecutive chunks. Default 200. */
  chunkOverlap?: number;
  /**
   * Separators ranked from largest preferred to smallest fallback.
   * Default: paragraph break, line break, sentence end, word, character.
   */
  separators?: readonly string[];
};

const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " ", ""] as const;

export function chunkText(
  text: string,
  opts: ChunkerOptions = {},
): ChunkResult[] {
  const chunkSize = opts.chunkSize ?? 1000;
  const chunkOverlap = opts.chunkOverlap ?? 200;
  const separators = opts.separators ?? DEFAULT_SEPARATORS;

  if (text.length === 0) return [];
  if (text.length <= chunkSize) {
    return [
      { text, startOffset: 0, endOffset: text.length, ordinal: 0 },
    ];
  }

  const pieces = recursiveSplit(text, separators, chunkSize);
  const merged = mergeWithOverlap(pieces, chunkSize, chunkOverlap);

  // Walk the source text to assign offsets. Each merged chunk should appear
  // verbatim in the original (modulo overlap-induced repeats), so we scan
  // forward from the last cursor.
  const out: ChunkResult[] = [];
  let cursor = 0;
  let ordinal = 0;
  for (const piece of merged) {
    if (piece.length === 0) continue;
    const startSearch = Math.max(0, cursor - chunkOverlap);
    const idx = text.indexOf(piece, startSearch);
    const startOffset = idx >= 0 ? idx : cursor;
    const endOffset = startOffset + piece.length;
    out.push({ text: piece, startOffset, endOffset, ordinal });
    cursor = endOffset - chunkOverlap;
    ordinal += 1;
  }
  return out;
}

function recursiveSplit(
  text: string,
  separators: readonly string[],
  chunkSize: number,
): string[] {
  if (text.length <= chunkSize) return [text];
  if (separators.length === 0) {
    // Hard split by chunkSize when no separator works
    const out: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      out.push(text.slice(i, i + chunkSize));
    }
    return out;
  }

  const sep = separators[0] ?? "";
  const rest = separators.slice(1);

  if (sep.length === 0) {
    return recursiveSplit(text, rest, chunkSize);
  }

  const parts = text.split(sep);
  if (parts.length === 1) {
    return recursiveSplit(text, rest, chunkSize);
  }

  const out: string[] = [];
  for (const part of parts) {
    if (part.length <= chunkSize) {
      out.push(part);
    } else {
      out.push(...recursiveSplit(part, rest, chunkSize));
    }
  }
  return out;
}

function mergeWithOverlap(
  pieces: string[],
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    out.push(buffer.join(""));
    if (chunkOverlap > 0 && buffer.length > 0) {
      // Carry the tail of the just-flushed buffer into the next buffer
      const tail: string[] = [];
      let tailLen = 0;
      for (let i = buffer.length - 1; i >= 0; i -= 1) {
        const piece = buffer[i];
        if (!piece) continue;
        tailLen += piece.length;
        tail.unshift(piece);
        if (tailLen >= chunkOverlap) break;
      }
      buffer = tail;
      bufferLen = tailLen;
    } else {
      buffer = [];
      bufferLen = 0;
    }
  };

  for (const piece of pieces) {
    if (piece.length === 0) continue;
    if (bufferLen + piece.length > chunkSize && bufferLen > 0) {
      flush();
    }
    buffer.push(piece);
    bufferLen += piece.length;
    if (bufferLen >= chunkSize) {
      flush();
    }
  }
  if (buffer.length > 0) {
    out.push(buffer.join(""));
  }
  return out;
}
