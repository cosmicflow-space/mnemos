# Mnemos evals

This directory holds **synthetic fixture content** + (future) eval definitions
used for testing mnemos behavior end-to-end. The fixtures double-serve as the
demo content for the install walkthrough GIF in the README.

## Why synthetic fixtures?

A personal-RAG system needs to be tested against *real-looking* data — generic
Lorem ipsum doesn't exercise retrieval, ranking, or citation quality. The
fixtures here are fabricated but specific: known facts you can ASK about and
VERIFY in the answer.

Every name, date, and dollar amount is fictional. The folder is safe to
include in the public OSS repo and safe to use in screenshots / demos.

## Structure

```
evals/
├── README.md                       # This file
├── fixtures/
│   └── notes/
│       ├── project-alpha.md        # Synthetic project notes — $50k budget, Pat Engineer, etc.
│       ├── meeting-2026-04-10.md   # Synthetic Q2 planning meeting notes
│       ├── recipe-pasta.md         # Synthetic recipe — ingredients with quantities
│       └── expense-q1.md           # Synthetic expense report — line items + totals
└── (future: specs/, golden/, run.ts — eval framework planned)
```

## Demo questions these fixtures answer

The walkthrough GIF in the README uses the fixture corpus to demonstrate
end-to-end RAG behavior. Questions paired with expected behavior:

| Question | Expected citation | Expected fact in answer |
|---|---|---|
| "What is the budget for Project Alpha?" | `project-alpha.md` | $50,000 |
| "When is Phase 2 of Project Alpha targeted?" | `project-alpha.md` | April 30, 2026 |
| "Who is the project lead?" | `project-alpha.md` | Pat Engineer |
| "What was the Q1 cloud hosting cost?" | `expense-q1.md` | $4,200 |
| "Who approved the Q1 expenses?" | `expense-q1.md` | Pat Engineer |
| "How much pasta for the weeknight recipe?" | `recipe-pasta.md` | 400 g |
| "What is the next meeting date?" | `meeting-2026-04-10.md` | April 24, 2026 |

## Future: full eval framework

The fixtures are a stepping stone toward a proper eval framework that runs
in CI. Design (deferred — planned):

- `specs/retrieval.eval.ts` — verify retrieval returns chunks from the
  expected file(s)
- `specs/answer-facts.eval.ts` — verify the answer text contains expected
  fact strings (substring match; LLM outputs aren't word-for-word
  deterministic even at temp=0)
- `specs/privacy-tier1.eval.ts` — verify Tier 1 default makes zero
  external HTTP calls
- `run.ts` — boots a fresh isolated mnemos state dir, ingests fixtures,
  runs each spec, reports pass/fail

This README documents the design. The runner is planned.

## Updating fixtures

If you change a fact in a fixture (e.g. the Project Alpha budget number),
update the "Demo questions" table above AND re-record the install GIF so
the demo answer stays accurate. Fixtures + demo + (future) evals are
tightly coupled by design.
