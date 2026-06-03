# Mnemos Agent — Architecture

> **Status:** the `mnemos-agent` branch (experimental, not yet merged). The deterministic mode
> router, the untrusted-content envelope, and the bounded **read-only investigative agent**
> (`/agent`, with workspace navigate/find/read/grep + semantic search) are **implemented and
> tested**; command execution (`/run`, §4–6 of `SECURITY-POSTURE.md`) is **designed but not yet
> wired**. `main` stays RAG-only until this is merged.

---

## 1. The four modes — capability increases left to right

Mnemos has exactly four interaction modes. Capability (and therefore *risk*) rises across them,
and **every higher mode collapses cleanly back to the safe baseline**. The mode is the trust
signal; the table below is the **security boundary**, enforced before any model call.

| Mode | How you enter it | Files (RAG) | Tools | Runs commands | Trust level |
|------|------------------|:-----------:|:-----:|:-------------:|-------------|
| **Direct** | `!` / `!!` / `!!!` prefix | ✗ | ✗ | ✗ | baseline — pure chat with a chosen model |
| **RAG** (default) | a plain question | ✓ | ✗ | ✗ | retrieve from your files, then answer |
| **Agent** | `/agent <goal>` … `/done` | ✓ (as a tool) | ✓ read-first | ✓ via per-command confirm | elevated, opt-in, always visible |
| **Command** | `/run <goal>` | — | — | ✓ one-shot, confirmed | a single deliberate user action |

Two of these already ship on `main` and **must keep behaving exactly as they do today**:
- **Direct** — the `!` family (`!` local, `!!` frontier, `!!!` flagship) skips retrieval entirely.
- **RAG** — the default path: embed → retrieve → assemble → generate → cite.

`/agent` and `/run` are the new, opt-in modes this branch adds. Neither is ever silently on.

---

## 2. The mode router — deterministic, runs before any model call

A single classifier maps each input to exactly one mode by **precedence**, with no model
involvement (so it can't be steered into changing the trust level):

```
1. In an Agent session and input is `/done`        → leave Agent mode (back to RAG default)
2. `/run …`                                          → Command
3. `!` / `!!` / `!!!` prefix                          → Direct        (one-shot, even inside Agent mode)
4. `+` / `++` prefix                                  → RAG + frontier (one-shot, even inside Agent mode)
5. `/agent …`                                         → Agent (opens a session; or, if one is already
                                                       open, continues it — the `/agent` verb is
                                                       stripped either way)
6. In an Agent session (any other input)             → Agent (continue the loop with the raw text)
7. otherwise                                          → RAG (default)
```

Rules 3–4 mean the `!`/`+` prefixes remain **per-message overrides** that work *anywhere* — you
can fire a quick direct question mid-agent-session without leaving it. The prefix grammar is
preserved verbatim; the router only adds Agent/Command on top. Rule 5 is checked before rule 6 so
that re-typing `/agent` mid-session is forgiving (it strips the verb and adds the step) rather than
feeding the literal text `/agent …` into the loop.

---

## 3. Two layers of intent: ambient *mode* vs. per-message *prefix*

This is the heart of the interaction design.

A plain stateful latch (`/agent` turns agentic on, `/done` turns it off) is convenient for
multi-turn work but has a classic failure mode: you forget which mode you're in and a casual
message does something you didn't intend. A hidden mode is a footgun. Mnemos keeps the
convenience and removes the footgun:

- **`/agent <goal>` opens an Agent *session*.** Follow-up turns continue the agent loop without
  re-typing `/agent`.
- **The mode is impossible to forget.** While a session is open the UI is unmistakable: a
  recolored input box and a persistent **"Agent mode — `/done` to exit"** banner. No "am I in
  agent mode?" ambiguity.
- **`/done` closes it** — and so does an always-present **Exit** button, the `Esc` key, *and*
  auto-exit when the goal completes or after an idle timeout. **The safe state (RAG) is the
  attractor**: you fall back to it by default, you don't have to remember to.
- **Mode is decoupled from execution trust.** Being in Agent mode changes *conversation
  routing* only. It does **not** lower the bar on running anything — **every command still passes
  the per-command consequence check and confirm gate** (see §4 and `SECURITY-POSTURE.md`). So the
  worst case of "I forgot I was in agent mode" is that the agent *proposes* a command, which you
  then see and approve or deny. Forgetting the mode can never cause a silent action.
- **`!`/`+` still apply per message inside the session** — ambient mode is the *context*; the
  prefix is an *instant per-message override*. Two clean layers.

`/run` is **not** a mode — it's a one-shot command action, a single deliberate execution
independent of whether an Agent session is open.

---

## 4. The agent loop (read-first)

An Agent turn is a **bounded loop**, not a single call: assemble context → call the model → if it
requests a tool, run the tool → feed the result back → repeat until the model concludes or a hard
cap is hit. Properties:

- **One terminal-outcome decision** (done / blocked / capped / aborted) — no ad-hoc exits.
- **Tools are read-first.** The initial tool set is read-only: `rag_search` (Mnemos's retrieval
  engine, exposed as a tool — see §5) and file read. Command execution is a *separate, gated*
  capability layered on later, never on by default.
- **Bounded:** hard step cap, per-step + whole-turn timeouts, output caps, and context
  compaction when the transcript overflows. The cap is enforced server-side; the model cannot
  raise it.
- **Resumable & safe on restart:** a session that's mid-turn parks at a confirm gate, never at a
  half-run command (detail in the run-loop phase).

## 5. Design choices

- **Keep the `!`/`+` prefix grammar** as the canonical inline model/route selector — a zero-config,
  glanceable trust signal, and the bar for every other interaction (see §3).
- **One retrieval engine, two entry points.** A single retrieval path serves both RAG mode (as a
  *context source*) and Agent mode (as the `rag_search` *tool*). One index, one set of citations,
  two callers — never two retrieval stacks to keep in sync.
- **Single-user, local by design.** Mnemos is one trusted operator on one machine: a local loop
  plus a UI/Telegram confirm. There is no gateway, channel fan-out, operator-scope, role, pairing,
  or multi-tenant layer — those concerns don't exist here. The one privileged escape hatch is a
  single, deliberately-guarded, human-only switch (`SECURITY-POSTURE.md` §4). The simplification is
  in *who* and *where* — never in *how safely a command runs*.

---

## 6. Removability — the safe state is always reachable

Least-privilege is a property of the whole system, not a footnote:

- The entire Agent/Command capability sits behind a feature flag and a loopback+web-only gate. Turn
  it off and Mnemos is **exactly** today's RAG + `!`/`+` product, with zero agent surface.
- Within a running session, every escalation degrades down, never up: `/done` → RAG; deny a
  command → the turn ends; idle → auto-exit. There is no path that ratchets capability upward
  without an explicit, visible human action.

---

## 7. Build phases

| Phase | Scope | Behavior change |
|-------|-------|-----------------|
| **0 (this doc + `SECURITY-POSTURE.md`)** | Architecture + security design | none |
| 1 | Mode router; preserve `!`/RAG exactly; Agent/Command stubbed | none user-visible |
| 2 | Sessions + memory; retrieval wrapped as **untrusted** context | none |
| 3 | Agent run loop; **read-only** tools (`rag_search`, file read); bounds | read-only agent |
| 4 | Safe `/run` (DRY-RUN first): parse → consequence tiers → confirm; prove it blocks `rm -rf`, pipes, `python -c`, env injection | no real exec yet |
| 5 | Enable execution: `/run` (confirm) + agent tool (per-command gate); enforce the §1 capability table | exec on, gated |
| 6 | Harden: audit log, config-lint, safe defaults, restrict the human-only unseal switch | — |

Each phase is independently testable and **stops for review** before the next.
Companion: `SECURITY-POSTURE.md`.
