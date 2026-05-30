import { join } from "node:path";
import { checkSecurityExclusion } from "@mnemos/core";

export type BrowseEntry = {
  name: string;
  absPath: string;
  isDir: boolean;
};

/**
 * Filter + order a directory's raw entries for the folder picker.
 *
 * - **Hidden** entries (dotfiles/dotdirs) are dropped — they're almost never a
 *   source, and hiding them keeps credential-bearing config dirs (`.ssh`,
 *   `.gnupg`, `.config`) off the screen by default.
 * - **Security hard-locks** are dropped outright: the picker must never offer a
 *   credential file/dir as selectable, reusing the same predicate the ingest
 *   pipeline uses to refuse them. (`.aws`/`.ssh`-style credential dirs are
 *   dotdirs already removed by the hidden filter above; the hard-lock catches
 *   the non-hidden ones — `credentials`, `id_rsa`, `*.pem`/`*.key`/`*.crt`.)
 * - Sorted directories-first, then case-insensitive alphabetical, so navigation
 *   reads like a normal file browser.
 */
export function filterBrowseEntries(
  dirPath: string,
  raw: Array<{ name: string; isDir: boolean }>,
): BrowseEntry[] {
  const out: BrowseEntry[] = [];
  for (const e of raw) {
    if (e.name.startsWith(".")) continue;
    const absPath = join(dirPath, e.name);
    if (checkSecurityExclusion(absPath)) continue;
    out.push({ name: e.name, absPath, isDir: e.isDir });
  }
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return out;
}
