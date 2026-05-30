#!/usr/bin/env node
// Cross-platform launcher for `next dev` / `next start`.
//
// Why this exists: resolving MNEMOS_PORT / MNEMOS_BIND with POSIX shell
// parameter expansion (`-p ${MNEMOS_PORT:-3030}`) only works in a POSIX shell.
// On Windows `pnpm run` uses cmd.exe, which passes `${...:-...}` through
// literally. Resolving the env vars here in Node and passing concrete args to
// the Next CLI keeps the documented overrides working on every OS.
//
// We invoke the app-local `node_modules/.bin/next` (not the require.resolve'd
// realpath): pointing node straight at the .pnpm-deep realpath detaches Next's
// module resolution from apps/web/node_modules, which makes serverExternalPackages
// (better-sqlite3, sqlite-vec, …) unresolvable. The local bin keeps resolution
// anchored in the app's dependency tree, exactly as `next` on the script PATH would.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "start" ? "start" : "dev";
const port = process.env.MNEMOS_PORT || "3030";

// Default to loopback for safety. `lan` is a documented alias for binding to all
// interfaces; map it to a concrete host the Next CLI accepts. The auth layer
// reads MNEMOS_BIND directly and treats anything non-loopback as LAN-exposed
// (bearer token required), so this mapping is presentation-only.
const bindRaw = process.env.MNEMOS_BIND || "127.0.0.1";
const host = bindRaw === "lan" ? "0.0.0.0" : bindRaw;

// Reject anything that isn't a plain port/host so these values are never a
// shell-injection vector on Windows (where the .cmd shim needs shell: true).
if (!/^\d+$/.test(port)) throw new Error(`Invalid MNEMOS_PORT: ${port}`);
if (!/^[A-Za-z0-9.:_-]+$/.test(host)) throw new Error(`Invalid MNEMOS_BIND: ${bindRaw}`);

const isWin = process.platform === "win32";
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = join(appDir, "node_modules", ".bin", isWin ? "next.cmd" : "next");

const child = spawn(nextBin, [mode, "-p", port, "-H", host], {
  stdio: "inherit",
  shell: isWin, // .cmd shims require a shell on Windows; POSIX execs directly
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
