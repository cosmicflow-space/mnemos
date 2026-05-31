<div align="center">

# Mnemos

**Personal RAG. Local-first. Drop a folder, ask a question.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: 22+](https://img.shields.io/badge/Node-22%2B-339933.svg)](https://nodejs.org/)
[![Status: v0.12](https://img.shields.io/badge/Status-v0.12-cyan.svg)](CHANGELOG.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-cyan.svg)](CONTRIBUTING.md)

</div>

Mnemos is a personal RAG (retrieval-augmented generation) system that defaults to **100% local** — embeddings on your machine, chat on your machine, zero external inference calls. Drop a folder of documents, ask questions in plain English, get answers with citations to your own files. The audit log captures every query for transparency; in the default install, **query audit events record the local chat provider (`ollama`)** and **ingest events stay local but don't carry a provider field** — no external-provider call is ever recorded.

If you choose to add a frontier LLM (Anthropic Claude, OpenAI, Gemini), mnemos sends only the retrieved chunks — never raw files — and the audit log records the provider, model, retrieved chunk IDs, prompt-token estimate, and latency for each external request. Plugins are opt-in, not required. **Personal RAG means personal RAG. Privacy is the default.**

Built from scratch in TypeScript + Next.js. Opinionated single-pane UI — no drag-and-drop canvas, one strong default per pipeline stage, plug your own providers via a versioned SDK.

<p align="center">
  <img src="docs/demo/hero.gif" alt="Mnemos — cited answers from your own files, on your desktop and from your phone" width="900"/>
  <br/>
  <em>One brain, two surfaces: ask on your desktop, or from your phone via a private Telegram bot — every answer cited to your own files. 100% local by default.</em>
</p>

## Quick start

The only prerequisite is **Node 22+** ([nodejs.org](https://nodejs.org/) if you don't have it).

```bash
git clone https://github.com/cosmicflow-space/mnemos.git
cd mnemos
node setup.mjs
```

That's it. The installer detects your OS (macOS, Linux, Windows), checks what's installed, asks before fixing anything, walks you through provider configuration, and starts the dev server. The install logic lives in [`INSTALL.md`](INSTALL.md) — readable as docs, executable by `setup.mjs`, no per-OS shell scripts to drift.

Then open <http://127.0.0.1:3030> — it's a single chat page. Everything lives behind the **settings launcher** (the glowing avatar, bottom-left):

1. **AI Model** — pick Claude, GPT, or Ollama (we auto-detect existing keys on disk). Local Ollama is the default and needs no key.
2. **Sources** — paste a folder *or single-file* path. Mnemos scans, classifies, and ingests with local BGE-small embeddings (no API key for ingest).
3. **Ask** — type a question; answers stream in with inline citations to the exact source chunks. (No sources yet? It still answers from the model's own knowledge, clearly labelled.)

End-to-end in under 90 seconds on a typical laptop. Then, optionally, pair **📲 Telegram** to ask from your phone.

<p align="center">
  <img src="docs/screenshots/02-launcher-menu.png" alt="Mnemos settings launcher menu — theme, AI model, sources, verified answers, Telegram" width="760"/>
  <br/>
  <em>Everything lives behind the settings launcher: theme, AI model, sources, verified answers, and Telegram.</em>
</p>

Prefer Docker? `docker compose up -d`. Prefer manual? `pnpm install && pnpm dev`.

## What it looks like

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/01-chat-cited-answer.png" alt="Mnemos chat — cited cross-document answer" />
      <p align="center"><sub><strong>1. Ask</strong> — one chat pane, no chrome. Answers stream in with inline numbered citations, a metrics line (provider · model · tokens · duration), and inline actions to inspect <em>Sources</em>, see exactly what was sent to the model (<em>Data sent</em>), and mark an answer <em>✓ verified</em>. This answer fuses facts from a Markdown spec and a PDF report.</sub></p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/03-ai-model-local.png" alt="Mnemos AI model picker — Ollama models ranked by speed and accuracy, frontier providers with dated pricing" />
      <p align="center"><sub><strong>2. Pick your model</strong> — local Ollama models are <strong>ranked for your machine</strong> (fastest + most accurate first), with measured tok/s from your own queries and a ★ recommended default. It even suggests strong models you haven't installed (with <code>ollama pull</code>). Cloud providers stay locked until you add a key — and show <strong>dated pricing</strong> so a stale rate is obvious. Privacy is the default, not a setting.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/05-sources-manage.png" alt="Mnemos sources — Browse or paste a folder/file, read-only, with smallest-first indexing and a defer-large toggle" />
      <p align="center"><sub><strong>3. Add a source</strong> — <strong>Browse</strong> to a folder/file (or paste a path; it's validated). Read-only. Mnemos shows an estimate, then indexes <strong>smallest-first</strong> so answers appear in seconds — and can <strong>defer large files to a background pass</strong>. Chunked + embedded locally (BGE-small), with per-source incremental re-scan.</sub></p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/06-citations-multiformat.png" alt="Mnemos citations — the exact source chunks an answer drew from" />
      <p align="center"><sub><strong>4. Trace every claim</strong> — each answer's <em>Sources</em> opens the exact files it drew from, across formats (.md, .txt, .pdf), with chunk counts. Click a path to copy it. No black-box answers.</sub></p>
    </td>
  </tr>
</table>

## Ask from your phone (Telegram)

Your personal RAG runs on your computer — but you don't have to be *at* your computer to use it. Pair a private Telegram bot and ask questions from anywhere:

- **No public server, nothing exposed.** Mnemos *reaches out* to Telegram (long polling), so it works behind your home NAT with no port-forwarding, no tunnel, no public IP — the same outbound-only posture as everything else.
- **Private by default.** The bot answers **only you**. You pair your phone once with a single-use code from the UI; any other chat is ignored. Direct messages only — never groups.
- **Your documents stay home.** Only the question and answer pass through Telegram (and whichever model you've configured). Files never leave the machine.
- **Uses your configured model.** Local Ollama by default, or Claude/GPT/Gemini if you've set one — the bot mirrors your choice.

Set it up in **Settings → 📲 Telegram** (there's a built-in [step-by-step guide](apps/web/app/telegram-guide/page.tsx) for anyone new to Telegram bots). The catch, by design: your computer must be awake with Mnemos running for the bot to reply.

<p align="center">
  <img src="docs/screenshots/04-telegram-ask-from-phone.png" alt="Mnemos Telegram setup — paste a bot token, enable the channel, pair your phone" width="640"/>
  <br/>
  <em>Paste a bot token, enable the channel, pair your phone with a single-use code — token stored chmod-600, never echoed back.</em>
</p>

> WhatsApp is on the radar but not yet supported — there's no free, local-first-friendly bot API for it the way Telegram offers.

## How private do you want it? Three tiers

**Personal RAG means personal RAG. Privacy is the key — and the default.** Mnemos gives you three privacy tiers, in order of increasing data egress. *You choose.* Most users stay in Tier 1.

### Tier 1 — Fully local (default)
- **Embeddings**: BGE-small via ONNX, on your machine (first use downloads ~120 MB of model weights from Hugging Face once; cached thereafter — see [Offline note](#offline-note) below)
- **Chat**: Ollama (v0.1) or bundled `llama.cpp` (v0.2) — on your machine
- **Network (after first-run model fetch)**: zero external inference calls. No chunks of your data leave the machine.
- **Auth**: none — no API keys, no OAuth
- **Best for**: sensitive data, offline use, full sovereignty

The default install IS this tier. `node setup.mjs` defaults to Ollama (the recommended option, no API key); the `/api/query` route defaults to `providerId: "ollama"` if callers omit it.

<a id="offline-note"></a>**Offline note**: BGE-small (the bundled embedding model) is fetched from Hugging Face on first ingestion, then cached locally. After that one-time fetch the install is fully offline-capable for ingest+local-chat. v0.2 will explore vendoring the model with the install for true zero-network first-run.

### Tier 2 — Hybrid (opt-in, per-question or per-session)
- **Embeddings**: local default (or external if you switch)
- **Chat**: Claude / GPT / Gemini — you pick, you provide auth
- **Network**: only retrieved chunks (~500–2k tokens) cross the boundary. Never raw files. Never your full corpus.
- **Audit**: provider, model, retrieved chunk IDs, prompt-size estimate, latency. Exact payload + provider-reported token counts is a v0.2 goal.
- **Best for**: frontier-model quality, when you've consciously chosen to share retrieved chunks

The chat UI lets you switch the model per question.

### Tier 3 — Fine-tuned local (v0.3 sketch)
Train a small open model on your own corpus. Stays on your machine. Becomes specifically yours over time. Roadmap consideration — community input welcome.

### Vendor authentication — what mnemos accepts

**API key is the safe, sanctioned method for every external provider.** Mnemos's credential-detection feature scans for first-party CLI OAuth files (`~/.claude/.credentials.json` for Claude Code, `~/.codex/auth.json` for the OpenAI codex CLI), surfaces them in the UI as detected, but marks them **non-importable** with a TOS-explanation note. Reusing those tokens in third-party software is either prohibited (Anthropic) or undocumented (OpenAI).

| Vendor | Sanctioned method | Notes |
|---|---|---|
| **Anthropic Claude** | API key only | Anthropic [explicitly prohibits](https://code.claude.com/docs/en/legal-and-compliance) third-party reuse of OAuth tokens from Claude apps. Mnemos detects `~/.claude/.credentials.json` but refuses to import it. |
| **OpenAI / Codex** | API key only | The first-party `codex` CLI supports OAuth, but OpenAI does not document third-party reuse. Mnemos detects `~/.codex/auth.json` but refuses to import it. |
| **Google Gemini** | API key only (in v0.1) | Mnemos v0.1 accepts Gemini API keys only. Google's platform supports both OAuth (via user-created OAuth client + `gcloud auth application-default login --client-id-file=client_secret.json`) and ADC via Vertex AI — both are tracked for v0.2+ but not yet wired in mnemos. |
| **Ollama** | No auth needed | Local daemon, fully sovereign. |
| **llama.cpp** (v0.2) | No auth needed | Bundled, no daemon, no network. |

## What Mnemos is

- **Local-first**: SQLite + sqlite-vec, single file at `~/.mnemos/mnemos.db`. No separate vector database.
- **Private by default**: Bundled local embeddings (BGE-small ONNX) + local chat (Ollama) means RAG runs without any external inference service. Zero API keys, zero external inference calls, zero data egress after the BGE-small weights are cached on first ingestion ([Offline note](#offline-note) above). External LLM plugins are opt-in if you want frontier-model quality.
- **Single user**: One person, one machine. Loopback bind by default; LAN binding requires explicit opt-in and bearer-token auth.
- **Pluggable providers** (v0.1 wired): Anthropic, OpenAI, Ollama for chat. Local BGE-small + OpenAI + Ollama for embeddings. Add your own via the plugin SDK. Gemini and bundled `llama.cpp` providers are stubs scheduled for v0.2.
- **Read-only**: Mnemos never modifies your files. Source access is opt-in per folder.
- **Auditable**: Every `query` event is recorded with chat-provider, model, retrieved chunk IDs, prompt-size estimate, and latency. Every `ingest` event is recorded without a `provider` field (ingest is locked to the local embedder in v0.1). In Tier 1 (local default), `query` events show `provider: "ollama"` (or another local provider) — no external-provider call is ever recorded. Visible in the UI. (v0.2 goal: capture exact request payloads + provider-reported token counts for external calls; add explicit `external: boolean` flag.)
- **Safe defaults**: Auto-excludes credentials (`.env`, `*.pem`, `id_rsa*`) and noise (logs, lockfiles, minified bundles). Security excludes are hard-locked even against explicit user opt-in.
- **Citations**: Every answer references the source files, last-modified date, file type, and exact byte range.
- **Folders or single files**: Register a whole folder *or* one individual file. Mnemos auto-detects which — and the credential hard-lock holds either way (a file under `~/.aws/`, or a symlink to `~/.env`, is still refused).
- **Per-file metadata**: Each file carries a retrievable metadata chunk, so "how big is X" / "when was X modified" answer reliably even when no content chunk ranks high.
- **Incremental & self-updating**: Re-ingest skips unchanged files via content-hash comparison; partial-state ingests recover automatically via the `ingest_status` invariant. Sources can **auto re-scan** on a per-source schedule (manual by default — static archives cost zero background CPU; point a changing folder at a faster cadence from a dropdown). A concurrency-safe lease prevents a manual and a background scan from ever colliding.
- **Verified-answer memory**: Mark a correct answer as verified, and a closely-matching future question gets that confirmed answer injected into the prompt — so even a small local model nails facts it would otherwise fumble. Strict semantic matching, with lazy invalidation when the underlying files change. ([design notes](docs/design-notes/verified-answer-memory.md))
- **Ask from anywhere**: Pair a private Telegram bot and query your RAG from your phone — outbound-only, default-deny, your files never leave the machine (see [above](#ask-from-your-phone-telegram)).

## What Mnemos is not

- Not multi-tenant. Single user.
- Not a no-code visual builder. Opinionated pipeline.
- Not an agent platform. RAG only.
- Not a SaaS. Run it yourself.

## Status

Active development — **v0.9**. The core (local-first RAG, audit, atomic ingestion, cross-OS install) has been stable since v0.1; releases since then have added single-file sources, per-file metadata, automatic re-scan, verified-answer memory, and the Telegram remote channel. Track every release in [CHANGELOG.md](CHANGELOG.md).

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

- **Default = zero external inference calls.** Local embeddings + Ollama for chat = no chunks of your data leave your machine. The audit log proves it by inspection: in Tier 1, `query` events record `provider: "ollama"` (or another local provider), and `ingest` events stay local without recording any provider field — no external-provider call is ever recorded. (One-time exception: BGE-small embedding weights are fetched from Hugging Face on first ingestion, then cached — see [Offline note](#offline-note).)
- The API is bound to 127.0.0.1 by default and trusts loopback callers (anyone reaching the loopback interface is already on the user's own machine). Binding to LAN (`MNEMOS_BIND=lan`) switches enforcement on and requires `Authorization: Bearer <token>` on every `/api/*` request, matching the auto-generated token at `~/.mnemos/auth.key`.
- Installed plugins are part of the trusted base (documented)
- Source access requires explicit registration (`mnemos source add <path>`)
- Frontier LLMs (Tier 2 only) see only retrieved chunks, never raw files
- The audit log captures provider, model, retrieved chunk IDs, prompt-size estimate, and latency for every query — local and external. Exact payload + provider-reported token counts for external calls are a v0.2 goal.
- Audit data lives in the `audit_event` table inside `~/.mnemos/mnemos.db`. Inspect via `/api/audit` or by querying the SQLite table directly. There is **no** separate `audit.log` file.

## Your first 90 seconds

After `node setup.mjs` finishes, open **`http://127.0.0.1:3030`**. It's one page; the **settings launcher** (glowing avatar, bottom-left) opens everything as in-place panels — you never leave the chat.

1. **Settings → AI Model.** Mnemos auto-detects credentials in standard locations (shell rc files, provider auth files, gcloud ADC, the Ollama daemon on `:11434`). Click **Use this** on a detected key to import it (values stay on your machine — only locations are exchanged with the UI), or pick a provider and paste a key. Local Ollama needs none.

2. **Settings → Sources.** Paste a folder *or single-file* path (e.g. `~/Documents/notes` or `~/Documents/resume.pdf`). Mnemos detects which it is, then ingests with a live per-file progress indicator — entirely local via BGE-small, no API key. Security-blocked files (`.env`, `*.pem`, `id_rsa*`, anything under `~/.aws/` or `~/.ssh/`) are hard-locked and never indexed. Set a per-source auto re-scan cadence if the folder changes often (default is manual).

3. **Ask.** Type a question in the chat box. Answers stream in with citations to the exact source files; per-answer **Sources** and **Data sent** panels show precisely which files were used and which chunks (if any) left your machine. Mark a great answer **✓ verified** so it's nailed next time.

4. **Optional — pair Telegram** (Settings → 📲 Telegram) to ask all of the above from your phone.

That's it. End-to-end on a fresh laptop: usually under 90 seconds for the install + 30 seconds for the first ingestion of a small folder.

## Roadmap

**Shipped since v0.1:**
- **v0.5** — verified-answer memory
- **v0.6** — per-file metadata chunks
- **v0.7** — single-file sources + hardened credential guardrail
- **v0.8** — automatic per-source re-scan (concurrency-safe)
- **v0.9** — **Telegram remote channel** (ask your RAG from your phone), model selection persisted server-side

**Foundations (v0.1–v0.4):** single-folder RAG, BYO API key, audit log, atomic ingestion, smart-default file exclusions, credential auto-detection, bearer-token auth (loopback bypass), cross-OS install via `setup.mjs`, in-chat onboarding, per-model cost tracking, rich Markdown output, light/dark theme.

**Directions we're exploring** *(ideas, not promises — community input very welcome):*
- **More file types** beyond text & PDF — images (OCR for text-in-images, or vision-model description) and audio/video (local speech-to-text). Today these are detected and politely deferred rather than ingested.
- **Better answers** — cross-encoder reranking of retrieved chunks; Gemini + bundled `llama.cpp` providers fully wired.
- **Easier installs** — npm global install, native macOS/Linux installers.
- **More places to ask from** — WhatsApp (pending a local-first-friendly API path), email ingestion.

These follow the project's north star: local-first, single-operator, RAG — not an agent platform. We'd rather ship a few things well than promise many.

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
