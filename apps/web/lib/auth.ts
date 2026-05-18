/**
 * Bearer-token auth for the /api/* surface.
 *
 * Trust model (single-user, single-machine):
 *   - When bound to loopback (127.0.0.1, ::1) the API trusts the caller
 *     because anyone reaching the loopback interface is already on the user's
 *     own machine. No bearer required. This matches the developer-experience
 *     contract — `curl http://127.0.0.1:3030/api/health` Just Works.
 *   - When bound to LAN or any non-loopback interface (set via
 *     `MNEMOS_BIND=lan` or `MNEMOS_BIND=0.0.0.0`), every /api/* request
 *     MUST carry an `Authorization: Bearer <token>` header that matches the
 *     value at `~/.mnemos/auth.key`.
 *   - The token is auto-generated on first read of `getAuthToken()` and
 *     chmod 600 on POSIX. The user can also override via `MNEMOS_AUTH_TOKEN`.
 *
 * The token is also returned by `GET /api/auth/token` so the local UI can
 * fetch it once and attach it to every subsequent request when running under
 * LAN binding.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

function stateDir(): string {
  return process.env.MNEMOS_STATE_DIR ?? join(homedir(), ".mnemos");
}

function tokenFilePath(): string {
  return join(stateDir(), "auth.key");
}

/** Generate or read the auth token. Idempotent. Token format: 48 hex chars. */
export function getAuthToken(): string {
  // Highest precedence: explicit env var.
  const envToken = process.env.MNEMOS_AUTH_TOKEN?.trim();
  if (envToken) return envToken;

  const path = tokenFilePath();
  if (existsSync(path)) {
    try {
      const v = readFileSync(path, "utf8").trim();
      if (v.length > 0) return v;
    } catch {
      // fall through to regenerate
    }
  }

  // Generate fresh, persist with restrictive perms.
  const token = randomBytes(24).toString("hex");
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, token + "\n");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX (Windows) — file ACLs handle confidentiality.
  }
  return token;
}

/** Returns true if the configured bind is a loopback address. */
export function isLoopbackBind(): boolean {
  const bind = (process.env.MNEMOS_BIND ?? "127.0.0.1").trim().toLowerCase();
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1" || bind === "loopback";
}

/**
 * Decide whether to admit a request. Returns null on allow, or an error
 * message string on deny. Pure function so it's easy to test and call from
 * middleware OR per-route guards.
 */
export function authorizeRequest(headers: Headers): string | null {
  if (isLoopbackBind()) return null; // trust the loopback
  const auth = headers.get("authorization") ?? headers.get("Authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    return "Missing Authorization: Bearer <token> header (required when binding to LAN).";
  }
  const presented = auth.slice("Bearer ".length).trim();
  if (!presented) return "Empty bearer token.";
  const expected = getAuthToken();
  if (presented !== expected) return "Invalid bearer token.";
  return null;
}

/** Returns last-4 fingerprint for UI display — never reveal the full token. */
export function tokenFingerprint(): string {
  const t = getAuthToken();
  return t.length <= 4 ? "•".repeat(t.length) : "••••" + t.slice(-4);
}
