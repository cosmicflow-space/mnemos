# Mnemos `/do` — Architecture

> **Status: shipped on both the web app and the Telegram channel.** `/do` (`fs`, `rag`), **File
> Focus Mode** (`/focus` … `/done`, `/reindex`), on-demand ingest with a three-tier PDF extractor
> (text → `pdftotext` → OCR), and a proof-of-human PIN are live in the **web chat UI** and on the
> **private Telegram bot** — the same commands, the same decisions. The two surfaces **share one
> conversation**: focus and the selection buffer are keyed by the session id (not the device), so
> a thread started on your phone continues in the browser (and back) with its scope intact — and a
> sidebar **"Continue on phone"** re-points the bot at any web thread (§6.1). The OCR tier needs
> `poppler` on the host (graceful no-op otherwise; §5.1). Runs on **macOS, Linux, and Windows**
> (§2.1). The earlier agent design (`/agent`, `/run`) is retired.

---

## 0. The intent — find a file, add it, chat with it (especially from your phone)

Read this first; it's the *why*, and everything below serves it.

**The workflow this enables.** On your computer you already have a hundred ways to find a file
and a Sources panel to add a whole folder. **On your phone you don't** — and that's exactly
where this matters. You're away from your desk, you half-remember a file's name ("the Land
Rover VIN thing"), and you want to *find it, pull it into the index, and ask questions about
it.* That four-step arc is the feature:

```
/do fs land rover      ① find it on disk — fuzzy, any word order   (read, free)
/do rag 1              ② add it to the index — text/PDF/scanned     (write, PIN-gated)
/focus land rover      ③ scope the chat to just that file
"what is my VIN?"      ④ ask / summarize / explore — answered from that file alone
```

Steps ① and ④ are the adoption unlock: a vaguely-remembered name becomes a focused
conversation with the document, from anywhere, with your files never leaving your machine.

**What `/do` is — and is NOT.** `/do` is **not** "an AI runs arbitrary shell commands." It is
the opposite design, chosen specifically to avoid that:

- A verb is a **small script you wrote and tested**, in `~/.mnemos/do/` (OS-native — a shell
  script on macOS/Linux, a PowerShell script on Windows; §2.1). The catalog of everything
  `/do` can do is `ls ~/.mnemos/do/` — finite, inspectable, yours.
- The model/user only **picks a verb and supplies an argument**. The argument is **validated**
  (no slashes, `..`, or quotes) and passed via `execFile`/`spawn` — **no shell is ever
  constructed** from input. There is no arbitrary command to analyze because there is none.
- **Reads are free; writes are gated.** Finding files (`fs`) only observes names. Adding a
  file's *contents* to the index (`rag`) is the one mutation; it touches only Mnemos's own
  store (never your files), it is **reversible**, and it sits behind a **proof-of-human PIN**
  the model cannot produce.

**Why this is the safer architecture, not a weaker one.** The rejected alternative — give the
model a shell and *prove each command safe* — is unbounded (you cannot enumerate every
destructive spelling). `/do` replaces it with a **bounded** problem: a curated set of vetted
verbs plus argument validation. This is *capability-by-catalog* — the same instinct that makes
a parameterized query safer than string-concatenated SQL.

**To add a verb,** read `do-spec.md`: the argument-shape contract, the output format, the tier
rules, the non-negotiable safety rules, and an adversarial test protocol. A verb is untrusted
until it passes that protocol and you have read it yourself.

---

## 0.1 The two new verbs at a glance (cross-platform)

| Command | What it does | Tier |
|---------|--------------|------|
| `/do fs <name…>` | **Fuzzy** file-name hunt under `$HOME`. Spaces, camelCase, and any word order all work — `land rover`, `LandRover`, `Land*Rover*.pdf` all find `Land rover VIN and Sale.pdf`. Returns a numbered list. | read |
| `/do rag <sel>` | Add the picked files (`3` · `1 3` · `1-4` · `all`) to the index. Text PDFs, Office docs, **and scanned PDFs (OCR)** all extract. PIN-gated, reversible, auto-focuses on what you added. | write |
| `/focus <name\|n>` | Scope the chat to one already-indexed file — by name, or by `<n>` from a citation/source list. | — |
| `/done` | Leave focus; back to searching all your files. | — |

These behave **identically on macOS, Linux, and Windows** — the dispatcher, validation, PIN,
buffer, focus, and OCR are all cross-platform; only the verb *script* is OS-native (§2.1).

---

## 1. The grammar: `!`/`+` to *ask*, `/do` to *act*, `/focus` to *narrow*

Mnemos's input grammar is small, terse, and glanceable. The `!`/`+` prefixes, `/do`, `/focus`,
`/done`, and `/reindex` are **identical on web and phone** — the same shared engine drives both:

| You type | Meaning |
|----------|---------|
| `question` | **RAG** (default) — retrieve from the index, answer. |
| `!question` | **Direct** — straight to the model, no files touched. |
| `+question` | **RAG + frontier** — retrieve, answer with a frontier model. |
| `/do <verb> <args…>` | **Act** — run a small, named, pre-vetted script (`fs`, `rag`). |
| `/focus <name\|n>` | **Narrow** — scope the chat to one indexed file. |
| `/done` | Leave focus — back to all files. |

Where `!`/`+`/plain-text *ask*, `/do` *acts* — it runs a vetted verb. There is **no mode to
enter and no mode to forget** for `/do`: every call is one self-contained action in a single
message. `/focus` does add a visible, always-footed scope (`🎯 <file> · /done to exit`) — a
mode by design, but one you can never be stranded in (`/done`, `/new`, or switching files all
return you to the safe global state).

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

| OS | Verb file (for `fs`) | How it runs | Search engine |
|----|----------------------|-------------|---------------|
| **macOS** | `~/.mnemos/do/fs` (`#!/bin/sh`, `+x`) | directly via its shebang | Spotlight (`mdfind`) — instant |
| **Linux** | `~/.mnemos/do/fs` (`#!/bin/sh`, `+x`) | directly via its shebang | `find` walk |
| **Windows** | `~/.mnemos/do/fs.ps1` | `powershell -NoProfile -File fs.ps1 <arg>` | `Get-ChildItem` walk |

The same `<verb>.json` manifest serves all three; only the script file differs. The dispatcher
prefers `<verb>` / `<verb>.sh` on POSIX and `<verb>.ps1` / `<verb>.exe` on Windows
(`.cmd`/`.bat` are intentionally unsupported — Node blocks spawning them without a shell, and
`cmd.exe` quoting is injection-prone). The sanitized environment is per-OS (POSIX: a fixed
`PATH` + `$HOME`; Windows: `System32` on `Path`, `PATHEXT`, `%USERPROFILE%`), and the
timeout's tree-kill is per-OS too (POSIX process group; Windows `taskkill /T`). `examples/do/`
ships both `fs` (POSIX) and `fs.ps1` (Windows).

**`fs` is a fuzzy hunt, identically on every OS.** Each script tokenizes the query the same
way — split on camelCase, spaces, and any non-alphanumeric character, lowercase — then returns
files whose name contains **every** token, in **any order**. So `land rover`, `LandRover`,
`land_rover`, and `Land*Rover*.pdf` all find `Land rover VIN and Sale.pdf`, and `pearl` finds
`InnerPearl.pdf`. (macOS seeds the candidate set from Spotlight for speed; Linux/Windows walk
the tree.)

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

## 4.1 File Focus Mode — chat with one file (`/focus` … `/done`)

Default RAG searches *all* your files. But once you've narrowed to a document, you usually want
to stay there — *"summarize this,"* *"what does it say about X,"* follow-ups — without other
files leaking in. **File Focus Mode** scopes the conversation to one file (or a small set).

**Two ways in, one way out** (identical on the web chat and the Telegram bot):

- **`/do rag <n>` auto-focuses** on the file(s) you just added — selecting *is* intent.
- **`/focus <name|n>`** scopes to an **already-indexed** file. `<name>` matches indexed files
  by name; `<n>` picks from the **numbered Sources list** of the last answer (so a normal
  answer's citations are directly drillable: *"Reply /focus 1 to chat with just that doc"*).
- **`/done`** exits — back to global search. So does `/new`. The safe state (all files) is the
  attractor; you fall back to it, never stranded.

**It's a real retrieval mode, not just a filter.** A *small* focused file is loaded **whole**
(all its chunks, in order) into context — so "summarize this" works because the model sees the
entire document, not a top-k sample. A *large* focused file falls back to vector search
*within* that file. Either way, every focused answer is footed with `🎯 <file> · /done to exit`
so the active scope (and the way out) is always visible.

**Scope vs. tier are orthogonal.** Focus controls *which documents*; the `!`/`+` prefix controls
*which model*. So while focused: a plain question → that file (local); `+question` → that file
(frontier model); `!question` → direct, no files (a one-message escape). And **switching focus
starts a fresh conversation thread**, so a prior document's discussion can never bleed into the
new one.

```
You:  what files mention the Land Rover?
Bot:  …📎 Sources:
      [1] Land rover VIN and Sale.pdf
      [2] insurance-2024.pdf
      Reply /focus <n> to chat with just that document.
You:  /focus 1
Bot:  🎯 Now focused on Land rover VIN and Sale.pdf — questions are scoped to this file. /done to exit.
You:  what is my VIN?
Bot:  SALWA2VK7HA000000 …
      🎯 Focused on Land rover VIN and Sale.pdf · /done to exit
```

### Files with no readable text — honest, located, fixable

If a focused file has no extractable text (a scanned PDF, an unsupported type), Mnemos doesn't
let the model improvise — it says so plainly, **with the file's path and the reason**, and
offers **`/reindex`** to re-extract just that one file (which runs OCR for scanned PDFs; §5.1).
This is the "find → add → chat" loop refusing to silently fail.

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

## 5.1 On-demand extraction — text → `pdftotext` → OCR

When `rag` adds a file, the loader extracts its text. For PDFs this is a **three-tier**
pipeline so the messy real-world documents you actually have still work:

1. **`pdf-parse`** (pure-JS, cross-platform) — handles normal text PDFs.
2. **`pdftotext`** (poppler) fallback — recovers PDFs whose text layer `pdf-parse` silently
   missed *or errored on*. Used only if poppler is on the system; a no-op otherwise.
3. **OCR** fallback — for **scanned/image PDFs with no text layer**: `pdftoppm` renders the
   pages to images and **`tesseract.js`** (the same engine the image loader uses) reads them.
   Bounded to the first 20 pages; runs in a worker so it doesn't block.

Each tier runs only if the previous came back empty, so there's no cost for clean files. A
file that survives all three with no text is honestly reported as **metadata-only** (with its
path + reason), and **`/reindex`** re-runs this pipeline on just that one focused file.

> **Cross-platform note.** Tiers 2–3 use system tools (`poppler`'s `pdftotext`/`pdftoppm`) plus
> the bundled `tesseract.js`. Where poppler isn't installed they degrade gracefully — text PDFs
> still work everywhere; scanned-PDF OCR is available wherever poppler is present (macOS/Linux
> via Homebrew/apt; Windows via the poppler build). Raster image files (`.png`/`.jpg`/…) OCR on
> every platform via `tesseract.js` with no system dependency.

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
  to delete the message, and (b) recommends setting/changing the PIN in the **web UI as the private
  path** — there the PIN goes into a password field that submits over localhost and is never echoed
  into a chat log. This is a deliberate, documented tradeoff for phone convenience — not an oversight.

PIN entry works the same on web (a modal field) and Telegram (a reply); read verbs and chat never
require it.

---

## 6.1 Cross-surface continuity — one conversation, phone ↔ browser

The web chat and the Telegram bot are **two windows onto the same conversations**, not two
parallel histories. The mechanism is deliberately boring: there is no sync protocol, because
there is nothing to sync.

- **One identity.** Every conversation is a `session` row. A Telegram chat is bound to its current
  session; the browser holds the session id it's viewing. Both surfaces derive the **same state
  key** from that id (`sess:<id>`), so the **focus, the selection buffer, the cited list, the
  pending-PIN, and the rag-status all live with the session** — not with the device. Open a phone
  thread in the browser and its focus is already applied; the working-set is the same set.
- **It shows up where you'd look.** Telegram threads are titled by their first question (like web
  threads) and appear in the web sidebar. The one currently bound to the bot is marked **📱 active
  on Telegram**, so you can pick the phone conversation up at your desk and keep going.
- **"Continue on phone" (the other direction).** A sidebar control re-points the paired Telegram
  chat(s) at the chosen web session. Because focus + working-set are session-keyed, the phone
  inherits the exact scope with nothing copied — start at your desk, finish on the couch.
- **Focus transitions fork a fresh thread on *both* surfaces.** Entering/switching/leaving focus
  starts a new session (Telegram unbinds; the web opens a new thread and the client adopts its id),
  so a prior document's discussion can't leak into the new scope. The old thread stays in history
  with its focus intact — reopen it anywhere and resume.
- **The trust model is unchanged.** "Continue on phone" only changes *which session a chat is bound
  to*; it never touches a user file, and the only mutation on any surface remains the PIN-gated
  add-to-index. Query/read stays ungated everywhere.

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
