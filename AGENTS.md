# AGENTS.md

Operating manual for AI agents (and humans) working in the Mnemos codebase.
Telegraph style — root rules only. No scoped `AGENTS.md` files exist yet; if one appears in a subtree, read it before touching that subtree.

> `CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; both assistants read the same source.

## Project north star

- **One trusted operator. One machine. One SQLite file. No multi-tenant complexity.**
- **Mnemos is RAG-only.** Not an agent platform. Not a workflow builder. Reject scope creep.
- **Time-to-wow is the metric.** Anything that adds friction to the first-90-seconds is suspect.

## Map

- Web UI + API routes: `apps/web/` (Next.js 15 App Router; routes under `app/api/*`, auth in `lib/auth.ts`, bind logic in `middleware.ts`)
  - Background services start in `instrumentation.ts` `register()` (Node runtime only, once per server boot): `hydrateProcessEnv()` loads `~/.mnemos/.env`, then `startWatcher()` (`lib/watcher.ts`, periodic incremental re-scan) and `startTelegram()` (`lib/telegram.ts`, long-poll bot loop) launch.
  - **Telegram remote channel** (`lib/telegram.ts` + `app/api/telegram/route.ts`, onboarding at `app/telegram-guide/`): ask the RAG from a phone. Long-poll (no inbound port/webhook), default-deny pairing, private-chats-only, **query-only** (no ingest/config over Telegram), bot token never logged. After editing the poller, a full `.next` wipe is needed for changes to take effect.
- Core pipeline (provider-agnostic): `packages/core/`
  - Write path: `ingestFolder` in `src/ingest/pipeline.ts` (scan → exclude → classify → chunk → embed → store)
  - Read path: `runQuery` in `src/query/runQuery.ts` — async generator yielding `QueryEvent`s (citations first, then text deltas, then `done`); prompt assembly in `src/query/prompt.ts`
  - Plugin registry + invariants: `src/registry.ts`
- SQLite + sqlite-vec: `packages/db/` (`schema.sql` is the source of truth; `crud.ts` is the typed access layer)
- Plugin SDK barrel (the only surface plugins can import): `packages/plugin-sdk/` — single `src/index.ts`
- CLI: `packages/cli/` — **v0.1 scaffold only**; commands print help or exit 1 (not yet wired)
- Bundled plugins: `plugins/*/` (chat: anthropic/openai/codex/gemini/ollama/llama-cpp; embed: embed-local; loaders: pdf/docx/xlsx/ocr/markdown/plaintext/web/code)
- Spec docs: `docs/` (`architecture.md`); synthetic eval fixtures + demo corpus: `evals/`

## Architecture invariants

- **Core stays plugin-agnostic.** No hardcoded provider IDs in `packages/core/`.
- **Plugins cross into core ONLY via** `mnemos/plugin-sdk`. No deep imports from `packages/core/**` or other plugins.
- **One pipeline shape.** The RAG pipeline is opinionated: embed → retrieve → assemble → generate → cite. Plugins extend stages; they don't reconfigure the shape.
- **No drag-and-drop UI.** Opinionated single-pane chat with folders + inspector. If you're tempted to add a flow builder, reject and document.
- **Single SQLite file holds everything.** Chunks, vectors (via sqlite-vec), credentials (encrypted), chat history, audit. No separate stores.
- **Read-only by default.** Mnemos never writes to user folders. Period.
- **Frontier LLMs only see retrieved chunks.** Never raw documents. Audit log records provider, model, retrieved chunk IDs, prompt-size estimate, latency, and provider-reported token counts per query. Capturing the exact payload is a future goal.
- **Bundled plugins register statically.** Adding one = add a static import to the `BUNDLED_PLUGINS` array in `packages/core/src/registry.ts`. Dynamic `mnemos-plugin-*` discovery is a future goal.
- **Embedding dimension is a cross-file contract.** `MNEMOS_EMBEDDING_DIM` (registry.ts) must equal the `vec_chunk` dimension in `packages/db/src/schema.sql` (384 today). Change one, change both, or vectors mismatch silently.

## Trust model

- Single user, single machine. Not multi-tenant.
- Bearer token required for all `/api/*` calls.
- Default bind: `127.0.0.1`. LAN binding requires explicit `MNEMOS_BIND=lan` opt-in.
- Source access requires explicit registration: `mnemos source add <path>`.
- Installed plugins are trusted code (documented).

## Commands

- Runtime: Node 22+. Package manager: pnpm 9+.
- First-time bootstrap (cross-OS, Node-only prereq): `node setup.mjs` — parses `INSTALL.md`, detects OS, prompts before fixing anything.
- Install: `pnpm install`
- Dev: `pnpm dev` (Next.js + watch). Binds `127.0.0.1:3030`. Override with `MNEMOS_BIND=lan` (or `0.0.0.0`) and `MNEMOS_PORT`.
- Build: `pnpm build` — order matters: every workspace package compiles first, then `apps/web`. Don't reorder.
- Test: `pnpm test` (vitest). Single test: `pnpm vitest run <file-or-pattern>` or `pnpm test -- -t "<name>"`.
- Lint: `pnpm lint` (oxlint)
- Typecheck: `pnpm typecheck` (delegates to per-package tsc --noEmit)
- Full gate: `pnpm validate` (lint + typecheck + test). Husky enforces it: pre-commit runs lint, pre-push runs lint + typecheck. Don't bypass with `--no-verify`.
- Docker: `docker compose up -d`
- Env precedence (highest → lowest): process env → `./.env` → `~/.mnemos/.env` → `~/.mnemos/config.json`.

## Code

- TypeScript strict mode. Avoid `any`; prefer `unknown` with narrowed adapters.
- ESM only. No CommonJS.
- External input validated with `zod` schemas.
- Comments: brief, only non-obvious logic. No "this function does X" — name it well instead.
- File length: split around ~500 LOC when clarity improves.
- Naming: **Mnemos** is product/docs/UI; `mnemos` is CLI/package/path.

## Plugin SDK rules

- All plugins import from the SDK barrel only — workspace package id `@mnemos/plugin-sdk` (the single `src/index.ts`). No deep imports.
- Plugins implement one or more of: `ChatProvider`, `EmbeddingProvider`, `DocumentLoader`.
- Plugins declare a manifest with `apiVersion: '0.1'`.
- Backward-compatible SDK changes are additive only. Breaking changes require apiVersion bump.
- Bundled plugins live in `plugins/` of the monorepo. External plugins are npm packages (`mnemos-plugin-*`).

## State layout

```
~/.mnemos/
├── config.json
├── auth.key             # chmod 600, bearer token
├── encryption.key       # chmod 600, AES-GCM key
├── mnemos.db            # SQLite + sqlite-vec — includes audit_event table
├── credentials/         # Reserved
├── plugins/             # Reserved (future external-plugin dir)
└── workspace/           # Reserved (future)

Audit log lives in the `audit_event` table inside `mnemos.db` (not a separate `audit.log` file). Inspect via the `/api/audit` route or by querying the table directly.
```

## Security / Release

- Never commit real API keys, tokens, or live config.
- Adopt 48-hour minimum release age for new npm deps (defense against compromised-release supply-chain attacks).
- Adding a native-compilation dep? Add it to `allowBuilds` in `pnpm-workspace.yaml` or `pnpm install` silently skips its build script.
- All releases require explicit approval. Version bumps via `pnpm version`.
- CHANGELOG.md updated on every PR.

## Git

- Commits: conventional-ish, concise, grouped.
- One PR = one topic. PRs >2000 lines reviewed only in exceptional circumstances.
- No `--no-verify` skips.
- `main`: rebase on latest origin/main before push.
