# Mnemos `/do` — Verb Authoring Spec

> **Read this before writing a `/do` verb — or before asking an assistant to write one for
> you.** It is the contract a verb must satisfy to be safe and predictable. Architecture
> background is in `DO.md`; this document is the *how-to-build-one*.
>
> **The intended workflow:** you describe what you want ("a verb `fs` that finds files by
> name on disk"), point your assistant at this spec, it writes the script + manifest + tests,
> **you test it by hand**, and only then do you trust it. Mnemos runs your vetted verb
> safely; it does **not** sandbox you from your own machine (see the Disclaimer).

---

## 1. What a verb is

A verb is an **OS-native executable** at `~/.mnemos/do/<verb>` plus a **manifest** at
`~/.mnemos/do/<verb>.json`. Mnemos runs the script with **no shell** — arguments are passed as
an argv array. The script file is platform-specific; the **manifest is shared**:

| OS | Script file | Shape | Runs as |
|----|-------------|-------|---------|
| **macOS / Linux** | `~/.mnemos/do/<verb>` (or `<verb>.sh`), `chmod +x` | any language with a shebang (`#!/bin/sh`, `#!/usr/bin/env python3`, …) | directly (shebang) |
| **Windows** | `~/.mnemos/do/<verb>.ps1` (or `<verb>.exe`) | PowerShell `param([string]$Pattern)` | `powershell -NoProfile -File <verb>.ps1 <arg>` |

```
~/.mnemos/do/
├── fs            #!/bin/sh        — POSIX executable (chmod +x)
├── fs.ps1        param($Pattern)  — Windows PowerShell verb
└── fs.json       — the manifest (shared by both)
```

The dispatcher resolves `<verb>` / `<verb>.sh` on POSIX and `<verb>.ps1` / `<verb>.exe` on
Windows. `.cmd`/`.bat` are **not** supported (Node blocks spawning them without a shell, and
`cmd.exe` quoting is injection-prone — use a `.ps1` or a real `.exe`). The validated glob arg
reaches PowerShell as a single bound parameter, so the no-shell guarantee holds on Windows too.

> Built-in verbs (e.g. `rag`) live in Mnemos code, not in this folder, because they must
> touch the index. You author **script verbs**; this spec is about those.

---

## 2. The manifest

```jsonc
// ~/.mnemos/do/fs.json
{
  "tier": "read",                 // "read" | "write"  — see §5
  "summary": "Find files on disk by name or glob.",
  "usage": "/do fs <name-or-glob>",
  "args": {
    "kind": "single",            // "single" = one positional arg; "list" = many
    "shape": "glob",             // a named validator (see §4)
    "required": true
  },
  "role": "producer"              // "producer" fills the selection buffer; omit if neither
}
```

The manifest is validated with `zod` at load time. A verb whose manifest is missing or
invalid is **not registered** (fail-closed) — it never silently runs with unknown
properties.

> **v1 scope — read this before relying on the manifest.** The shipped dispatcher implements
> **exactly one verb shape: a `read`-tier producer taking a single `glob` argument** (the `fs`
> example). `tier` is enforced (only `read` script verbs run; the one write, `rag`, is built-in).
> The `args` and `role` fields are part of the **forward-compatible** contract but are **not yet
> dispatcher-enforced** — every script verb is currently treated as a single-`glob` read producer.
> Additional argument shapes, `write`-tier *script* verbs, and `list` args are future work, each
> gated by its own review. Author `read` producers today; declare `args`/`role` truthfully so the
> verb keeps working as the dispatcher grows into them.

---

## 3. The invocation contract

When the user runs `/do fs policy*.pdf`, Mnemos:

1. Looks up `fs` + its manifest. Unknown verb → prints the catalog and stops.
2. **Validates the argument against the manifest's `shape`** (§4). Invalid → a clear error;
   the executable is never started.
3. **Spawns the verb with no shell**, per OS: POSIX runs the script directly via its shebang
   (`spawn("~/.mnemos/do/fs", ["policy*.pdf"])`); Windows runs a `.ps1` through PowerShell
   (`spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
   "-File", "fs.ps1", "policy*.pdf"])`). Either way the arg is a single argv element. With:
   - **a sanitized, per-OS environment** — POSIX: a fixed `PATH` + `$HOME`; Windows: `System32`
     on `Path`/`PATH` + `PATHEXT` + `%USERPROFILE%`. No secrets; loader/interpreter vars
     (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHON*`, `BASH_ENV`, …) are never present;
   - **a confined working directory**;
   - **bounds** — a wall-clock timeout, a stdout byte cap, and a **tree-kill** on
     timeout/overflow: POSIX kills the verb's process group; Windows uses `taskkill /T`.
4. Interprets the verb's **stdout/exit code** per its role (§6/§7).
5. Writes an `audit_event` row.

Your script therefore receives its input **only** as `argv`. It must **never** reconstruct
a shell command from that input (`sh -c "find … $1"` is forbidden — see §8).

---

## 4. Argument shapes (validators)

`shape` names a built-in validator applied *before* your script runs. v1 ships:

| `shape` | Accepts | Rejects |
|---------|---------|---------|
| `search` | a **fuzzy name query**: letters, digits, **spaces**, and `. _ - * ? [ ]` (the verb tokenizes it) | `/`, `\`, `..`, quotes, control chars, leading `-` |
| `glob` | a filename or shell-style glob: letters, digits, `. _ - * ? [ ]` (no spaces) | `/`, `\`, `..`, quotes, control chars, leading `-` |
| `index` | a selector against the buffer: `3`, `1 3 5`, `1-4`, `all` | anything else |

`search` (used by `fs`) is the friendly one — it allows **spaces** so a natural query like
`land rover` reaches the verb, which then tokenizes it (§10). Neither `search` nor `glob` may
contain `/` or `\` — a search term is a *name*, not a path, so it can't be aimed outside the
home tree. New shapes are added in code (with tests), not invented per verb.

---

## 5. Tiers — declare what the verb does to the world

| Tier | Meaning | Consequence |
|------|---------|-------------|
| **read** | Observes only — lists, finds, reads, prints. No mutation, no network. | Runs immediately, no PIN, safe on web + Telegram. |
| **write** | Changes Mnemos state (adds/removes index chunks). **Never** writes to your files. | PIN-gated (`DO.md` §6) + audited. |

The tier **provisions capability** — a `read` verb is given no index handle and no write
path; declaring `read` and then trying to mutate simply has nothing to mutate with. Declare
the *true* tier: a verb that touches the network or writes anything is not `read`.

> v1 has exactly one shipped write capability — adding to the index — and it is a **built-in**
> (`rag`), because writing chunks needs the db. Authoring a *script* verb that is `write`-tier
> is reserved for a later phase with its own review; for now, author `read` verbs.

---

## 6. Producer contract (read verbs that feed `rag`)

A `read` verb with `"role": "producer"` fills the selection buffer. Contract:

- **Print one absolute path per line to stdout.** Nothing else on stdout (diagnostics go to
  stderr).
- **Exit 0** on success (including "no matches" — print nothing, exit 0). Non-zero means the
  verb failed; stderr is shown to the user.
- **Cap your own output.** *"Too many files"* is the script's job, not Mnemos's — print at
  most a sane number (e.g. 50) and note the rest on stderr. The dispatcher also enforces a
  hard byte cap as a backstop.
- Producer output is buffered as-is; **containment is enforced at `rag`-add time** (not at
  buffer-fill): each selected path must `realpath` to a **regular file under `$HOME`** with no
  symlink, else it is dropped (not an error — just not addable). A producer searches *names*
  broadly (that's discovery); the
  access grant for a file's *contents* happens later, at PIN-gated `rag`-add time
  (`DO.md` §3).

---

## 7. Consumer contract (write verbs that act on a selection)

A `write` verb that consumes a selection (like the built-in `rag`) receives, **already
resolved and re-validated**, the absolute paths the user selected — it never re-parses the
selector or re-reads the buffer itself. It then performs its confined effect (for `rag`:
chunk + embed + insert) and returns a one-line human summary plus the structured effect set
for the audit row.

---

## 8. Safety rules (non-negotiable)

1. **Treat every argument as data, never code.** No `eval`, no `sh -c "$1"`, no building a
   command string from input. Use your language's argv array (`"$@"`, `sys.argv`) and pass
   it to tools as separate arguments.
2. **Never write to, move, or delete the user's files.** Read verbs read. The only sanctioned
   mutation in Mnemos is the index, and only built-in write verbs may do it.
3. **Stay inside the home directory; skip sensitive trees.** A `read` verb may search names
   broadly under `$HOME`, but it must never emit or open paths outside it, and should prune
   sensitive/noisy trees (`.ssh`, `.aws`, `.gnupg`, `node_modules`, `Library`, …). The
   runtime re-validates emitted paths, but a correct verb never tries to reach past `$HOME`.
4. **No network in a `read` verb.** If a capability needs the network, it isn't `read`.
5. **Be deterministic and bounded.** Same input → same output; finish quickly; cap your own
   output; exit cleanly on signals.
6. **Fail closed and loud.** On any doubt, exit non-zero with a stderr message rather than
   doing something partial.

---

## 9. Testing protocol — a verb is untrusted until it passes

Every verb ships with tests, and **you run it by hand once** before relying on it.

**Automated (adversarial) checks** — the verb must survive all of these:

- **Injection args:** `"; rm -rf ~"`, `$(whoami)`, `` `id` ``, `a && b`, a newline-bearing
  arg → treated as a literal search term; nothing executes; no file is touched.
- **Traversal args:** `../../etc`, `/etc/passwd`, an absolute path → rejected by the `glob`
  validator before the script runs.
- **Volume:** a pattern matching thousands of files → output is capped, the run stays within
  time/byte bounds, nothing hangs.
- **Empty result:** a pattern matching nothing → exit 0, empty stdout, a friendly "no
  matches."

**Human checklist** (once, by you):

- [ ] I read the script and understand every line it runs.
- [ ] Its `tier` matches what it actually does.
- [ ] It only reads (for `read` verbs); it touches no file outside the index.
- [ ] On a real query it returns what I expected, with full absolute paths.
- [ ] Its arg `shape` rejects a path/`..`/leading-`-`.

---

## 10. Worked example — the `fs` verb

`~/.mnemos/do/fs` (a `read` producer, `search` shape) is a **fuzzy** file-name hunt under
`$HOME`. It **tokenizes** the query (split on camelCase, spaces, and any non-alphanumeric char,
lowercased) and returns files whose name contains **every** token, in any order. So
`land rover`, `LandRover`, and `Land*Rover*.pdf` all find `Land rover VIN and Sale.pdf`, and
`pearl` finds `InnerPearl.pdf`. macOS seeds candidates from Spotlight (`mdfind`) for speed;
Linux walks with `find`. Both share one sensitive/noise filter and an output cap:

```sh
#!/bin/sh
# /do fs <name…> — fuzzy file-name hunt under $HOME (every token must match, any order).
# $1 is pre-validated (letters/digits/spaces and . _ - * ? [ ]; no '/', '..', or quotes).
set -u
query="${1:?usage: fs <name>}"; limit=50
case "$query" in *"'"* | *'"'* ) echo "fs: illegal character" >&2; exit 2 ;; esac

# Tokenize: split camelCase, non-alphanumerics → spaces, lowercase.
tokens=$(printf '%s' "$query" | sed -E 's/([a-z0-9])([A-Z])/\1 \2/g' \
  | tr -c 'a-zA-Z0-9' ' ' | tr 'A-Z' 'a-z' | tr -s ' ' | sed -E 's/^ +//; s/ +$//')
[ -n "$tokens" ] || exit 0
seed=$(printf '%s\n' $tokens | awk '{ if (length($0) > length(m)) m = $0 } END { print m }')

filter() { grep -v -e '/node_modules/' -e '/Library/' -e '/\.git/' -e '/\.ssh/' -e '/\.aws/'; }
candidates() {
  if command -v mdfind >/dev/null 2>&1 && mdutil -s / 2>/dev/null | grep -q "Indexing enabled"; then
    mdfind -onlyin "$HOME" "kMDItemFSName == '*$seed*'wc" 2>/dev/null
  else
    find "$HOME" \( -name node_modules -o -name .git -o -name Library \) -prune \
      -o -type f -iname "*$seed*" -print 2>/dev/null
  fi
}
n=0
candidates | filter | while IFS= read -r path; do
  [ -f "$path" ] || continue
  base=$(printf '%s' "${path##*/}" | tr 'A-Z' 'a-z'); ok=1
  for t in $tokens; do case "$base" in *"$t"*) ;; *) ok=0; break ;; esac; done
  [ "$ok" = 1 ] || continue
  n=$((n + 1)); [ "$n" -le "$limit" ] || { echo "…>$limit matches; add a word." >&2; break; }
  printf '%s\n' "$path"
done
exit 0
```

> Verified against the adversarial protocol (§9): injection (`; echo …`),
> command-substitution (`$(…)`), and quote breakout are all treated as data — nothing executes
> — and a quote exits non-zero before any query is built. The shipped Windows counterpart
> (`examples/do/fs.ps1`) tokenizes identically with `Get-ChildItem`.

`~/.mnemos/do/fs.json`:

```json
{
  "tier": "read",
  "summary": "Fuzzy-find files under your home directory by name (any word order).",
  "usage": "/do fs <name> — e.g. /do fs land rover",
  "args": { "kind": "single", "shape": "search", "required": true },
  "role": "producer"
}
```

The matching consumer, `rag`, is built in: it takes the buffer items the user selected,
extracts text (text PDFs, Office docs, **and scanned PDFs via OCR** — `DO.md` §5.1), chunks +
embeds + inserts them, is PIN-gated, and audits the added chunk IDs. Together they are the loop:
**`/do fs <name>` → `/do rag <sel>` → `/focus` → ask.**

---

## 11. Disclaimer

`/do` runs **your** code on **your** machine. A verb you (or an assistant) write can do
anything your user account can do — that is the nature of a script you own, the same as
anything in `~/bin`. Mnemos's guarantees are scoped and specific: it validates arguments,
runs verbs without a shell, sanitizes the environment, confines paths to registered sources,
bounds execution, gates writes behind the PIN, and audits every run. It does **not** review
the intent of a verb you install, and it cannot protect you from a verb you wrote to be
destructive. **Read every verb before you trust it. Test it. Keep `write`-tier capability
rare and deliberate.** When in doubt, prefer a `read` verb and a manual step over a clever
automatic one.

Companion: `DO.md`.
