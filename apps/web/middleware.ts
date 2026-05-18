import { NextResponse, type NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";

/**
 * Edge-runnable auth gate for all /api/* routes.
 *
 * Loopback binding → trusts the caller (no bearer required).
 * LAN binding → requires `Authorization: Bearer <token>` matching ~/.mnemos/auth.key.
 *
 * See apps/web/lib/auth.ts for the trust-model rationale.
 *
 * Note: Next middleware runs in the Edge runtime by default, which doesn't
 * have access to node:fs. We force Node runtime here so we can read the
 * auth.key file. This keeps the auth check at the perimeter (one place),
 * not duplicated across every route.
 */
export const config = {
  matcher: ["/api/:path*"],
  runtime: "nodejs",
};

const PUBLIC_API_PATHS = new Set<string>([
  // Allow the UI to read the token endpoint without already having it.
  // The endpoint itself is loopback-gated server-side (it refuses to return
  // the value if bind != loopback), so this allowlist entry is a no-op when
  // the broader auth gate would also have admitted the request.
  "/api/auth/token",
  // Health is intentionally public — load balancers and uptime checks need
  // a no-auth ping. It returns no sensitive data.
  "/api/health",
]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next();
  const denial = authorizeRequest(req.headers);
  if (denial) {
    return NextResponse.json(
      { error: "unauthorized", message: denial },
      { status: 401 },
    );
  }
  return NextResponse.next();
}
