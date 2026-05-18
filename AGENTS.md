# AGENTS.md

Operating manual for AI agents (and humans) working in the Mnemos codebase.
Telegraph style — root rules only. Read scoped `AGENTS.md` files before touching subtree.

> `CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; both assistants read the same source.

## Project north star

- **One trusted operator. One machine. One SQLite file. No multi-tenant complexity.**
- **Mnemos is RAG-only.** Not an agent platform. Not a workflow builder. Reject scope creep.
- **Time-to-wow is the metric.** Anything that adds friction to the first-90-seconds is suspect.

## Map

- Web UI + API routes: `apps/web/` (Next.js 15 App Router)
- Core pipeline (provider-agnostic): `packages/core/`
- SQLite + sqlite-vec: `packages/db/`
- Plugin SDK barrel (the only surface plugins can import): `packages/plugin-sdk/`
- CLI: `packages/cli/`
- Bundled plugins: `plugins/*/`
- Spec docs: `docs/`

## Architecture invariants

- **Core stays plugin-agnostic.** No hardcoded provider IDs in `packages/core/`.
- **Plugins cross into core ONLY via** `mnemos/plugin-sdk`. No deep imports from `packages/core/**` or other plugins.
- **One pipeline shape.** The RAG pipeline is opinionated: embed → retrieve → assemble → generate → cite. Plugins extend stages; they don't reconfigure the shape.
- **No drag-and-drop UI.** Opinionated single-pane chat with folders + inspector. If you're tempted to add a flow builder, reject and document.
- **Single SQLite file holds everything.** Chunks, vectors (via sqlite-vec), credentials (encrypted), chat history, audit. No separate stores.
- **Read-only by default.** Mnemos never writes to user folders. Period.
- **Frontier LLMs only see retrieved chunks.** Never raw documents. Audit log shows exactly what was sent.

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

- All plugins import from `mnemos/plugin-sdk` only.
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
├── mnemos.db            # SQLite + sqlite-vec
├── audit.log            # JSON-lines
├── credentials/         # Reserved
├── plugins/             # Reserved (v0.2+)
└── workspace/           # Reserved
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
