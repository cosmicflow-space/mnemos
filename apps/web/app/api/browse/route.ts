import { NextResponse } from "next/server";
import { readdir, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { checkSecurityExclusion } from "@mnemos/core";
import { isLoopbackBind } from "@/lib/auth";
import { normalizeUserPath } from "@/lib/user-path";
import { filterBrowseEntries } from "@/lib/browse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ENTRIES = 1000;
// Bound concurrent stat()s when resolving symlink entries, so a directory with
// thousands of symlinks can't exhaust file descriptors (EMFILE).
const STAT_CONCURRENCY = 32;

/** A directory is credential-hard-locked if it (or anything it contains) matches
 * a security pattern. Test both the bare path and a trailing-slash form so the
 * `.ssh/`/`.aws/` (slash-anchored) and `credentials`/`id_rsa` (end-anchored)
 * patterns both fire. */
function isHardLockedDir(absDir: string): boolean {
  return Boolean(checkSecurityExclusion(absDir) || checkSecurityExclusion(`${absDir}/`));
}

/** Resolve raw dirents to {name,isDir} in bounded-concurrency batches. Symlinks
 * are followed to their real target: a broken link is dropped, and a link whose
 * target is a credential file/dir is dropped so an innocuous alias can't expose
 * (or later be picked to ingest) a secret. */
async function resolveEntries(
  dir: string,
  dirents: Array<{ name: string; isDir: boolean; isSymlink: boolean }>,
): Promise<Array<{ name: string; isDir: boolean }>> {
  const out: Array<{ name: string; isDir: boolean }> = [];
  for (let i = 0; i < dirents.length; i += STAT_CONCURRENCY) {
    const batch = await Promise.all(
      dirents.slice(i, i + STAT_CONCURRENCY).map(async (d) => {
        if (!d.isSymlink) return { name: d.name, isDir: d.isDir };
        try {
          const real = await realpath(join(dir, d.name));
          if (checkSecurityExclusion(real) || isHardLockedDir(real)) return null;
          return { name: d.name, isDir: (await stat(real)).isDirectory() };
        } catch {
          return null; // broken link
        }
      }),
    );
    for (const e of batch) if (e) out.push(e);
  }
  return out;
}

/**
 * GET /api/browse?path=<dir>
 *
 * Lists a directory's immediate entries (folders + files) with absolute paths,
 * so the UI can offer a server-powered folder/file picker — the browser can't
 * hand JS an absolute path, but the local server can. Defaults to the home dir.
 *
 * Security: filesystem browsing is a broader exposure than the query-only API,
 * so it is disabled entirely unless the server is loopback-bound. Credential
 * files/dirs are hard-locked out of the listing (see lib/browse), and hidden
 * entries are omitted. Read-only — never mutates the filesystem.
 */
export async function GET(req: Request) {
  if (!isLoopbackBind()) {
    return NextResponse.json(
      {
        error: "browse_disabled",
        message:
          "Filesystem browsing is disabled when Mnemos is bound to LAN. Paste an absolute path instead.",
      },
      { status: 403 },
    );
  }

  const rawPath = new URL(req.url).searchParams.get("path");
  let requested: string;
  try {
    requested = rawPath && rawPath.trim() ? normalizeUserPath(rawPath) : homedir();
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "path is empty" }, { status: 400 });
  }

  try {
    // realpath canonicalizes the whole path, so a symlink alias to a credential
    // dir (~/Documents/secrets -> ~/.ssh) resolves to its true target here.
    const real = await realpath(requested);
    const st = await stat(real);
    // A file was passed (e.g. the picker re-opened on a selected file): list its
    // containing directory so the user lands somewhere navigable.
    const targetDir = st.isDirectory() ? real : dirname(real);

    // Refuse to list a credential directory even via a direct/aliased request —
    // the entry filter only guards children, not the container itself.
    if (isHardLockedDir(targetDir)) {
      return NextResponse.json(
        { error: "permission_denied", message: "That directory is protected and can't be browsed." },
        { status: 403 },
      );
    }

    const dirents = await readdir(targetDir, { withFileTypes: true });
    const raw = await resolveEntries(
      targetDir,
      dirents.map((d) => ({ name: d.name, isDir: d.isDirectory(), isSymlink: d.isSymbolicLink() })),
    );
    const filtered = filterBrowseEntries(targetDir, raw);
    const root = parse(targetDir).root;

    return NextResponse.json({
      path: targetDir,
      parent: targetDir === root ? null : dirname(targetDir),
      home: homedir(),
      entries: filtered.slice(0, MAX_ENTRIES),
      truncated: filtered.length > MAX_ENTRIES,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return NextResponse.json({ error: "not_found", message: "That path doesn't exist." }, { status: 404 });
    }
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "permission_denied", message: "Permission denied for that path." }, { status: 403 });
    }
    if (code === "ENOTDIR") {
      return NextResponse.json({ error: "not_a_directory", message: "That path is not a directory." }, { status: 400 });
    }
    return NextResponse.json(
      { error: "browse_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
