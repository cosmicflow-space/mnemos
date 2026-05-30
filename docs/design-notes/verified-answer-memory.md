# Design note — Verified-answer memory

> **Status:** describes shipped behavior (v0.5.0) and records design rationale.
> The "alternatives" section documents options we have **considered and
> deliberately deferred** — it is *not* a roadmap or a set of commitments. We
> bias toward fewer moving parts; we would rather under-build than ship a
> foot-gun. If a use case below matters to you, please open an issue with the
> specifics — concrete, evidenced need drives changes here, not speculation.

## What it does today

When you mark an answer as *verified*, Mnemos embeds the **question** and stores
that vector in a small, dedicated table (`vec_verified`) — separate from the
document chunk vectors (`vec_chunk`). On a later query:

1. The query is embedded **once** (the same vector normal retrieval already
   needs).
2. That vector is searched against `vec_verified` (a handful of rows — near
   instant). If the closest verified question is within a strict distance
   threshold (`VERIFIED_MATCH_MAX_DISTANCE`, currently `0.45` L2 ≈ `0.9`
   cosine), it is treated as "the same question."
3. Before use, the match is **revalidated**: the chunks the answer was grounded
   in are re-hashed; if they changed, the verified answer is ignored (lazy
   invalidation).
4. A valid match is **injected into the prompt** as authoritative context,
   alongside the normally-retrieved chunks. The model is told to treat it as
   authoritative *and* to cross-check the retrieved context and cite sources.

Semantic equivalence ("my phone number" ≈ "my Google Voice number") is therefore
recognized via **embeddings + vector similarity** — there is no way to know two
differently-worded questions mean the same thing without embeddings or a model
call. The verified index just makes that check cheap by keeping it tiny.

## It is a *soft* cache, not a short-circuit

A verified hit **does not bypass the language model.** It augments the prompt;
the model still generates the final, cited answer. The cache *biases* the
answer, it does not *replace* the reasoning step.

This is deliberate. Keeping the model in the loop preserves four properties:

- **Phrasing & conversational fit** — the answer adapts to how you asked
  (including follow-ups), rather than echoing a stored blob.
- **Fresh cross-check** — the model reconciles the remembered answer against the
  currently-retrieved context.
- **False-match safety** — if the semantic match was borderline and the verified
  answer doesn't actually fit the new question, the model can fall back to the
  documents.
- **Consistent output** — citations and formatting match every other answer.

The headline benefit is that a small local model, which might otherwise fumble a
fact even with the right chunk present, reads the confirmed answer in its prompt
and stops guessing. The cost is that a model call still happens.

## Principles behind the defaults

These are the values the current behavior optimizes for. They are the lens we
would apply to any future change.

1. **A confidently-wrong answer is worse than a cache miss.** A miss falls
   through to normal retrieval and still answers correctly. A wrong-but-confident
   answer erodes trust. This justifies both the *strict* match threshold and
   *keeping the model in the loop*.
2. **Augment retrieval; don't replace it.** The retrieval-and-cite pipeline is
   the contract. Verified memory is a hint layer on top, not a parallel
   answer path.
3. **One pipeline shape, minimal moving parts.** The query is embedded once and
   reused; no second model call, no separate answer store to keep coherent.

## Alternatives considered (deferred)

Recorded for transparency. Each has a real, workload-dependent trade-off; none is
universally "right," which is exactly why none is enabled by default and why we
would gate any of them behind evidence of a concrete need.

### 1. Confidence-tiered short-circuit (return the cached answer without a model call)

For a query that is *nearly identical* to a verified question, one could skip the
model and return the stored answer directly — instant and free.

- **Buys:** zero latency / zero token cost for true repeats; pleasant on slow
  links (e.g. a phone over cellular).
- **Costs:** gives up the four safeguards above (phrasing fit, fresh
  cross-check, false-match fallback, consistent citation). The risk is
  concentrated entirely in the match being a true equivalence.
- **Why deferred:** those safeguards are load-bearing, not incidental. If
  revisited, it would only apply to a **very-high-confidence band** (a much
  tighter distance than the inject threshold), would **still run the
  invalidation re-hash** before returning, and would remain off unless latency
  or cost is a problem someone actually reports. We are explicitly *not*
  proposing to turn verified memory into a blind key→value lookup by default.

### 2. A looser similarity threshold

Widening the match radius would catch more rewordings.

- **Buys:** more paraphrases hit the same verified answer.
- **Costs:** more *false* matches — returning a remembered answer for a question
  that is merely related (e.g. "phone number" when you have both a cell and a
  Google Voice number). This is the dangerous failure mode.
- **Why deferred:** consistent with principle 1, we keep matching strict.
  Broadening is better done precisely (next item) than globally.

### 3. Multiple phrasings per verified answer

When confirming an answer, optionally store a few alternate phrasings of the
question into `vec_verified`, all pointing at the same answer — widening the
"catch net" *intentionally, per fact* rather than globally.

- **Buys:** reliable hits for a fact you ask many ways, without loosening the
  global threshold.
- **Costs:** more state per verified answer; a save-flow UI affordance.
- **Why deferred:** waiting on a real signal — repeated misses on the same fact —
  before adding the surface area.

### 4. Model-based equivalence check on borderline matches

For distances in an ambiguous band, ask a model "are these the same question?"
before trusting the cache.

- **Buys:** higher-precision matching at the edges.
- **Costs:** an extra model call (latency, tokens, and — for frontier
  providers — sending the comparison off-machine), which partly defeats the
  point of a cheap cache.
- **Why deferred:** complexity and cost outweigh the benefit at current scale.

## Not planned

To be unambiguous, the following are **not** things we intend to do:

- Make verified memory a blind, model-free key→value cache by default.
- Loosen the global match threshold to chase recall at the expense of precision.

If your workload genuinely needs different behavior, that is a great issue to
open — with the specific questions, the answers you'd expect, and what goes
wrong today.
