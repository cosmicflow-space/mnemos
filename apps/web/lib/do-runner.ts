/**
 * `/do` verb runner (read-only slice).
 *
 * A verb is an executable at `~/.mnemos/do/<verb>` plus a `<verb>.json` manifest
 * (see docs/agent/do-spec.md). This module discovers verbs and runs them SAFELY:
 *
 *   • the argument is validated to a bare glob BEFORE the script starts (no '/',
 *     '..', quotes, whitespace) — so it is a name to match, never a path or syntax;
 *   • the script runs via `spawn` (NO shell), with a sanitized, fail-closed env
 *     (a fixed per-OS PATH + the home dir only — no secrets, no loader vars), a
 *     neutral cwd, a wall-clock timeout, an output cap, and a tree-kill on timeout;
 *   • only `read`-tier verbs run here. Write verbs (which mutate the index) are
 *     gated elsewhere and are not reachable from this read-only path.
 *
 * Cross-platform: a verb is `<verb>` (POSIX, shebang) or `<verb>.ps1`/`.exe`
 * (Windows). POSIX verbs run directly; a `.ps1` runs through `powershell -File`.
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
// A fuzzy search query: the glob set PLUS spaces, so "Land Rover" works. The verb
// tokenizes it. Still no '/', '\', '..', or quotes (validated below).
const SEARCH_RE = /^[A-Za-z0-9 ._*?[\]-]+$/;

const IS_WIN = process.platform === "win32";

// Sanitized, fail-closed child environment, per OS. The home dir is required (verbs
// search it) and the PATH is fixed so a verb finds system tools (POSIX: mdfind/find/
// grep; Windows: powershell). Nothing else is inherited — no secrets, no
// LD_*/DYLD_*/NODE_OPTIONS/etc.
const WIN_ROOT = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
const WIN_PATH = `${WIN_ROOT}\\System32;${WIN_ROOT};${WIN_ROOT}\\System32\\WindowsPowerShell\\v1.0`;
const CHILD_ENV: NodeJS.ProcessEnv = IS_WIN
  ? {
      SystemRoot: WIN_ROOT,
      Path: WIN_PATH,
      PATH: WIN_PATH, // mirror for cross-platform tools that read uppercase PATH
      PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      USERPROFILE: os.homedir(),
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      NODE_ENV: process.env.NODE_ENV,
    }
  : {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: os.homedir(),
      LANG: "en_US.UTF-8",
      NODE_ENV: process.env.NODE_ENV,
    };

type Resolved = { file: string; kind: "native" | "powershell" };

// A verb's script file, per OS, in priority order:
//   POSIX   → `<verb>` (extensionless, executable via shebang) or `<verb>.sh`
//   Windows → `<verb>.ps1` (run via powershell -File) or `<verb>.exe`
// (`.cmd`/`.bat` are intentionally unsupported: Node blocks spawning them without a
// shell, and cmd.exe quoting is injection-prone — PowerShell or a real exe instead.)
function scriptCandidates(verb: string): string[] {
  const base = path.join(DO_DIR, verb);
  return IS_WIN ? [`${base}.ps1`, `${base}.exe`] : [base, `${base}.sh`];
}

async function resolveScript(verb: string): Promise<Resolved | null> {
  for (const file of scriptCandidates(verb)) {
    try {
      const st = await stat(file);
      if (!st.isFile()) continue;
      // POSIX requires the executable bit; Windows has none, so existence + a known
      // runnable extension is the gate.
      if (!IS_WIN && !(st.mode & 0o111)) continue;
      return { file, kind: file.endsWith(".ps1") ? "powershell" : "native" };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

function validateArg(arg: string, shape: string): string | null {
  if (!arg) return "add a name to search for, e.g. /do fs land rover";
  if (arg.length > 200) return "search term is too long";
  if (arg.includes("..") || arg.includes("/") || arg.includes("\\")) {
    return "use a file's name, not a path (no slashes)";
  }
  if (/["']/.test(arg)) return "quotes aren't allowed";
  // A leading dash would be read as an option by PowerShell (`-File … -foo`) and
  // some POSIX tools.
  if (arg.startsWith("-")) return "can't start with a dash";
  const ok = shape === "search" ? SEARCH_RE.test(arg) : GLOB_RE.test(arg);
  if (!ok) {
    return shape === "search"
      ? "use letters, digits, spaces, and . _ - * ? only"
      : "pattern may contain only letters, digits, and . _ - * ? [ ] (no slashes or spaces)";
  }
  return null;
}

type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean; capped: boolean };

function execVerb(resolved: Resolved, arg: string): Promise<ExecResult> {
  // POSIX runs the script directly (its shebang); Windows runs a .ps1 through
  // PowerShell with no profile and a one-shot policy. The arg is passed as a single
  // argv element either way (no shell), and it is already validated to a bare glob,
  // so neither path can be steered into syntax.
  const command =
    resolved.kind === "powershell" ? "powershell.exe" : resolved.file;
  const argv =
    resolved.kind === "powershell"
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved.file, arg]
      : [arg];

  return new Promise((resolve) => {
    // POSIX: `detached` puts the verb in its OWN process group so a timeout/overflow
    // kills the WHOLE tree, not just the direct child. Windows has no POSIX process
    // groups, so we don't detach (it would spawn a console) and tree-kill via
    // `taskkill /T`. We never `unref()`, so the parent still waits.
    const child = spawn(command, argv, { env: CHILD_ENV, cwd: os.tmpdir(), detached: !IS_WIN });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let capped = false;
    let settled = false;

    const killGroup = () => {
      if (child.pid === undefined) return;
      if (IS_WIN) {
        try {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { env: CHILD_ENV });
        } catch {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }
        return;
      }
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
      if (!(await resolveScript(base))) continue; // manifest without a runnable script → skip
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

  let manifest: z.infer<typeof Manifest>;
  try {
    manifest = Manifest.parse(JSON.parse(await readFile(path.join(DO_DIR, `${verb}.json`), "utf8")));
  } catch {
    const names = (await listVerbs()).map((v) => v.name).join(", ") || "(none)";
    return { ok: false, error: `unknown verb "${verb}". Available: ${names}` };
  }

  const resolved = await resolveScript(verb);
  if (!resolved) return { ok: false, error: `verb "${verb}" has a manifest but no runnable script` };

  if (manifest.tier !== "read") {
    return { ok: false, error: `"${verb}" changes the index — it isn't available from Telegram yet.` };
  }

  const bad = validateArg(arg, manifest.args?.shape ?? "glob");
  if (bad) return { ok: false, error: bad };

  const { code, stdout, stderr, timedOut, capped } = await execVerb(resolved, arg);
  if (timedOut) return { ok: false, error: "search timed out — try a narrower pattern" };
  if (!capped && code !== 0) return { ok: false, error: stderr.trim() || `verb exited with code ${code}` };

  // Keep path bodies intact (a filename may legitimately contain leading/trailing
  // spaces); only strip a trailing CR and drop blank lines.
  const lines = stdout.split("\n").map((s) => s.replace(/\r$/, "")).filter((s) => s.length > 0);
  const truncated = capped || /more|narrow/i.test(stderr);
  return { ok: true, lines, truncated };
}
