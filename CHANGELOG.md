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

### Coming next (v0.1)
- Document loaders (pdf, markdown, plaintext, web, code) — Day 3
- Ingestion pipeline with content-hash incremental upsert — Day 3
- Query pipeline with retrieval + citations — Day 4
- UI three-pane layout — Day 5
- Docker build verification + demo recording — Day 6
- Publish to GitHub — Day 7
