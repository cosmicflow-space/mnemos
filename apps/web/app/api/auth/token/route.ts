import { NextResponse } from "next/server";
import { getAuthToken, isLoopbackBind, tokenFingerprint } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/auth/token
 *
 * Returns the bearer token so the local UI can attach it to subsequent
 * requests. Only returns the full token when the server is bound to loopback
 * (i.e. the caller is provably on the same machine). Under LAN binding, the
 * full value is withheld — callers must read it themselves from
 * `~/.mnemos/auth.key` (chmod 600) or via the CLI.
 */
export function GET() {
  const loopback = isLoopbackBind();
  if (!loopback) {
    return NextResponse.json(
      {
        bind: "lan",
        fingerprint: tokenFingerprint(),
        message: "Server bound to LAN. Read ~/.mnemos/auth.key on the host to retrieve the full token.",
      },
      { status: 200 },
    );
  }
  return NextResponse.json({
    bind: "loopback",
    token: getAuthToken(),
    fingerprint: tokenFingerprint(),
  });
}
