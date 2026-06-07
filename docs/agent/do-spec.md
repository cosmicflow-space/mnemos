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

A verb is an **executable** at `~/.mnemos/do/<verb>` plus a **manifest** at
`~/.mnemos/do/<verb>.json`. The executable can be any language with a shebang (`#!/bin/sh`,
`#!/usr/bin/env python3`, …). Mnemos runs it with `execFile` — **arguments are passed as an
argv array, never through a shell.**

```
~/.mnemos/do/
├── fs            #!/bin/sh   — the executable (chmod +x)
└── fs.json       — the manifest
```

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
3. Runs `execFile("~/.mnemos/do/fs", ["policy*.pdf"], { … })` with:
   - **a sanitized environment** — fixed `PATH`, no secrets, interpreter/loader vars
     stripped (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHON*`, `BASH_ENV`, …);
   - **a confined working directory**;
   - **bounds** — a wall-clock timeout, a stdout byte cap, and a **process-group kill** on
     timeout/overflow (the verb runs in its own group, so grandchildren die with it).
4. Interprets the verb's **stdout/exit code** per its role (§6/§7).
5. Writes an `audit_event` row.

Your script therefore receives its input **only** as `argv`. It must **never** reconstruct
a shell command from that input (`sh -c "find … $1"` is forbidden — see §8).

---

## 4. Argument shapes (validators)

`shape` names a built-in validator applied *before* your script runs. v1 ships:

| `shape` | Accepts | Rejects |
|---------|---------|---------|
| `glob` | a filename or shell-style glob: letters, digits, `. _ - * ? [ ]` | path separators (`/`), `..`, NUL, control chars, leading `-` |
| `index` | a selector against the buffer: `3`, `1 3 5`, `1-4`, `all` | anything else |

A `glob` deliberately **cannot contain `/`** — a search term is a *name*, not a path, so it
can't be aimed outside the registered sources. New shapes are added in code (with tests),
not invented per verb.

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

`~/.mnemos/do/fs` (a `read` producer) searches file *names* under `$HOME`. It uses a
**Spotlight fast-path** (`mdfind`, a prebuilt index) when available and falls back to `find`
for portability — measured at **~0.4s vs ~27s** for the same query on a real home directory,
which is the difference between "answers on your phone" and "times out." Both backends share
one sensitive/noise filter and one output cap:

```sh
#!/bin/sh
# /do fs <glob> — find files under $HOME whose NAME matches <glob>.
# $1 is pre-validated to a bare glob (no '/', '..', or quotes). It is matched as
# DATA: a literal find -name pattern, or a Spotlight predicate after a quote-guard.
set -u
pattern="${1:?usage: fs <glob>}"; limit=50
case "$pattern" in *"'"* | *'"'* ) echo "fs: illegal character" >&2; exit 2 ;; esac

filter() { grep -v -e '/node_modules/' -e '/Library/' -e '/\.git/' \
  -e '/\.Trash/' -e '/\.cache/' -e '/\.ssh/' -e '/\.gnupg/' -e '/\.aws/'; }
emit() { n=0; while IFS= read -r p; do [ -f "$p" ] || continue; n=$((n+1))
  [ "$n" -le "$limit" ] || { echo "…>$limit matches; narrow it." >&2; break; }
  printf '%s\n' "$p"; done; }

if command -v mdfind >/dev/null 2>&1 && mdutil -s / 2>/dev/null | grep -q "Indexing enabled"; then
  mdfind -onlyin "$HOME" "kMDItemFSName == '$pattern'wc" 2>/dev/null | filter | emit
else
  find "$HOME" \( -name node_modules -o -name .git -o -name Library -o -name .ssh \
    -o -name .aws -o -name .gnupg -o -name .Trash -o -name .cache \) -prune \
    -o -type f -name "$pattern" -print 2>/dev/null | filter | emit
fi
exit 0
```

> Verified against the adversarial protocol (§9): injection (`; echo …`),
> command-substitution (`$(…)`), and a quote breakout were all treated as data — nothing
> executed — and a quote in the pattern exits non-zero before the Spotlight query is built.

`~/.mnemos/do/fs.json`:

```json
{
  "tier": "read",
  "summary": "Find files on disk by name or glob.",
  "usage": "/do fs <name-or-glob>",
  "args": { "kind": "single", "shape": "glob", "required": true },
  "role": "producer"
}
```

The matching consumer, `rag`, is built in: it takes the buffer items the user selected,
chunks + embeds + inserts them, is PIN-gated, and audits the added chunk IDs. Together they
are the whole v1 loop: **`/do fs <glob>` → `/do rag <sel>` → ask.**

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
