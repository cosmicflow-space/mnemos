# 🧠 Mnemos

**Personal RAG. Local-first. Drop a folder, ask a question.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Pre-release](https://img.shields.io/badge/Status-Pre--release-orange.svg)]()

Mnemos is a personal RAG (retrieval-augmented generation) system that runs entirely on your own machine. Drop a folder of documents, ask questions in plain English, and get answers with file citations. Your files never leave your computer; only the retrieved chunks are sent to whichever LLM you choose, and you can see exactly what was sent in the audit log.

> Mnemos is built from scratch in TypeScript + Next.js. No drag-and-drop canvas — opinionated UI, one strong default per pipeline stage. Architectural ideas were informed by studying mature OSS in the RAG and personal-assistant space.

## Quick start

```bash
git clone https://github.com/sammuthu/mnemos.git
cd mnemos
docker compose up -d
```

Open http://localhost:3030, paste your API key (or pick local Ollama), register a source folder, ask a question. End-to-end in under 90 seconds.

Or run from source:

```bash
pnpm install
pnpm dev
```

Requires Node 22+ and pnpm 9+.

## What Mnemos is

- **Local-first**: SQLite + sqlite-vec, single file at `~/.mnemos/mnemos.db`. No separate vector database.
- **Free by default**: Bundled local embedding model (BGE-small via ONNX) means RAG works out of the box with zero external services and zero API costs. Bring your own Anthropic / OpenAI / Gemini key for chat — or run fully local with Ollama or llama.cpp.
- **Single user**: One person, one machine. Bearer-token auth bound to 127.0.0.1 by default.
- **Pluggable providers**: Anthropic, OpenAI, Gemini, Ollama, node-llama-cpp for chat. Bundled local, OpenAI, and Ollama for embeddings. All visible from first run. Add your own via the plugin SDK.
- **Read-only**: Mnemos never modifies your files. Source access is opt-in via `mnemos source add <path>`.
- **Auditable**: Every query records exactly which chunks were retrieved, what was sent to the LLM, and how many tokens it cost. Visible in the UI.
- **Citations**: Every answer references the source files and line ranges.

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

- The user authenticates API callers via a bearer token bound to 127.0.0.1 by default
- Installed plugins are part of the trusted base (documented)
- Source access requires explicit registration (`mnemos source add <path>`)
- Frontier LLMs only see retrieved chunks, never raw files
- The audit log shows exactly what was sent to any external service, on every request

## Roadmap

- **v0.1** (in progress): Docker install, single-folder RAG, BYO API key, audit log
- **v0.2**: npm global install, daemon installer, Telegram bot, email ingestion (Gmail OAuth)
- **v0.3**: macOS/Linux native installers, cross-encoder reranking, plugin marketplace

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). AI-assisted contributions are welcome; see [AGENTS.md](AGENTS.md) for collaboration patterns.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Mnemos is original work. The broader RAG and personal-assistant OSS ecosystem (including [Flowise](https://flowiseai.com), [OpenClaw](https://openclaw.ai), [AnythingLLM](https://anythingllm.com), [Khoj](https://khoj.dev), [PrivateGPT](https://privategpt.dev), [LangChain.js](https://js.langchain.com), and many others) informed our thinking about what shape a personal RAG product should take. All Mnemos code is written from scratch in TypeScript; no source was copied from any of those projects.
