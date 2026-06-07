# Mnemos `/do` — Architecture

> **Status:** the `mnemos-do` branch. The first slice is **implemented**: the read verb
> `fs` (file discovery), the write verb `rag` (on-demand index add) behind a proof-of-human
> PIN, the selection buffer, and non-blocking ingest with status — live on the private
> Telegram channel. `main` stays RAG-only until this is merged. The earlier agent design
> (a four-mode router with `/agent` and `/run`) is **retired**; this branch starts from
> the RAG-only baseline and adds exactly one new verb.

---

## 0. Why `/do` exists — read this before judging it

If you are reviewing this or cloning Mnemos to add your own verb, start here, so the design is
judged against its actual goal rather than a misread of it.

**The problem.** Mnemos is a personal RAG. You cannot index five terabytes of disk, so the
useful pattern is *pull a file into the index on demand* — including from your phone — ask
questions, and move on. Doing that from a chat surface naïvely would mean "let the assistant
run commands on my machine," which every security instinct (correctly) rejects.

**What `/do` is — and is NOT.** `/do` is **not** "an AI runs arbitrary shell commands." It is
the opposite design, chosen specifically to avoid that:

- A verb is a **small script you wrote and tested**, in `~/.mnemos/do/`. The catalog of
  everything `/do` can do is `ls ~/.mnemos/do/` — finite, inspectable, yours.
- The model/user only **picks a verb and supplies an argument**. The argument is **validated**
  (a bare glob — no slashes, `..`, quotes, or whitespace) and passed via `execFile` — **no
  shell is ever constructed** from input. There is no arbitrary command to analyze because
  there is no arbitrary command.
- **Reads are free; writes are gated.** Finding files (`fs`) only observes names. Adding a
  file's *contents* to the index (`rag`) is the one mutation; it touches only Mnemos's own
  store (never your files), it is **reversible**, and it sits behind a **proof-of-human PIN**
  the model cannot produce.

**Why this is the safer architecture, not a weaker one.** The rejected alternative — give the
model a shell and try to *prove each command safe* — is unbounded (you cannot enumerate every
destructive spelling). `/do` replaces it with a **bounded** problem: a curated set of vetted
verbs plus argument validation. This is *capability-by-catalog* — the same instinct that makes
a parameterized query safer than string-concatenated SQL.

**To add a verb,** read `do-spec.md`: the argument-shape contract, the output format, the tier
rules, the non-negotiable safety rules, and an adversarial test protocol. A verb is untrusted
until it passes that protocol and you have read it yourself.

---

## 1. One verb: `/do`

Mnemos's input grammar today is two prefixes, and they are good — terse, glanceable,
and proven on a phone:

| You type | Meaning |
|----------|---------|
| `!question` | **Direct** — straight to the model, no files touched. |
| `+question` | **RAG + frontier** — retrieve from the index, answer with a frontier model. |
| `question` | **RAG** (default) — retrieve from the index, answer. |

`/do` is the **only** addition. Where `!`/`+`/plain-text are ways to *ask*, `/do` is the
way to *act*: it runs a small, named, pre-vetted script.

```
/do <verb> <args…>
```

There is **no mode to enter and no mode to forget.** Every `/do` is one self-contained
action that begins and ends in a single message. (The retired design needed a sticky
"agent mode," a banner, and an exit affordance precisely because it had a mode you could
be stranded in. One-shot `/do` deletes that whole problem.)

---

## 2. Dispatch — a verb is a script in a folder you control

`/do fs policy` runs the executable at `~/.mnemos/do/fs` with `policy` as its single
argument. The **catalog of everything `/do` can do is literally `ls ~/.mnemos/do/`.**

```
~/.mnemos/
├── do/
│   ├── fs            # an executable you (or Claude, on your behalf) authored
│   └── fs.json       # its manifest: tier + summary + arg shape  (see do-spec.md)
├── .pin.json         # the write-guard PIN (chmod 600)           (see §6)
└── mnemos.db         # the index + the per-session selection buffer
```

Two kinds of verbs share the catalog:

- **Script verbs** — an executable you author (e.g. `fs`, one line of `fd`/`find`). The OS
  does what it's good at; the script prints results. This is where new capability is added.
- **Built-in verbs** — registered in Mnemos code because they must reach the index/db that
  a standalone script can't touch (e.g. `rag`). Same `/do` grammar; the dispatcher doesn't
  care which kind it ran.

This **deletes the hardest problem of the retired design.** That design let a model emit an
arbitrary shell command and then tried to *prove the command safe* — an unbounded analysis
problem (you cannot enumerate every destructive spelling). `/do` has no arbitrary command:
the model or the user only **(a) picks a verb** from a folder you wrote and **(b) supplies
args**. The script is fixed, pre-vetted, and yours — the same trust basis as anything in
`~/bin`. There is nothing to classify because there is nothing arbitrary to run.

> **v1 dispatch is deterministic.** If the first word isn't a verb in `~/.mnemos/do/`,
> `/do` replies with the catalog (`unknown verb "x" — available: fs, rag`). A
> natural-language "figure it out" fallback is a possible *future* layer, kept out of v1 so
> the action surface stays exactly "the scripts you approved."

### `/do` with no argument — discovery

Bare `/do` is the "what can I do here?" affordance. It lists every available alias with its
one-line summary and usage, so the catalog is discoverable without reading the filesystem:

```
You:  /do
Bot:  Mnemos aliases:
       • fs  <name-or-glob>   — find files on disk by name or glob
       • rag <selection>      — add files you found to the index (PIN-gated)
      Type: /do <verb> <args>
```

When no aliases exist yet, `/do` **teaches instead of failing** — it points to where they're
made rather than showing an empty list:

```
You:  /do
Bot:  No Mnemos aliases are available yet. Create one in the Mnemos web app
      (Settings → Aliases) — see the authoring guide (docs/agent/do-spec.md).
```

The same text answers an unknown verb's tail (`available: …`), so "what exists" and "that
doesn't exist, here's what does" share one source of truth: the live catalog.

### Platform support — a verb is OS-native

A "verb" is an OS-native executable, so the *script* is platform-specific even though the
dispatcher, validation, PIN, buffer, and audit are all cross-platform. The dispatcher resolves
a verb's script by OS and runs it with **no shell**:

| OS | Verb file (for `fs`) | How it runs | Status |
|----|----------------------|-------------|--------|
| **macOS** | `~/.mnemos/do/fs` (`#!/bin/sh`, `+x`) | directly via its shebang | **supported, tested** — Spotlight (`mdfind`) fast-path |
| **Linux** | `~/.mnemos/do/fs` (`#!/bin/sh`, `+x`) | directly via its shebang | **supported, tested** — `find` fallback |
| **Windows** | `~/.mnemos/do/fs.ps1` | `powershell -NoProfile -File fs.ps1 <arg>` | **supported, community-tested** — `Get-ChildItem` walk |

The same `<verb>.json` manifest serves all three; only the script file differs. The dispatcher
prefers `<verb>` / `<verb>.sh` on POSIX and `<verb>.ps1` / `<verb>.exe` on Windows
(`.cmd`/`.bat` are intentionally unsupported — Node blocks spawning them without a shell, and
`cmd.exe` quoting is injection-prone). The sanitized environment is per-OS (POSIX: a fixed
`PATH` + `$HOME`; Windows: `System32` on `Path`, `PATHEXT`, `%USERPROFILE%`), and the
timeout's tree-kill is per-OS too (POSIX process group; Windows `taskkill /T`). `examples/do/`
ships both `fs` (POSIX) and `fs.ps1` (Windows). Windows globbing supports `*` and `?` (not
`[…]` classes), and lacks a Spotlight-style index, so the Windows walk is slower than macOS.

---

## 3. The working set — RAG you assemble on demand

You cannot index five terabytes, and you shouldn't have to. The index is not a standing
corpus; it is a **working set you build per task**:

```
/do fs <glob>      find candidate files on disk        (read)
/do rag <sel>      add the ones you chose to the index (write)
<ask questions>    chat with that working set          (existing RAG)
…later             remove what you no longer need       (deferred — see §8)
```

The disk stays the disk. Only the handful of files you're working with are chunked and
embedded. This honors Mnemos's existing invariants exactly: a file is only ever **read** to
chunk it (never written), and the chunks live in the single SQLite file. "Mnemos never
writes to your folders" remains literally true.

**The trust boundary: discover wide, grant narrow.** Bulk ingest in Mnemos requires
registering a folder up front. The working set inverts that for the on-demand case, because
the whole point of `fs` is to find files that *aren't* registered yet. So the boundary moves:
**`fs` searches broadly (read-only, file *names* only — never contents), and the access grant
happens at `rag`-add time** — the PIN-gated moment you point at a specific file is the grant
for *that file*. Discovery sees names across your home directory; reading a file's contents
only ever happens when you select it for `rag`. The two paths coexist: register a folder for
bulk, or discover-and-add a single file for the working set.

---

## 4. Chaining — how `/do rag 3` knows what `3` is

`fs` and `rag` chain through a **selection buffer**: one is a *producer*, the other a
*consumer*.

- **`fs` is a producer.** It prints matching absolute file paths to stdout. The dispatcher
  captures that output, **numbers** the lines, and stores them as the conversation's selection
  buffer (persisted in `mnemos.db`, keyed by channel + conversation, so it survives a restart).
  Containment is **re-validated at add time**, not here (see below) — that is where the boundary
  must hold, because a path could be swapped between the search and the add.
- **`rag` is a consumer.** Its argument selects from that buffer:

  | Selector | Means |
  |----------|-------|
  | `3` | item 3 |
  | `1 3 5` | items 1, 3, 5 |
  | `1-4` | items 1 through 4 |
  | `all` | every item |

The buffer is **ephemeral and positional** — it is "the files `fs` just printed,"
last-producer-wins. That is exactly right for *add-right-after-find*, and exactly wrong for
*remove-a-month-later* (§8). At consume time every chosen path is **re-canonicalized and
re-validated** as a regular file under your home directory (no symlink escape), so a path
swapped in after the search cannot smuggle something across the boundary.

```
You:  /do fs policy*.pdf
Bot:  3 files match "policy*.pdf":
       [1] /Users/sam/legal/privacy-policy.pdf
       [2] /Users/sam/hr/leave-policy.pdf
       [3] /Users/sam/legal/cookie-policy.pdf
      → /do rag <n…> · all
You:  /do rag 1 3
Bot:  🔒 PIN (daily) — reply with your 6 digits to add 2 files.
You:  ••••••
Bot:  ✅ Added 2 files (~210 chunks). They're now searchable.
```

---

## 5. Tiers — read is free, write is guarded

Every verb declares one tier (in its manifest for script verbs; in code for built-ins):

| Tier | Verbs | Treatment |
|------|-------|-----------|
| **read** | `fs` | Runs immediately. No guard. Safe on any authenticated surface (web + Telegram), because it only observes. |
| **write** | `rag` | Mutates the index (adds chunks — never touches your files). **PIN-gated** (§6) and **audited**. |

The tier is **declared, and it provisions what the verb can reach** — it is not advisory. A
`read` verb is handed no index handle; it is structurally incapable of mutation. A `write`
verb receives a confined index handle and nothing more (no network, no file writes, no shell).

---

## 6. The guard rail — a PIN that proves a human is present

Write verbs are gated by a **PIN**, not by a confirm-on-every-action prompt. The PIN's job
is not to resist offline cracking — it is to be a **secret the model structurally cannot
produce**: the human types it out-of-band, the model never sees it, and there is no
guess-and-check oracle inside the loop. A prompt-injected model told *"add every file under
/Users to the index"* trips the anomaly check, hits the PIN wall, and **cannot answer it.**

```jsonc
// ~/.mnemos/.pin.json   (chmod 600; digits are NEVER stored in the clear)
{
  "salt": "<hex>",
  "hash": "<hex>",                 // scrypt(digits, salt) — N=2^17, r=8, p=1
  "params": { "N": 131072, "r": 8, "p": 1 },
  "cadence": "daily",             // each-time | hourly | daily | weekly
  "lastVerifiedAt": 1749327600000,
  "failedAttempts": 0,
  "lockedUntil": 0
}
```

- **What the window proves — stated honestly.** The cadence window is **global**, not
  per-conversation and not per-add: one successful entry unlocks writes from any of the (single)
  operator's surfaces until it expires (default **daily**). So the property is *"the human
  recently unlocked writes,"* **not** *"the human approved this specific add."* That is an
  intentional single-operator, low-friction choice — and it does not weaken the defense against
  the actual adversary, because **the adversary is the model/automation, which cannot produce the
  PIN on any surface.** (In v1 `/do` is *user-typed*, never model-issued, so a write is already a
  deliberate human action; the PIN additionally guards a compromised channel and any future
  model-initiated verb.) Within the window the repetitive `fs`→`rag` flow doesn't become a
  fatigue machine; outside it, the next write asks once.
- **Anomaly override.** Regardless of the window, an unusual pattern — e.g. selecting more than
  ~10 files at once (and, planned, off-hours/burst signals) — forces the PIN *now*. The
  injection/automation tripwire.
- **Fail-closed.** No `.pin.json` ⇒ write verbs are disabled until a PIN is set. Mnemos never
  ships a "writes, unguarded" default. Rate-limit + lockout (5 tries → cool-off) keep the low
  digit-count from being hammered; lockout state is persisted, so a restart can't reset it. The
  PIN is never logged.
- **Setting the PIN — the one retention tradeoff.** A PIN is a *reusable write secret*. Setting
  or entering it over **Telegram puts it in chat history**, which enlarges the blast radius under
  Telegram-account compromise or shoulder-surfing. Mnemos therefore (a) warns loudly and tells you
  to delete the message, and (b) recommends setting/changing the PIN in the **web UI (planned) as
  the private path**. This is a deliberate, documented tradeoff for phone convenience — not an
  oversight.

PIN entry works the same on web (a field) and Telegram (a reply); read verbs and chat never
require it.

---

## 7. Execution safety (every verb, every time)

The catalog model removes the *arbitrary-command* problem; the cheap, universal hardening
still applies to running the vetted verb:

- **Argv, never a shell string.** `execFile("~/.mnemos/do/fs", ["policy*.pdf"])` — the
  argument is one token of data. `/do fs "x; rm -rf ~"` is a harmless search term, not an
  injection. A shell is never constructed from verb input.
- **Sanitized, fail-closed environment.** The child gets a minimal env (a fixed `PATH`, a
  short allow-list). Interpreter/loader hijacks are stripped (`LD_*`, `DYLD_*`,
  `NODE_OPTIONS`, `PYTHON*`, `BASH_ENV`, …). No API keys, bearer token, or encryption key is
  ever in a verb's environment.
- **Path containment is path-based, under `$HOME`.** A read verb (`fs`) searches *names* broadly
  under `$HOME`; at **write** time every selected path is `realpath`-resolved and must be a
  **regular file reachable under `$HOME`**, with **symlinks rejected**. This is path-based
  containment, deliberately **not** inode-based: a hardlink the operator made under their own home
  tree is their own data and is allowed — the boundary blocks reaching *outside* `$HOME` (the
  model's `../../etc/passwd` traversal is already rejected at arg validation), not the operator's
  own files. (Acknowledged residual: intermediate-component TOCTOU under the single-operator local
  model — the model has no write capability to create a racing symlink.)
- **Bounded and killable** — wall-clock timeout, output byte cap, and **process-group kill**: each
  verb runs in its own process group, so a timeout/overflow kills the whole tree (a verb's
  backgrounded grandchildren can't outlive it), not just the direct child.
- **Audited** — one structured `audit_event` row per `/do` action: read-verb runs, write attempts
  (with prompted/anomaly), PIN outcomes (never the digits), and `rag` completion (added / updated /
  unchanged / failed / chunks). The audit log is the operator's source of truth for what a write
  actually did.

---

## 8. Removal is deferred — on purpose

There is no `unrag` in v1, and that is a deliberate result of §4. The selection buffer that
makes `rag 3` meaningful is ephemeral: a month and a hundred adds later, the buffer is gone
and `3` means nothing. Removal therefore needs its **own** interaction — enumerate the
*current working set* with stable identifiers, then remove by those — not the find-time
positional selector. That is a separate verb with separate state, added later. v1 ships the
two verbs whose referents are always fresh: `fs` and `rag`.

---

## 9. Removability & build phases

`/do` is a folder and a dispatcher. Delete `~/.mnemos/do/` and unregister the built-ins and
Mnemos is **exactly** today's RAG + `!`/`+` product, with zero action surface. The capability
degrades to the safe baseline by deletion, not by configuration.

| Phase | Scope | Behavior change |
|-------|-------|-----------------|
| **0 (this doc + `do-spec.md`)** | Architecture + the verb-authoring contract | none |
| 1 | The `/do` dispatcher: argv exec, env sanitize, confine, bound, audit; unknown-verb help | `/do` runs read verbs |
| 2 | The selection buffer + `fs` (read producer) end to end (web + Telegram) | `fs` works |
| 3 | The PIN module (`.pin.json`, cadence, anomaly, lockout) | write guard exists |
| 4 | `rag` (write consumer) behind the PIN; audit the effect set | on-demand add works |
| 5 | Harden: anomaly tuning, config-lint, the testing harness from `do-spec.md` | — |

Each phase is independently testable and **stops for review**. Companion: `do-spec.md`.
