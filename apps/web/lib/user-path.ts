import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Normalize a user-supplied filesystem path before it touches `resolve()`.
 *
 * macOS Finder's "Copy as Pathname" (and dragging a file into a quoted shell
 * context) wraps paths containing spaces or special characters — e.g. iCloud's
 * `~/Library/Mobile Documents/com~apple~CloudDocs/…` — in single quotes. Users
 * paste that verbatim, and an un-stripped leading quote turns an absolute path
 * into a *relative* one: `resolve()` then prepends the server's cwd, producing a
 * path that doesn't exist and a source that silently ingests nothing.
 *
 * Strips one layer of matching surrounding quotes (single or double), then
 * expands a leading `~` and resolves to absolute. A genuine path whose name both
 * begins and ends with a quote is vanishingly rare; the paste-artifact case is
 * common, so we optimize for it.
 */
export function normalizeUserPath(input: string): string {
  let p = input.trim();
  if (p.length >= 2) {
    const first = p[0];
    const last = p[p.length - 1];
    if ((first === "'" || first === '"') && last === first) {
      p = p.slice(1, -1).trim();
    }
  }
  if (p.startsWith("~/") || p === "~") {
    return resolve(p.replace(/^~/, homedir()));
  }
  return resolve(p);
}
