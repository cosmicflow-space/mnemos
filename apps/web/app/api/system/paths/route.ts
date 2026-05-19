import { homedir, platform } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns platform-appropriate filesystem paths for the Sources UI so users
 * see paths that look right on their OS.
 *
 * The original UI hardcoded `~/Documents`, `~/Downloads`, etc. — Unix tilde
 * notation that's meaningless on Windows. This endpoint resolves the actual
 * home directory and produces a portable set of common locations + a
 * representative input placeholder. On macOS/Linux: `/Users/<name>/...` or
 * `/home/<name>/...`. On Windows: `C:\Users\<Name>\...`.
 *
 * No auth required beyond the usual /api/* gate (loopback bypass / LAN
 * bearer). The response leaks the user's home directory path, which is
 * private-on-loopback and gated-on-LAN.
 */
export async function GET() {
  const home = homedir();
  const plat = platform();

  // Common folders most users have. Some are platform-specific (Public on
  // Windows isn't the same path everywhere) — keep the list to the universal
  // four and let users type their own anywhere else.
  const labels = ["Documents", "Downloads", "Desktop", "Notes"];
  const common = labels.map((label) => ({
    label,
    path: join(home, label),
  }));

  return Response.json({
    platform: plat,
    homedir: home,
    // Representative placeholder for the path input. Uses Documents because
    // it exists by default on all three platforms.
    placeholder: join(home, "Documents", "notes"),
    common,
  });
}
