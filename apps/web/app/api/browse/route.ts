import { NextResponse } from "next/server";
import { readdir, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { isLoopbackBind } from "@/lib/auth";
import { normalizeUserPath } from "@/lib/user-path";
import { filterBrowseEntries } from "@/lib/browse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ENTRIES = 1000;

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
    const real = await realpath(requested);
    const st = await stat(real);
    // A file was passed (e.g. the picker re-opened on a selected file): list its
    // containing directory so the user lands somewhere navigable.
    const targetDir = st.isDirectory() ? real : dirname(real);

    const dirents = await readdir(targetDir, { withFileTypes: true });
    const resolved = await Promise.all(
      dirents.map(async (d) => {
        if (d.isSymbolicLink()) {
          // Resolve the link target's type so a symlinked dir stays navigable;
          // a broken link resolves to nothing and is dropped.
          try {
            return { name: d.name, isDir: (await stat(join(targetDir, d.name))).isDirectory() };
          } catch {
            return null;
          }
        }
        return { name: d.name, isDir: d.isDirectory() };
      }),
    );
    const raw = resolved.filter((e): e is { name: string; isDir: boolean } => e !== null);
    const entries = filterBrowseEntries(targetDir, raw).slice(0, MAX_ENTRIES);
    const root = parse(targetDir).root;

    return NextResponse.json({
      path: targetDir,
      parent: targetDir === root ? null : dirname(targetDir),
      home: homedir(),
      entries,
      truncated: raw.length > MAX_ENTRIES,
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
