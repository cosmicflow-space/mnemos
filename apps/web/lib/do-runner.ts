/**
 * `/do` verb runner (read-only slice).
 *
 * A verb is an executable at `~/.mnemos/do/<verb>` plus a `<verb>.json` manifest
 * (see docs/agent/do-spec.md). This module discovers verbs and runs them SAFELY:
 *
 *   • the argument is validated to a bare glob BEFORE the script starts (no '/',
 *     '..', quotes, whitespace) — so it is a name to match, never a path or syntax;
 *   • the script runs via execFile (NO shell), with a sanitized, fail-closed env
 *     (fixed PATH + HOME only — no secrets, no interpreter/loader vars), a neutral
 *     cwd, a wall-clock timeout, and an output cap;
 *   • only `read`-tier verbs run here. Write verbs (which mutate the index) are
 *     gated elsewhere and are not reachable from this read-only path.
 */

import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const DO_DIR = path.join(os.homedir(), ".mnemos", "do");

const Manifest = z.object({
  tier: z.enum(["read", "write"]),
  summary: z.string(),
  usage: z.string().optional(),
  args: z
    .object({
      kind: z.enum(["single", "list"]),
      shape: z.string(),
      required: z.boolean().optional(),
    })
    .optional(),
  role: z.string().optional(),
});

export type VerbInfo = { name: string; tier: "read" | "write"; summary: string; usage: string };
export type RunResult =
  | { ok: true; lines: string[]; truncated: boolean }
  | { ok: false; error: string };

const VERB_RE = /^[a-z0-9_-]+$/;
// A bare glob: letters/digits and . _ - * ? [ ] only. No '/', no '..', no quotes,
// no whitespace — a NAME to match, never a path or query/shell syntax.
const GLOB_RE = /^[A-Za-z0-9._*?[\]-]+$/;

// Sanitized, fail-closed child environment. HOME is required (verbs search $HOME);
// PATH is fixed so verbs find system tools (mdfind, find, grep, mdutil). Nothing
// else is inherited — no secrets, no LD_*/DYLD_*/NODE_OPTIONS/etc.
const CHILD_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: os.homedir(),
  LANG: "en_US.UTF-8",
  NODE_ENV: process.env.NODE_ENV,
};

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

function validateGlob(arg: string): string | null {
  if (!arg) return "add a name to search for, e.g. /do fs report*.pdf";
  if (arg.length > 200) return "search term is too long";
  if (arg.includes("..")) return "invalid pattern";
  if (!GLOB_RE.test(arg)) {
    return "pattern may contain only letters, digits, and . _ - * ? [ ] (no slashes or spaces)";
  }
  return null;
}

type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean; capped: boolean };

function execVerb(scriptPath: string, arg: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    // `detached` puts the verb in its OWN process group so a timeout/overflow can
    // kill the WHOLE tree (group), not just the direct child — a verb's
    // backgrounded grandchildren can't outlive the kill. We never `unref()`, so
    // the parent still waits for it.
    const child = spawn(scriptPath, [arg], { env: CHILD_ENV, cwd: os.tmpdir(), detached: true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let capped = false;
    let settled = false;

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid → the process group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, TIMEOUT_MS);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, capped });
    };

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length + d.length > MAX_OUTPUT) {
        capped = true; // backstop above the verb's own cap — truncate and stop the tree
        killGroup();
        return;
      }
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
    });
    child.on("error", () => finish(127)); // spawn failure (ENOENT/EACCES)
    child.on("close", (code, signal) => finish(typeof code === "number" ? code : signal ? 137 : 0));
  });
}

/** Parse a selection against a buffer of `n` items: `3`, `1 3 5`, `1-4`, `all`, `none`. */
export function parseSelection(arg: string, n: number): { indices: number[] } | { error: string } {
  const t = arg.trim().toLowerCase();
  if (!t) return { error: "say which files, e.g. /do rag 1 3, /do rag 1-4, or /do rag all" };
  if (t === "all") return { indices: Array.from({ length: n }, (_, i) => i + 1) };
  if (t === "none") return { indices: [] };
  const set = new Set<number>();
  for (const tok of t.split(/[\s,]+/).filter(Boolean)) {
    const range = tok.match(/^(\d+)-(\d+)$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) set.add(i);
    } else if (/^\d+$/.test(tok)) {
      set.add(Number(tok));
    } else {
      return { error: `"${tok}" isn't a number, a range (e.g. 1-3), or "all"` };
    }
  }
  const indices = [...set].filter((i) => i >= 1 && i <= n).sort((a, b) => a - b);
  if (indices.length === 0) return { error: `pick from 1–${n}` };
  return { indices };
}

/** List installed verbs (a manifest plus a sibling executable). Empty if none. */
export async function listVerbs(): Promise<VerbInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(DO_DIR);
  } catch {
    return [];
  }
  const out: VerbInfo[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const base = name.slice(0, -5);
    if (!VERB_RE.test(base)) continue;
    try {
      const m = Manifest.parse(JSON.parse(await readFile(path.join(DO_DIR, name), "utf8")));
      const st = await stat(path.join(DO_DIR, base));
      if (!st.isFile() || !(st.mode & 0o111)) continue; // manifest without an executable → skip
      out.push({ name: base, tier: m.tier, summary: m.summary, usage: m.usage ?? `/do ${base}` });
    } catch {
      // invalid manifest or missing script — not registered
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Run a read-tier verb with a single glob argument. */
export async function runVerb(verb: string, arg: string): Promise<RunResult> {
  if (!VERB_RE.test(verb)) return { ok: false, error: `unknown verb "${verb}"` };

  const scriptPath = path.join(DO_DIR, verb);
  let manifest: z.infer<typeof Manifest>;
  try {
    manifest = Manifest.parse(JSON.parse(await readFile(`${scriptPath}.json`, "utf8")));
  } catch {
    const names = (await listVerbs()).map((v) => v.name).join(", ") || "(none)";
    return { ok: false, error: `unknown verb "${verb}". Available: ${names}` };
  }

  try {
    const st = await stat(scriptPath);
    if (!st.isFile() || !(st.mode & 0o111)) return { ok: false, error: `verb "${verb}" is not executable` };
  } catch {
    return { ok: false, error: `verb "${verb}" has a manifest but no script` };
  }

  if (manifest.tier !== "read") {
    return { ok: false, error: `"${verb}" changes the index — it isn't available from Telegram yet.` };
  }

  const bad = validateGlob(arg);
  if (bad) return { ok: false, error: bad };

  const { code, stdout, stderr, timedOut, capped } = await execVerb(scriptPath, arg);
  if (timedOut) return { ok: false, error: "search timed out — try a narrower pattern" };
  if (!capped && code !== 0) return { ok: false, error: stderr.trim() || `verb exited with code ${code}` };

  // Keep path bodies intact (a filename may legitimately contain leading/trailing
  // spaces); only strip a trailing CR and drop blank lines.
  const lines = stdout.split("\n").map((s) => s.replace(/\r$/, "")).filter((s) => s.length > 0);
  const truncated = capped || /more|narrow/i.test(stderr);
  return { ok: true, lines, truncated };
}
