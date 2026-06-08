/**
 * Surface-agnostic helpers shared by File Focus Mode across the web chat, the
 * Telegram poller, and the query route — so the three never drift on what
 * "metadata-only" means or how a session is titled.
 */

import { fileContentChars, getFileLocation } from "@mnemos/db";
import { getDb } from "./runtime";

// Below this many characters of indexed content, a file is "metadata-only" — no
// readable text was extracted (e.g. a scanned PDF, or an unsupported type).
export const META_ONLY_CHARS = 20;

export function isMetadataOnly(fileId: number): boolean {
  return fileContentChars(getDb(), fileId) < META_ONLY_CHARS;
}

/** Honest, located explanation when a focused file has no readable text. */
export function metadataOnlyText(fileId: number, name: string): string {
  const loc = getFileLocation(getDb(), fileId);
  const where = loc ? `\nLocation: ${loc.fullPath}` : "";
  const reason = /\.pdf$/i.test(name)
    ? "Even OCR found no readable text — it may be a blank or very low-quality scan."
    : "No text could be extracted for this file type.";
  return `📄 I only have metadata for "${name}" — no readable text is indexed.${where}\n${reason}\nReindex to try extracting it again (PDFs run OCR).`;
}

/** Truncate a user query into a sidebar-friendly session title. Cuts on a word
 * boundary near 50 chars and strips trailing punctuation. Shared so a Telegram
 * thread is titled by its first question exactly like a web thread. */
export function titleFromQuery(q: string): string {
  const cleaned = q.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 50) return cleaned;
  const truncated = cleaned.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated;
  return cut.replace(/[.,;:!?-]+$/, "") + "…";
}
