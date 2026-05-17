# Changelog

All notable changes to Mnemos will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial repo scaffold: monorepo structure (apps/web, packages/, plugins/)
- MIT LICENSE, README, AGENTS.md, CONTRIBUTING.md
- Docker + docker-compose runtime
- Root package.json with pnpm workspaces
- TypeScript base config (strict mode, ES2022, ESM)
- .gitignore + .env.example
- Architecture spec at `agentic-framework/oss-rag-planning/ARCHITECTURE.md`
- Competitive analyses (OpenClaw, Flowise) capturing patterns to adopt

### Day 2 (2026-05-12)
- DB CRUD layer (`packages/db/src/crud.ts`): folders, files, chunks/vec_search, credentials, sessions, messages, audit
- Plugin registry (`packages/core/src/registry.ts`): validates + loads bundled plugins, lookup helpers
- AES-256-GCM credential encryption (`packages/core/src/crypto.ts`)
- Real provider implementations: Anthropic (streaming chat), OpenAI (chat + embedding), Ollama (NDJSON chat + batch embeddings)
- 18 smoke tests covering DB, registry, crypto, provider structure (no live API calls)
- `/api/providers` endpoint surfacing registered plugins
- Shared runtime singleton (`apps/web/lib/runtime.ts`)

### Day 2.5 (2026-05-12)
- **Bundled local embedding plugin** (`plugins/embed-local`) using `@xenova/transformers` with BGE-small-en-v1.5
- Standardized all bundled embedding providers on 384 dimensions:
  - embed-local: 384 native (BGE-small)
  - OpenAI: 384 via Matryoshka `dimensions` parameter on text-embedding-3-small
  - Ollama: default model changed to `all-minilm` (384 native, was nomic-embed-text @ 768)
- Schema `vec_chunk` dimension: 1536 → 384
- New constants: `DEFAULT_EMBEDDING_PROVIDER_ID` ("embed-local"), `MNEMOS_EMBEDDING_DIM` (384)
- README + .env.example updated to surface "free local default + alternatives from getgo" UX
- **IP-hygiene rename**: `folder` table → `source` (with `kind` column for folder/url/mailbox), `pair` CLI command → `source`, `doctor` → `check`. Avoids OpenClaw-distinctive terminology while keeping universal industry terms (chunk, embedding, session, credential).

### Day 2.6 (2026-05-13)
- **Logo locked**: v1 Cyan + Amber citation-bracket design (Path B1 after AI partner review with Gemini + Codex flagged the original hex concept as too generic in the Honeycomb.io visual bucket)
  - Geometry: square citation brackets `[ ]` surrounding a custom geometric μ glyph
  - Palette: cyan `#06b6d4` brackets (retrieval), amber `#f59e0b` μ (memory) — astrophysics-accurate two-star cosmic pairing
  - Files: `apps/web/public/logo.svg` (canonical), `apps/web/public/favicon.svg`
  - Wired into Next.js `metadata.icons` + OpenGraph + Twitter card
  - 5 variant SVGs preserved at `apps/web/public/logos-preview/` for future reference
  - Full AI partner review feedback at `.claude/reviews/{gemini_feedback,codex_feedback,synthesis}.md`

### Day 3 (2026-05-16)
- **Ingestion pipeline complete** — `scanFolder` (read-only filesystem walk + classification) + `ingestFolder` (load → hash → chunk → embed → upsert) in `packages/core/src/ingest/`
- **Content-hash incremental ingestion** — SHA-256 streaming hash; files unchanged since last ingest are skipped
- **Recursive character text splitter** — paragraph/line/sentence/word/char fallback; 1000-char chunks with 200-char overlap
- **File classifier** with three categories: `supported` (will ingest), `deferred` (recognized but skipped — e.g. images with OCR coming in v0.2), `unsupported` (silently ignored)
- **Auto-skip junk dirs** during scan: `node_modules`, `.git`, `dist`, `.next`, `__pycache__`, etc.
- **5 document loaders implemented** (real, not stubs):
  - `loader-pdf` via `pdf-parse`
  - `loader-markdown` with YAML frontmatter parsing
  - `loader-plaintext` for `.txt`, `.log`, `.csv`, `.json`
  - `loader-code` for 25+ source-code extensions with language detection
  - `loader-web` for URL ingestion (single page, native fetch + minimal HTML→text)
- **3 real API endpoints**:
  - `POST /api/sources/scan` — read-only preview of "what's in this folder"
  - `GET/POST/DELETE /api/sources` — register/list/unregister sources, with chunk counts
  - `POST /api/ingest` — **SSE streaming** with per-file progress events (scan-start, file-chunked, file-embedded, done)
- **Sources UI page** at `/sources` — Browse → Scan → Add flow per Sam's UX brief:
  - Text input + suggested paths (`~/Documents`, `~/Downloads`, etc.)
  - Scan shows summary cards (will ingest / deferred / skipped) and breakdown by file type
  - Auto-skipped dirs disclosed in collapsible
  - "Add to Mnemos" button triggers SSE-streamed ingestion with cyan-to-amber gradient progress bar
  - Done state shows files processed, chunks created, duration
- **Default embedder** wired in `apps/web/lib/runtime.ts` — uses `embed-local` (BGE-small) out of the box; can be overridden via `MNEMOS_DEFAULT_EMBEDDING` env var

### Coming next (v0.1)
- Query pipeline with retrieval + citations — Day 4
- Chat UI with provider/model selector + history sidebar — Day 5
- Docker build verification + 90-second demo recording — Day 6
- Publish to GitHub — Day 7
