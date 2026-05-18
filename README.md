<div align="center">

# 🧠 Mnemos

**Personal RAG. Local-first. Drop a folder, ask a question.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: 22+](https://img.shields.io/badge/Node-22%2B-339933.svg)](https://nodejs.org/)
[![Status: Pre-release](https://img.shields.io/badge/Status-v0.1--rc-orange.svg)](CHANGELOG.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-cyan.svg)](CONTRIBUTING.md)

</div>

Mnemos is a personal RAG (retrieval-augmented generation) system that runs entirely on your own machine. Drop a folder of documents, ask questions in plain English, get answers with file citations. Your files never leave your computer; only the retrieved chunks are sent to whichever LLM you choose, and the audit log shows exactly what was sent.

Built from scratch in TypeScript + Next.js. Opinionated single-pane UI — no drag-and-drop canvas, one strong default per pipeline stage, plug your own providers via a versioned SDK.

## Quick start

The only prerequisite is **Node 22+** ([nodejs.org](https://nodejs.org/) if you don't have it).

```bash
git clone https://github.com/cosmicflow-space/mnemos.git
cd mnemos
node setup.mjs
```

That's it. The installer detects your OS (macOS, Linux, Windows), checks what's installed, asks before fixing anything, walks you through provider configuration, and starts the dev server. The install logic lives in [`INSTALL.md`](INSTALL.md) — readable as docs, executable by `setup.mjs`, no per-OS shell scripts to drift.

Then open <http://127.0.0.1:3030>:

1. **Configure an agent** — pick Claude, GPT, or Ollama (we auto-detect existing keys on disk).
2. **Add a source** — drop a folder path. Mnemos scans + classifies + ingests with local BGE-small embeddings (no API key for ingest).
3. **Chat** — ask a question, see streamed answers with inline citations to the exact source chunks.

End-to-end in under 90 seconds on a typical laptop.

Prefer Docker? `docker compose up -d`. Prefer manual? `pnpm install && pnpm dev`.

## What Mnemos is

- **Local-first**: SQLite + sqlite-vec, single file at `~/.mnemos/mnemos.db`. No separate vector database.
- **Free by default**: Bundled local embedding model (BGE-small via ONNX) means RAG works out of the box with zero external services and zero API costs. Bring your own Anthropic / OpenAI key for chat — or run fully local via Ollama.
- **Single user**: One person, one machine. Loopback bind by default; LAN binding requires explicit opt-in and bearer-token auth.
- **Pluggable providers** (v0.1 wired): Anthropic, OpenAI, Ollama for chat. Local BGE-small + OpenAI + Ollama for embeddings. Add your own via the plugin SDK. Gemini and bundled llama.cpp providers are stubs scheduled for v0.2.
- **Read-only**: Mnemos never modifies your files. Source access is opt-in per folder.
- **Auditable**: Every query records exactly which chunks were retrieved, what was sent to the LLM, and how many tokens it cost. Visible in the UI.
- **Safe defaults**: Auto-excludes credentials (`.env`, `*.pem`, `id_rsa*`) and noise (logs, lockfiles, minified bundles). Security excludes are hard-locked even against explicit user opt-in.
- **Citations**: Every answer references the source files, last-modified date, file type, and exact byte range.
- **Incremental**: Re-ingest skips unchanged files via content-hash comparison; partial-state ingests recover automatically via the `ingest_status` invariant.

## What Mnemos is not

- Not multi-tenant. Single user.
- Not a no-code visual builder. Opinionated pipeline.
- Not an agent platform. RAG only.
- Not a SaaS. Run it yourself.

## Status

Pre-release. v0.1 is being built. Track progress in [CHANGELOG.md](CHANGELOG.md).

## Architecture

The repo is a pnpm monorepo:

```
mnemos/
├── apps/web/              # Next.js 15 UI + API routes
├── packages/
│   ├── core/              # RAG pipeline (provider-agnostic)
│   ├── db/                # SQLite + sqlite-vec wrapper
│   ├── plugin-sdk/        # Plugin SDK barrel
│   └── cli/               # `mnemos` CLI
└── plugins/
    ├── embed-local/       # EmbeddingProvider (bundled, default — BGE-small via ONNX)
    ├── anthropic/         # ChatProvider (Claude)
    ├── openai/            # ChatProvider + EmbeddingProvider
    ├── gemini/            # ChatProvider
    ├── ollama/            # ChatProvider + EmbeddingProvider (host-local)
    ├── llama-cpp/         # ChatProvider + EmbeddingProvider (bundled local)
    ├── loader-pdf/        # DocumentLoader
    ├── loader-markdown/   # DocumentLoader
    ├── loader-plaintext/  # DocumentLoader
    ├── loader-web/        # DocumentLoader for URLs
    └── loader-code/       # DocumentLoader for source code
```

Plugins can only import from `mnemos/plugin-sdk`. They cannot reach into `packages/core/**` or other plugins' internals. The SDK is versioned and backward-compatible.

## Trust model

Mnemos uses a **single-user trust model** — one person on one machine, not a multi-tenant service:

- The API is bound to 127.0.0.1 by default and trusts loopback callers (anyone reaching the loopback interface is already on the user's own machine). Binding to LAN (`MNEMOS_BIND=lan`) switches enforcement on and requires `Authorization: Bearer <token>` on every `/api/*` request, matching the auto-generated token at `~/.mnemos/auth.key`.
- Installed plugins are part of the trusted base (documented)
- Source access requires explicit registration (`mnemos source add <path>`)
- Frontier LLMs only see retrieved chunks, never raw files
- The audit log shows exactly what was sent to any external service, on every request

## Roadmap

- **v0.1** (in progress): Docker install, single-folder RAG, BYO API key, audit log
- **v0.2**: npm global install, daemon installer, Telegram bot, email ingestion (Gmail OAuth)
- **v0.3**: macOS/Linux native installers, cross-encoder reranking, plugin marketplace

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). First-time contributors will be asked to sign the [CLA](CLA.md) via the cla-assistant.io bot on their first PR — one click, then you're covered for all future PRs. AI-assisted contributions welcome; see [AGENTS.md](AGENTS.md) for collaboration patterns.

## Code of Conduct

All project-related interaction follows our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately via [GitHub Security Advisory](https://github.com/cosmicflow-space/mnemos/security/advisories/new). See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE). Copyright © Zen Algorithms LLC

The CLA on contributions preserves the option to release additional terms (e.g. an Enterprise edition) in the future without re-permissioning prior contributors. The MIT-licensed code stays MIT-licensed.

## Credits

Mnemos is original work, written from scratch in TypeScript. Architectural choices were informed by surveying the broader RAG and personal-knowledge-base ecosystem.
