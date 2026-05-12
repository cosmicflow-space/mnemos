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

### Coming next (v0.1)
- Plugin SDK barrel (`packages/plugin-sdk`)
- SQLite + sqlite-vec layer (`packages/db`)
- Core RAG pipeline (`packages/core`)
- Next.js UI (`apps/web`)
- Bundled provider plugins (anthropic, openai, gemini, ollama, llama-cpp)
- Bundled loader plugins (pdf, markdown, plaintext, web, code)
- `mnemos` CLI for `pair`, `ingest`, `auth`, `doctor` commands
