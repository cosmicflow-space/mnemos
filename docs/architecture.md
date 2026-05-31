# Mnemos Architecture (brief)

This is a short pointer document. The **full architecture specification** with mermaid diagrams, threat model, data schema, and build sequence lives in the planning workspace:

📄 `~/Projects/agentic-framework/oss-rag-planning/ARCHITECTURE.md`

Supporting documents in the same directory:
- `PLAN.md` — strategic plan and decision log
- Competitive-landscape notes (patterns adopted / adapted / avoided from the broader RAG and personal-knowledge-base ecosystem)

The architecture writeup also publishes to:
- https://sammuthu.com/ai-ml/mnemos

## TL;DR

**5 layers**:

```
┌─────────────────────────────────────────┐
│  UI (Next.js: chat + folders + audit)   │
├─────────────────────────────────────────┤
│  API (Next.js App Router, bearer auth)  │
├─────────────────────────────────────────┤
│  Core RAG pipeline (provider-agnostic)  │
├─────────────────────────────────────────┤
│  Plugin SDK boundary (versioned)        │
├─────────────────────────────────────────┤
│  Providers (LLM, embedding, loaders)    │
└─────────────────────────────────────────┘
              ▼
   SQLite + sqlite-vec at ~/.mnemos/mnemos.db
```

**Trust model**: Single operator, single machine. Bearer token auth, default bind 127.0.0.1, explicit source registration for ingestion scope, read-only by default, frontier LLMs only see retrieved chunks.

**Stack**: TypeScript + Next.js 15 + React 19 + Tailwind v4 + sqlite-vec + better-sqlite3 + Anthropic/OpenAI/Ollama providers (Gemini + node-llama-cpp scaffolded, planned).

**License**: MIT.
