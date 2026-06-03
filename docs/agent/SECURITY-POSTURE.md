# Mnemos Agent — Security Posture (command execution)

> **Status:** the `mnemos-agent` branch. The **read-only** agent surface (§6b) is implemented and
> tested. **Command execution (`/run`) — the Warden, consequence tiers, and approval flow in §3–§5
> — is the design we will build against; it is NOT yet wired.** This is the defense-in-depth model
> for letting an agent run commands on the host **without** letting a prompt-injected or mistaken
> model harm the machine.

---

## 1. Threat model — the model is the adversary

The dangerous capability is **arbitrary command execution on the host**. The adversary is not
only a careless user — it is **the model itself**, which can be steered by prompt injection from a
poisoned document in your corpus, a crafted message, or a tool result, into emitting a destructive
command (`rm -rf`, `curl … | sh`, `dd`, exfiltration through a pipe).

**Stance:** no single control is trusted. A command must survive **several orthogonal layers**, and
the **default is restrictive** — observe-only, confirmed, sandboxed. Trust is granted by the
**human, per command** — never assumed, never requested by the model.

**Where the taint boundary actually is (read carefully).** In an agent loop the model *does* see
untrusted bytes — `rag_search` hits and file-read results are fed back to it before its next
decision (`ARCHITECTURE.md` §4). So poisoned corpus content **can** influence which command the
model proposes. We do **not** pretend otherwise. The load-bearing boundaries are therefore placed
*after* proposal, where they hold regardless of what steered the model:

1. **The Warden classifies the proposed `argv` by consequence** (§3) — *why* the command was
   proposed is irrelevant; a destructive command is caught whether it came from injection or
   mistake.
2. **The human confirms every exact command** (§4). Injection can at most get a command
   *proposed*; it can never get one *run*. `escalate` is sealed outright.
3. **Defense-in-depth — isolated argv synthesis.** The step that turns intent into a concrete
   `argv` is seeded only by a **first-party intent string**, never by raw retrieved bytes, so
   injected *syntax* can't smuggle itself directly into a command. This narrows the attack surface
   but is **not** the boundary on its own (a poisoned *intent* would still produce an argv that
   the Warden + human gate must catch). Treat #1 and #2 as the guarantees; treat #3 as a useful
   reduction, not a wall.

---

## 2. Scope — one operator, one machine

Mnemos is **one trusted operator on one machine**, so the posture is the command-execution layers
that protect *that* operator from a misbehaving model — not the distributed concerns of a
multi-tenant service. There are no operator scopes, roles, RPC method gates, device pairing, or
per-sender tool policies, because there are no untrusted senders: access is the existing bearer
token on a loopback bind, and the Telegram channel stays **query-only** and never reaches an exec
gate. A container/VM sandbox is **not** assumed for v1 — on a Mac without one, the layers in §3–§6
**are** the security, and a confined working directory is the boundary.

---

## 3. The Warden — classify by consequence, not by name

A **blocklist** (refuse known-bad commands) is the wrong model: you cannot enumerate every
destructive spelling (`dd`, a base64-decoded payload, a fork bomb), so "not blocked" never means
"safe." Mnemos uses **allow-by-consequence** instead.

**The Warden** is a deterministic analyzer — **the model cannot influence it** — that parses a
proposed `argv` and assigns one **consequence tier** based on what the command *does to the world*,
not which binary it is:

| Tier | Meaning | Default treatment |
|------|---------|-------------------|
| **`read`** | Provably observes only — no filesystem mutation, no network, confined to the workspace. Matched by a tiny built-in **read-set** of trusted binaries with per-binary argument shapes. | One-tap confirm — and **zero-tap if you've remembered this exact command** (§4). |
| **`write`** | Mutates state, but only **inside the Mnemos workspace** (a confined working directory — never `$HOME`, never a source folder). | Explicit confirm **every time**, showing the exact effect ("writes files in your Mnemos workspace"). |
| **`escalate`** | Anything beyond: network access, writes outside the workspace, touching your source files, privilege (`sudo`), interpreters running inline code, **or anything the Warden cannot prove**. | **Sealed** — no Run button. Reachable only by a deliberate human unseal (§4). |

How the Warden reaches a verdict (deny-by-default):

1. **Decompose first.** Split on chain operators (`&& || ;`); **every** segment must clear its tier
   independently. Reject shell features outright for static reasoning — pipes, redirection (`> <`),
   command/process substitution (`` ` `` `$( )`), globs the shell would expand, newlines. Their
   presence alone forces `escalate`.
2. **Carriers `escalate` (v1).** `env X=… cmd`, `sudo`, `xargs`, `find -exec`, `sh -c`,
   `python -c`, `node -e`, `--eval` carry a hidden inner command. Proving an inner payload safe is
   error-prone, and a single parse mistake is a bypass — so **v1 classifies every carrier as
   `escalate` outright** (no attempt to prove the inner safe). A later version may unwrap and
   recursively analyze specific carriers, but only as an explicit, separately-reviewed addition.
3. **Verify the binary, don't trust `PATH`.** A `read`-tier match requires the resolved binary to
   live in a trusted directory (`/bin`, `/usr/bin`), checked with `lstat` (symlinks not followed),
   owner/permission-checked (reject world-writable) — TOCTOU defense.
4. **Match an argument shape.** A binary in the read-set clears `read` only if its argv matches a
   per-binary profile (positional count, denied flags). Anything off-profile escalates.
5. **Canonicalize every path operand at execution time.** A confined `cwd` is not enough on its
   own: `../` traversal, an absolute path, or a symlink swapped in after approval can all cross the
   boundary while still matching an approved argv. So **at exec time** (not just at classification)
   every filesystem operand is resolved with `realpath` and must lie inside the workspace;
   **symlinks and hardlinks in confined paths are rejected**; and a remembered allow-set entry is
   bound to its **canonicalized target** (plus the Warden version that approved it), so a
   previously-approved `grep foo report.txt` does not silently apply after `report.txt` becomes a
   symlink. This closes the gap between "the argv matches" and "the effect is contained."

## 4. Trust is granted by the human, per command — never requested by the model

The model proposes a command and **nothing else** — it never names a privilege level. The tier is
**computed by the Warden**, and the grant is **the human's keystroke**:

- **`read`** → a single confirm. "**Allow always — this exact command**" promotes that precise argv
  into your **learned allow-set** (stored locally), so it runs zero-tap next time. The allow-set is
  *earned by approval*, not edited in a config file — the safe set grows by use, the same
  zero-config spirit as the `!`/`+` grammar.
- **`write`** → an explicit confirm every time, with the exact effect shown. Never remembered to
  zero-tap (mutation always deserves a fresh look).
- **`escalate`** → **sealed**. To run it you perform a deliberate, loud, **session-scoped,
  auto-expiring unseal** ("Run anyway — outside the safety set"). It is logged, it reverts on its
  own, and **only the human can flip it** — there is no tool argument, no prompt, no model path that
  reaches it. This is the single highest-privilege action in Mnemos; it is rare and visible by
  design.

**Approval fatigue** is itself a threat (reflexive yes-clicking). The learned allow-set neutralizes
it for the safe `read` tier *without* weakening the `write`/`escalate` gates.

**Allow-set integrity.** The learned allow-set is the agent's trust anchor, so it must be
unreachable by the agent. It is stored **outside the confined workspace** (the only directory a
`write`-tier command can touch), and **the only writer is the human-approval flow** — no tool, no
command, and no Warden path can append to it. An agent that could write its own allow-set could
promote `escalate` commands to zero-tap; that path must not exist.

---

## 5. Execution hardening

- **Argv, never a shell string.** Commands run via `execFile(bin, args)` with no shell. A shell is
  never constructed from model output. This is the single biggest anti-injection win.
- **Sanitized, fail-closed environment.** The child gets a minimal env: a fixed `PATH` and a short
  allow-set of variables. Everything that can hijack an interpreter or loader is stripped —
  `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHON*`, `BASH_ENV`, `IFS`, `GIT_*` hooks, compiler wrappers.
  No API keys, bearer token, or encryption key is ever in the child's environment.
- **Confined working directory.** Execution `cwd` is a dedicated Mnemos workspace dir — never
  `$HOME`, never a registered source folder. `write`-tier effects are contained here.
- **Bounded and killable.** Wall-clock timeout, no-output timeout, output byte cap (truncate, don't
  buffer unbounded), and process-tree kill on timeout/abort. One process per run; no backgrounding.

## 6. Gate the exec capability itself for read-only modes

A subtle but critical rule: **denying file-write *tools* does not make a shell read-only.** If the
agent can run a command at all, the shell can still write and delete regardless of which other
tools are denied. Therefore a "read-only agent" in Mnemos **must not have the exec capability at
all** — it is removed from the tool set, not merely restricted. Read-only means *no command
capability present*, not *a command capability told to behave*.

## 6b. The read-only investigative tools (what the agent CAN do today)

The shipped agent is read-only and command-free, but it is a real investigator: it can navigate,
locate, read, and search across the workspace via four filesystem tools (`list_dir`, `find_files`,
`read_file`, `grep`) plus semantic `rag_search`. Their safety rests on one boundary and several
bounds:

- **Confined to registered sources.** Every path operand is `realpath`-resolved and must lie inside
  a **registered source root** (the existing trust boundary — the user explicitly granted access by
  registering the folder). `../` traversal, absolute paths outside a root, sibling-prefix paths
  (`/a/foo` ≠ `/a/foobar`), and symlink escapes are rejected. Reads additionally open with
  `O_NOFOLLOW` and validate the opened inode via `fstat`, closing the common check-then-use race
  where a confined path is swapped to a symlink before the read. (A residual intermediate-component
  TOCTOU is acknowledged but out of scope under the single-operator local trust model: the agent
  has no write capability and cannot create the racing symlink itself.)
- **Read-only by construction.** The tools only stat/read/list; there is no write, delete, move, or
  command execution — so this surface needs no confirm gate and is safe on any authenticated channel
  (web + Telegram). The one possible outbound call is the **configured embedder** for `rag_search`
  (local by default; a key-based embedding provider only if the operator configured one).
- **Bounded.** Directory-walk node count, per-directory listing cap, result counts, per-file byte
  cap, and binary-file skip — so a huge tree or file can't exhaust memory or stall the loop. Tool
  output is itself fenced as UNTRUSTED before re-entering the model (§1, §3 of the loop's fencing).

This is the deliberate effectiveness/safety balance: an agent confined to *registered* sources,
read-only, is useful (it investigates your whole workspace) without being able to reach or change
anything you didn't grant.

---

## 7. Threat → safeguard matrix

| Threat | Primary safeguard | Section |
|--------|-------------------|---------|
| Prompt-injected `rm -rf` / destructive command | Warden → `escalate`/`write` → human confirm/deny | §3, §4 |
| Command injection via argv | `execFile`, never a shell; shell features rejected | §5 |
| `curl … \| sh`, redirection, substitution | pipeline/substitution tokens force `escalate` | §3 |
| Interpreter/loader hijack (`LD_PRELOAD`, `NODE_OPTIONS`) | env sanitized, fail-closed | §5 |
| Hidden exec inside `python -c` / `xargs` / `sudo` | carrier unwrap + recursive analysis | §3 |
| Model requesting its own elevated privilege | model never names a tier; human-only unseal | §4 |
| Poisoned RAG content steering a command | Warden tiers the proposed argv + human confirms every command (injection can propose, never run); isolated argv synthesis | §1, §3, §4 |
| `../` traversal, symlink swap, or remembered argv vs. a mutated target | per-operand `realpath` containment at exec time; no-symlink/hardlink in confined paths; allow-set bound to canonicalized targets | §3, §4, §5 |
| "Read-only" agent that can still write via shell | exec capability removed entirely, not restricted | §6 |
| Approval fatigue → reflexive approval | learned allow-set for `read`; `write`/`escalate` stay explicit | §4 |
| Remote actor via Telegram | Telegram is query-only; never reaches an exec gate (two gates) | §2 |

---

## 8. Defaults & what's enforced where

- **Runtime-enforced (blocks at execution):** argv-no-shell, Warden tier + analysis, read-set
  binary/dir/arg verification, env sanitization, timeouts/caps, confined cwd, loopback+web-only
  gate, exec-capability gating per mode.
- **Human-in-the-loop:** per-command confirm; `escalate` requires the explicit unseal.
- **Deferred to the harden phase:** an audit log of every proposal/approval/execution, a startup
  config-lint, and (if any fetch tool is ever added) an SSRF egress block.
- **Defaults that ship:** observe-only allow-set, confirm-on-anything-unremembered, **unseal
  disabled**, exec capability **off** unless the Agent/Command feature is explicitly enabled. We
  never ship a "skip confirms" or "allow everything" default.

---

## 9. Design principles

1. **The model never names its own privilege.** It proposes a command; the Warden computes the
   tier; the human grants. There is no tool argument by which the model can request elevation.
2. **Classify by consequence, not by binary identity.** Tiers describe *what a command does to the
   world*, which is harder to spoof than a name match and stronger than a blocklist.
3. **The allow-set is learned, not configured.** It grows by approval (zero config files), which
   defeats approval fatigue for the safe tier without weakening the dangerous ones.
4. **The escape hatch is a human keystroke** — loud, session-scoped, auto-expiring, logged, and
   never reachable by the model.
5. **The trust signal is the grammar** (`!`/`+`/`/agent`/`/run`), and mode is decoupled from
   execution trust (`ARCHITECTURE.md` §3) — convenience never lowers the per-command bar.

Companion: `ARCHITECTURE.md`.
