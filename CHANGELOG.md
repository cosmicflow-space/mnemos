# Changelog

All notable changes to Mnemos will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-05-30

### Added
- **Single-file sources**: register one individual file as a source, not just a folder. Paste an absolute path in **Sources** and Mnemos **auto-detects** whether it's a file or a folder — "drop a file" and "drop a folder" both work from one input. A single explicitly-chosen file bypasses the soft noise-filters (logs/lockfiles/hidden) since the choice is deliberate, while the **security hard-lock** (`.env`, `*.pem`, `id_rsa*`) still always applies. New `file` source kind; the Sources list shows each entry's kind.

### Added
- **Per-file metadata chunks**: every ingested file now carries one extra retrievable chunk describing its path, size (human + raw bytes), last-modified date, and type. Metadata questions like *"how big is resume.pdf"* or *"when was notes.md modified"* now retrieve reliably even when no content chunk ranks high — the metadata sentence embeds next to the question itself, not buried in a chunk header. Re-scanning an existing source **backfills** metadata chunks for files indexed before this feature, without re-embedding their content.

## [0.5.0] - 2026-05-30

### Added
- **Verified-answer memory**: click **"✓ Save verified"** on a correct answer to store the Q→A; future closely-matching questions inject the confirmed answer so even small local models answer correctly. Strict semantic match, **lazy content-hash invalidation** (a verified answer stops firing once its source chunks change), a **"✓ verified"** badge on boosted answers, and a **Verified answers** management view (Settings). New `/api/verified` + `verified_answer`/`vec_verified` tables.
- **Re-scan sources**: a **"↻ Re-scan"** button per source surfaces the existing incremental re-ingest — only changed/new files are re-embedded.

### Changed
- Session delete now uses a custom confirmation dialog instead of the native browser prompt.

## [0.4.0] - 2026-05-29

### Added
- **Shell-style chat input** (#7): **↑/↓** recalls previously submitted queries (caret-at-start gated, so multi-line editing is unaffected; your unsent draft is preserved and restored); **Ctrl+C** clears the input (copy still works with a selection). IME composition defers to the browser. A subtle hint line shows the shortcuts.

### Fixed
- **Detect newly-installed local models** (#6): the AI Model dialog now re-fetches the provider/model list on open and offers a **"↻ Detect new"** button — so a model pulled mid-session (e.g. `ollama pull gemma3`) appears without reloading. (Ollama models were always queried live; the UI had cached the list at page load.)

## [0.3.0] - 2026-05-29

### Added
- **Credential detection in the model dialog** (#3): the AI Model dialog scans well-known locations and offers one-click **"Use this"** to import a detected API key (env var or key file) into `~/.mnemos/.env`. Detected OAuth / subscription tokens (Claude Code, codex, gcloud ADC) are shown as **non-reusable status** with the vendor-ToS note and a "Get a key" link — never reused.
- **Per-response transparency** (#4): each answer's footer gains **Sources** and **Data sent** links. *Sources* lists the files used with **copyable absolute paths** + modified date + chunk count; *Data sent* shows exactly which chunks were sent to the model — never raw files — framed local ("nothing left your machine") vs external. Works for live turns and reloaded history via the new `GET /api/chunks`. Pipeline now forwards full chunk text + `fileMtime`; `getChunksByIds` in the DB layer.

## [0.2.0] - 2026-05-29

### Added
- **In-chat onboarding + Settings**: bottom-left "Settings & Sources" launcher with a slide-up popover; AI Model and Sources open as centered modals so you never leave chat. First run gates on configuring a model, then nudges adding sources.
- **Model selection with inline pricing**: per-provider model dropdown labelled with `$in/$out per 1M`; defaults to the cheapest capable model (Haiku / GPT-4o mini) for doc Q&A.
- **Token cost tracking**: provider-reported usage captured through the pipeline and persisted; header shows live **session** and **all-time** cost. New `GET /api/usage` aggregation; `getUsageTotals` in the DB layer.
- **Rich Markdown output**: assistant responses render tables, lists, code, and emphasis via `react-markdown` + `remark-gfm` (safe React, no raw HTML).
- **Light / dark theme** with a semantic-token system and a subtle cosmic accent; toggle in the settings popover.
- **Installer credential auto-scan**: `setup.mjs` offers a local-only scan of well-known key locations (consent-gated, fingerprints only, OAuth/ADC tokens detected but never imported).

### Changed
- Header is now a compact status bar (model + cost chips with hover detail) instead of inline dropdowns; provider/model live in the model modal.
- Native system font stack; non-credential errors stay structured.

### Fixed
- Missing API key now shows an actionable card (get key → add it → git-safety warning) instead of raw JSON.
- `getRecentMessages` chronological ordering is now deterministic for same-millisecond inserts (added an `id` tiebreaker).
- Card, table, and pill borders are clearly visible in both light and dark mode.

## [0.1.0-rc.1] - 2026-05-18

First release candidate of Mnemos — a local-first personal RAG system. Drop a folder, ask a question, get answers with file citations. Your files stay on your machine.

### Highlights
- **Provider-agnostic RAG pipeline**: embed → retrieve → assemble → generate → cite
- **Bundled local embeddings** via BGE-small (ONNX, 384 dim) — zero API keys required for ingest
- **Pluggable chat providers** wired: Anthropic Claude, OpenAI, Ollama
- **Single SQLite file** at `~/.mnemos/mnemos.db` (sqlite-vec for vectors, no separate DB)
- **Bearer-token auth** with loopback bypass on `127.0.0.1`; LAN binding requires explicit `MNEMOS_BIND=lan`
- **Hard-locked credential excludes** (`.env`, `*.pem`, `id_rsa*`, etc.) — security defaults cannot be overridden
- **Soft-default excludes** (logs, lockfiles, minified, transient, hidden) with per-tier opt-in toggles
- **Credential auto-detection**: scans standard locations, click-to-import with server-side allowlist
- **Atomic per-file ingestion** via `ingest_status` invariant (no silent partial-state corruption)
- **Content-hash incremental re-ingestion** — skips unchanged files
- **Chat UI**: Enter-to-send, auto-derived session titles, date-grouped sidebar, citation pills with collapse, copy-to-clipboard, metrics footer (provider · model · duration · tokens), session delete
- **Cross-OS install**: `node setup.mjs` reads the playbook in `INSTALL.md` (macOS, Linux, Windows)
- **Audit log** records exactly what was sent to any external service

### Coming in v0.2
- Gemini and bundled `llama.cpp` chat providers (currently stubs)
- Per-source persistent filters
- Cross-encoder reranking
- npm global install
- Plugin marketplace surface

### Plugin SDK
- apiVersion `0.1` (additive-only changes within 0.1.x; breaking changes will bump apiVersion)
- Plugins implement `ChatProvider | EmbeddingProvider | DocumentLoader`
- Plugins may only import from `mnemos/plugin-sdk` — no deep imports into core or other plugins

### Install

```bash
git clone https://github.com/cosmicflow-space/mnemos.git
cd mnemos && node setup.mjs
```

Roughly 90 seconds from clone to first answer on a typical laptop.

---

## Detailed development history

### Added
- Initial repo scaffold: monorepo structure (apps/web, packages/, plugins/)
- MIT LICENSE, README, AGENTS.md, CONTRIBUTING.md
- Docker + docker-compose runtime
- Root package.json with pnpm workspaces
- TypeScript base config (strict mode, ES2022, ESM)
- .gitignore + .env.example
- Architecture spec at `agentic-framework/oss-rag-planning/ARCHITECTURE.md`
- Competitive landscape notes capturing patterns to adopt from the broader RAG / personal-knowledge-base ecosystem

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
- **IP-hygiene rename**: `folder` table → `source` (with `kind` column for folder/url/mailbox), `pair` CLI command → `source`, `doctor` → `check`. Uses universal industry terms (chunk, embedding, session, credential) and avoids any terminology distinctive to other named products.

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

### Day 4 (2026-05-18)
- **Query pipeline complete** — `runQuery()` at `packages/core/src/query/runQuery.ts` orchestrates the full read path: embed query → vec_search top-K → load conversation memory → assemble RAG prompt → stream chat → persist messages → audit
- **RAG prompt template** at `packages/core/src/query/prompt.ts` with numbered chunk references, anti-hallucination guard ("use ONLY the retrieved context"), and contradiction surfacing
- **`POST /api/query`** — SSE-streamed with five event phases: `embed`, `retrieved` (UI shows citation pills early), `delta` (per-token text), `done`, `error`. Auto-creates a session if `sessionId` omitted, returns the id via `x-mnemos-session-id` response header
- **`GET /api/audit`** — query the audit log with `?since=`, `?limit=`, `?type=` filters
- **`GET /api/sessions`** — list recent sessions (50 newest); `?id=` returns full message history for one session
- **Chat UI** at `/chat`:
  - Left sidebar: session history (newest first), "New chat" button, link to Sources
  - Top header: provider selector dropdown (pulls from `/api/providers`)
  - Center thread: message bubbles with cyan accent for user, gray for assistant
  - Inline citation pills (numbered, click to expand chunk snippet inline)
  - Streaming cursor (amber pulse) while assistant is generating
  - Bottom: textarea input with ⌘↵ shortcut to send
  - Provider + last-session preferences persisted to localStorage
- **Home page**: now leads with "Start Chat →" (amber) + "Manage Sources" (cyan), aligning with the brand color story (amber for memory/retrieval, cyan for indexing/control)

### Coming next (v0.1)
- First end-to-end `pnpm install` + `pnpm dev` verification — Day 5
- Docker build verification + 90-second demo recording — Day 6
- Publish to GitHub — Day 7
