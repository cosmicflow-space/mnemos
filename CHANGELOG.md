# Changelog

All notable changes to Mnemos will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.16.0] - 2026-06-01

### Added
- **Smart prefix routing — pick retrieval + model tier per message.** A leading sigil now chooses *whether to search your files* and *which brain answers*, with no menus, identical on web and Telegram:

  |                     | Local (private, free) | Frontier cheap | Frontier flagship |
  |---------------------|-----------------------|----------------|-------------------|
  | **Search my files** | *(no prefix)*         | `+`            | `++`              |
  | **Skip (direct)**   | `!`                   | `!!`           | `!!!`             |

  The `!` family skips retrieval (extends v0.15.0's direct mode); the `+` family runs RAG but answers with a frontier model. Repeats escalate the tier. Frontier tiers auto-resolve to the **cheapest** (or **most capable**, for the doubled sigils) *configured* frontier model by pricing metadata — no hardcoded provider IDs (a provider counts as "frontier" if it needs an API key, so local Ollama is excluded automatically). With no frontier key configured, the request is rejected with a clear "add an API key" prompt instead of failing opaquely. `!`/`+` were chosen over `#` because `#`/`@`/`/` are special in Telegram (hashtag/mention/command) while `!`/`+` are inert — so the exact syntax works on the phone too. Parsing is one shared pure module (`query-routing.ts`) used by the web client (optimistic UI), the API route (authoritative), and the Telegram poller; tier→model resolution is a second shared module (`model-routing.ts`). Answers are labeled with the mode + model, and the audit log records provider/model/direct, so each query's privacy posture stays provable. Covered by new parser and resolver unit tests.

- **`/tips` input-help command** (web + Telegram). Sends back the routing-prefix cheatsheet from a single shared source (`input-tips.ts`) — rendered as a table in the web chat and plain text on Telegram, with no model call. Designed to grow: new shortcuts are added in one place and appear everywhere (the web input legend, `/help`, and `/tips` all render from the one registry). The web input also shows a live legend that flips to a mode indicator as you type a sigil.
- **`/cost` usage & spend command** (web + Telegram). Reports **estimated frontier spending** computed from provider-reported token counts × per-model pricing (with the pricing date shown): **total to date**, **cost by model**, **queries split frontier vs local**, **total tokens**, **number of sessions**, **most expensive session**, and **longest session**. Local (Ollama) queries are free and counted separately. Computed on-device from your own history (`getSessionUsage` + the plugins' pricing); the cost math is a pure, unit-tested `buildCostReport`. Backed by `GET /api/cost`.

### Changed
- The query API now parses the routing prefix server-side from the raw message (the client no longer sends a `direct` flag), so routing can't be spoofed and the web/Telegram/route paths share one source of truth.
- Routing labels (`direct`) now persist on chat messages, so a reloaded `!` turn keeps its "Direct · files not searched" badge; the frontier badge is derived from the persisted provider so `+`/`++` turns stay labeled across reloads.

### Docs
- **Model routing, model switching, and usage visibility are now first-class in the README** — a prominent "Smart model routing" section (with the matrix, mobile examples, and the direct-vs-RAG distinction) appears near the top instead of as a buried bullet, followed by a "Usage & cost visibility" section documenting `/cost`. The Telegram setup guide documents the prefixes and `/tips`.

## [0.15.0] - 2026-06-01

### Added
- **Direct-to-model mode — ask the model, not your files.** Prefix any message with `!` (e.g. `!which model am I using?`) to bypass retrieval entirely: no embedding, no vector search, no verified-answer/corpus injection. The model answers from its own knowledge plus the conversation, with a small **session-facts** note (active provider + model) injected so meta-questions like "which model am I using?" are answered truthfully instead of the model guessing its own identity. Plain text still routes through RAG; `/` stays reserved for commands. The `!` sigil was chosen because it's **inert in Telegram** (unlike `/`, `#`, `@`, which Telegram turns into commands/hashtags/mentions), so it behaves identically in the web app and on the phone. Detection lives in the core pipeline (`runQuery`), so both channels share one implementation. Answers are labeled **"Direct · files not searched"** (web) / "🧠 Direct (no file search)" (Telegram), and the input placeholder + Telegram `/help` + the Telegram setup guide all surface the feature. Covered by a new test that proves retrieval is skipped (it injects an embedder that throws and asserts the query still succeeds).

### Changed
- **Audit records direct queries distinctly.** A direct query is logged with `direct: true` and an empty `retrievedChunkIds`, so the audit log can now prove *per query, by inspection* whether your documents were consulted — previously "no sources" was ambiguous (nothing found vs. retrieval skipped). The streaming/persist/audit tail of `runQuery` was extracted into a shared helper so the RAG and direct paths can't drift in how they record usage, citations, or audit data.

## [0.14.2] - 2026-05-31

### Docs
- **README synced to reality.** The hand-written Status, Roadmap ("Shipped since v0.1"), feature-tree, and "Directions we're exploring" sections had frozen at v0.9 even though the CHANGELOG tracked every release — so the README under-stated what ships today. Status now reads v0.14; the roadmap lists v0.10–v0.14 (pausable ingestion, Word/Excel/image-OCR, folder picker, worker-thread embedding, ranked model picker, smart-auto ingestion); image-OCR/Word/Excel moved out of "exploring" (they shipped in v0.12); the plugin tree now lists `loader-docx`/`loader-xlsx`/`loader-ocr`. `AGENTS.md`'s bundled-loader list updated to match.
- **Stale "lands in v0.2" promises de-versioned across docs and code.** Pinning a future feature to a hard version number guaranteed it would read as nonsense once that version shipped without it (we're at v0.14, so "scheduled for v0.2" pointed at the *past*). Forward-looking notes in `README.md`, `AGENTS.md`, `docs/architecture.md`, `evals/README.md`, `setup.mjs`, and several plugin/source comments now describe *state* ("planned", "not yet wired") instead of a version. Fixed two now-false code comments in `classify.ts` ("images need OCR which lands in v0.2" — OCR shipped in v0.12) and corrected `docs/architecture.md` drift (API layer is Next.js App Router, not "Hono routes"; "explicit source registration", not "folder-pairing").
- **Audit doc corrected:** provider-reported token counts are already captured per query (`tokens_in`/`tokens_out`); only the exact request payload remains a future goal — the docs had listed both as not-yet-done.
- **Gemini / `llama.cpp` framing made consistent.** The README listed Gemini (and bundled `llama.cpp`) as usable Tier-2 providers in the intro, Telegram, and tier lists, but both are scaffolded stubs that aren't wired. They are now consistently labeled **planned** wherever they appear (including the architecture tree and the ADC-detection note shown in the credential scanner UI), so a user can't pick a provider that silently does nothing. Behavior unchanged — only displayed copy and comments.

## [0.14.1] - 2026-05-30

### Added
- **Frontier models show dated pricing in the picker.** Anthropic/OpenAI models now render as detail rows (context window + `$in / $out per 1M`) with a **"Pricing as of <date>"** stamp — the same details-forward treatment local models get, but for cost, so a stale rate is obvious (providers change pricing). Carried via a new optional `pricedAsOf` on `ModelInfo`.
- Refreshed the model-picker and Sources screenshots to the v0.14 UI (ranked local models, dated frontier pricing, smallest-first + defer-large).

## [0.14.0] - 2026-05-30

### Added
- **Model picker that ranks for you — no more trial-and-error.** Selecting Ollama now shows models **ranked balanced-first** (speed × accuracy), each row with params · size · quant · a Fast/Moderate/Slow badge · **measured tokens/sec from your own past queries** · a ★ on the recommended pick. Accuracy is a curated heuristic (3–8B instruct = strong; coder = mixed for prose; reasoning = thorough-but-slow; tiny = shallow); speed is real once you've run a model. It also **recommends strong models you don't have yet** (shown with `⤓ ollama pull <id>`), tailors guidance to your machine (RAM + Apple Silicon/arch → a size band), and links to the model library — so new users get pointed at good choices instead of guessing. Powered by `GET /api/models/ranked` + per-model latency stats from the audit log.

### Changed
- **Smart-auto ingestion.** Before indexing, Mnemos now shows a plain-language estimate ("Indexing N files · ~X chunks · ~Y min") and ingests **smallest-first** so quick answers appear in seconds instead of being blocked behind a giant PDF. A **"Index large files (>10 MB) in the background"** toggle indexes small files now and hands the big ones to a background run (non-blocking, thanks to worker-thread embedding) — small files stay queryable while the rest catch up.

## [0.13.0] - 2026-05-30

### Changed
- **Local embedding now runs on a worker thread — the UI no longer freezes during a large ingest.** Local embedding (ONNX/`@xenova/transformers`) is CPU-bound and was running on the Node main thread, so a big ingest starved the event loop: queries, config save, and even Pause hung for 10–20s+. Embedding is now offloaded to a worker thread (`apps/web/lib/embed-worker.mjs`, same BGE-small model + pooling so vectors are identical), keeping the main thread free. Measured during a live ingest: `/api/sources` and `/api/config` went from 12–20s timeouts to **~25ms**, and Pause now takes effect in ~2s. The worker is shared across bundles (pinned on `globalThis`); set `MNEMOS_EMBED_INLINE=1` to force the old in-process path. Frontier embedders (network I/O) still run inline.
- **Ingest yields between embed batches** (`setImmediate`, plus an optional `MNEMOS_INGEST_THROTTLE_MS` / `embedThrottleMs` deliberate delay) so API-based embedders don't starve concurrent requests either.

## [0.12.2] - 2026-05-30

### Changed
- **Docs: regenerated the hero GIF and all screenshots for the v0.12 brand.** The README hero (`docs/demo/hero.gif`) and all six screenshots were recaptured against the demo corpus showing the new logo mark + two-tone neuron wordmark — neutral `/tmp/aurora-demo` paths, no real data. README H1 emoji dropped and the status badge bumped v0.9 → v0.12. No code/behavior change.

## [0.12.1] - 2026-05-30

### Changed
- **Brand refresh.** The logo mark is bolder and tighter — thicker strokes and a cropped viewBox so it holds up at small sizes (header, favicon) instead of floating in padding. The wordmark is now a shared `Wordmark` component with a two-tone treatment — cyan "Mnem" + amber "s" with the "o" rendered as a neuron glyph (cyan ring, amber core, synapse dots) echoing the logo palette and the memory motif. Header and landing hero now render the identical component (previously the header was plain white and the hero used a different gradient), so the brand can't drift; the favicon and OG/Twitter/apple-icon all share the updated `logo.svg`.

## [0.12.0] - 2026-05-30

### Added
- **Folder/file picker for Add Source.** A **Browse…** button opens a server-powered picker that navigates your real filesystem and returns true absolute paths — so a source path is correct by construction, no typing or pasting required. (A browser's file dialog can't hand back an absolute path; since Mnemos runs locally, the new `GET /api/browse` lists directories server-side instead.) Navigate with breadcrumb/up/home, click a folder to enter it, "Use this folder" to pick it, or click a file to pick a single-file source. Paste still works and is now **validated** — a path that doesn't exist nudges you to the picker instead of registering a dead source. Security: browse is **loopback-only** (disabled under `MNEMOS_BIND=lan`), reuses the ingest security hard-locks so credential files/dirs are never listed, hides hidden entries, and is strictly read-only. Covered by `apps/web/browse.test.ts`.
- **Image OCR (.png / .jpg / .tif / .tiff / .bmp / .webp).** Drop screenshots, scans, or photos containing text into a source and Mnemos OCRs them to searchable text via `tesseract.js` (WASM Tesseract — no system binary, keeping the Node-only install; English trained-data is fetched and cached on first use, like the embedding model). Static raster images only; scanned-PDF OCR (needs a PDF→raster step) and HEIC are follow-ups. Externalized like the other heavy loaders; pre-parse size cap, with the same documented zip-bomb/DoS caveat (OCR is CPU-heavy — it runs in the background and is pausable).
- **Word & Excel ingestion (.docx / .xlsx).** New document loaders extract Word documents (via `mammoth`) and spreadsheets (via exceljs, rendered per-sheet to CSV-style text) — drop them into a source and they're chunked, embedded, and searchable like everything else. Externalized like the PDF loader (`serverExternalPackages` + `webpackIgnore` + `apps/web` deps so the parsers' internals don't break the webpack bundle), and covered by the loader-resolution regression test.

### Fixed
- **Pasted quoted paths no longer corrupt a source.** macOS Finder's "Copy as Pathname" wraps paths containing spaces or special characters (e.g. iCloud's `~/Library/Mobile Documents/com~apple~CloudDocs/…`) in single quotes. Pasting that verbatim into Add Source stored the path *with* the quotes — the leading quote made it relative, so it resolved under the server's cwd to a path that doesn't exist, and the source silently ingested nothing. Path ingress (`POST/PATCH/DELETE /api/sources`, `POST /api/sources/scan`, `POST /api/ingest`) now strips one layer of matching surrounding quotes before expanding `~` and resolving, via a shared `normalizeUserPath` helper (replaces three duplicated `expandHome` copies). Input that is empty once the quotes are removed (`''`, `"  "`) is rejected with a 400 instead of silently resolving to the server's working directory. Covered by `apps/web/user-path.test.ts`.

### Security
- **Credential directories are hard-locked by their true target path.** Added `.ssh/` and `.gnupg/` to the ingest security hard-locks (the `.ssh/` case was documented but never implemented — `.ssh/config`/`known_hosts` could previously be ingested). Directory source roots are now canonicalized with `realpath` before scanning, so a benignly-named **symlink** pointing at a credential dir (e.g. `~/Documents/notes → ~/.ssh`) is security-checked against its real target instead of the alias — closing a path where credential files could enter the index. The new `/api/browse` mirrors this: it refuses to list a credential directory (direct or via alias) and drops symlink entries whose target is a secret. Found in partner review of the folder-picker change.

## [0.11.0] - 2026-05-30

### Fixed
- **Filename-mention questions now return file *contents*, not just metadata.** A file's synthetic metadata chunk (path/size/type) is a strong lexical match for questions that name the file ("VIN in ipostal?") but holds no answer, so at scale it could out-rank and bury the file's own content. Retrieval now co-retrieves a file's content chunks when it surfaced only via its metadata chunk, spliced adjacent and bounded by a fixed budget. (#17)

### Added
- **Source containment guard.** Adding a folder that's already *inside* a registered source no longer creates a duplicate — Mnemos detects the overlap (realpath + path-boundary check) and refreshes the parent so the subfolder is indexed under it (one source). Adding a folder that *contains* existing sources warns and offers "Add anyway". Stops the silent double-ingestion that overlapping sources would otherwise cause.
- **Pausable / resumable ingestion.** Pause a running ingest per source — or all at once ("Pause all", e.g. before bed or on heavy CPU) — from the Sources panel; **Resume** continues where it left off (incremental: already-finished files are hash-skipped). New `POST /api/ingest/pause` and `/api/ingest/resume`; the launcher ring shows amber while paused. Pause is **durable** (persisted `source.paused` flag): it survives a restart and the background watcher skips paused sources (no auto-resume). Cooperative: stops at a file boundary, leaving any interrupted file `partial` so resume reprocesses it. Watcher re-scans are pausable too.
- **Ingestion status indicator.** The settings launcher (bottom-left) now reflects live ingestion: a breathing cyan ring while a source is ingesting (with a `done/total` tooltip), amber when paused (PR-2), red on error. New in-memory status registry + `GET /api/ingest/status`; the manual ingest route and background watcher both report progress. Pinned to `globalThis` so the watcher (instrumentation bundle) and routes share one instance.
- **Count/inventory questions answered from exact totals.** "How many documents/files do I have?", "what types?", "which sources?" are now answered from a COUNT-based Library Overview (total files, chunks, by type, by source) injected into the prompt for inventory-intent questions — instead of the model counting the handful of retrieved chunks. Gated to inventory questions so normal queries pay no aggregate cost. (#18)

## [0.10.0] - 2026-05-30

### Fixed
- **PDF ingestion in `next dev`.** `pdf-parse` is externalized in `next.config` and pulled through a `webpackIgnore`'d, string-built `require`, so it must resolve from `apps/web`'s own `node_modules` at runtime. In a production `standalone` build the dependency trace copies it in, but `next dev` has no trace — so PDFs silently failed to ingest in dev (`load-error`) while passing in production. Fixed by declaring `pdf-parse` as a direct dependency of `@mnemos/web` (mirroring `@xenova/transformers`). Added a regression guard (`apps/web/loader-externals.test.ts`) asserting the `webpackIgnore`'d loader deps resolve from `apps/web`.

### Added
- **`MNEMOS_PORT` override (cross-platform).** `pnpm dev`/`pnpm start` now honor `MNEMOS_PORT` (default `3030`), matching the long-documented override. Combined with `MNEMOS_STATE_DIR`, this lets a personal vault and a dev/test instance run side by side on separate ports and separate SQLite state. Port/host resolution moved out of POSIX shell parameter expansion into a small Node launcher (`apps/web/scripts/run.mjs`), so the override (and `MNEMOS_BIND`, including the `lan` alias) works on Windows `cmd.exe` too — not just POSIX shells.
- **Public demo corpus** (`docs/demo/corpus/`): a small, PII-free fictional product knowledge base (Markdown spec + plaintext FAQ + generated PDF report) that exercises all three loaders and produces cross-document cited answers — used for screenshots and the hero GIF.

### Changed
- **Refreshed hero GIF and screenshots** to the v0.9 single-pane UI. New composite hero (`docs/demo/hero.gif`, desktop + phone "ask from your phone" beat; the 23 MB terminal install GIF is archived). README's screenshot table now shows the current chat/model/sources/citations panes captured against the demo corpus (neutral paths, no real data).

### Docs
- `AGENTS.md` Map now documents the `instrumentation.ts` background services (source watcher + Telegram poller) and the Telegram remote-channel subsystem.

## [0.9.0] - 2026-05-30

### Added
- **Telegram remote channel — ask your RAG from your phone.** Pair a private Telegram bot and query your indexed documents from anywhere. Uses long polling, so Mnemos reaches *out* to Telegram — no public server, no tunnel, nothing inbound exposed (works behind home NAT). **Default-deny security**: the bot answers only chats you've paired via a single-use, time-boxed, CSPRNG pairing code; **direct messages only** (groups refused); query-only (no source/admin commands). Your documents never leave the machine — only the question and answer transit Telegram. Replies use your configured model. Set up in **Settings → 📲 Telegram**; the bot token is stored locally (`~/.mnemos/.env`, never logged). Reviewed by a 3-way AI security pass (no authorization bypass, no token leakage, atomic pairing).
- **Telegram onboarding guide** (`/telegram-guide`, linked from the Telegram panel): step-by-step for users new to Telegram bots, with optional drop-in screenshot slots and a link to Telegram's official tutorial.
- **Model selection persisted server-side**: the model you pick in the UI is now saved (`MNEMOS_DEFAULT_MODEL`) so server-initiated queries (the Telegram bot) mirror your choice across restarts.
- **Design note**: `docs/design-notes/verified-answer-memory.md` documents how verified-answer memory works (soft cache, vector-matched, lazy invalidation) and records considered-and-deferred alternatives.

### Changed
- **Auto re-scan now defaults to Manual.** New sources are no longer auto-scanned daily by default — most people add static documents and don't want background CPU spent re-scanning them. Point a changing folder at a faster cadence from the Sources dropdown anytime. (Existing sources keep their current setting.)
- **README/About page** brought current: a prominent "Ask from your phone" section, the new features (single-file sources, per-file metadata, auto re-scan, verified memory, Telegram), an accurate single-pane UI walkthrough, and a refreshed (non-committal) roadmap including possible richer file types (images via OCR/vision; audio/video via local speech-to-text).

## [0.8.0] - 2026-05-30

### Added
- **Automatic re-scan (per-source schedule)**: Mnemos now re-checks your sources in the background and re-ingests changes on its own — no need to click ↻ Re-scan. Each source has its **own cadence** (set when you add it, editable anytime): **Daily** by default, down to every 5 minutes for hot folders, or **Manual only** to opt a static archive out entirely. Re-scans are incremental, so only changed/new files re-embed. The Sources panel shows each source's cadence and when its next scan is due. Implemented as a periodic poll (not a live filesystem watcher) started via Next.js `instrumentation.ts`; tune with `MNEMOS_WATCH_TICK_MS`, disable with `MNEMOS_DISABLE_WATCHER=1`. New `watch_interval_ms` + `last_scanned_at` on `source`; `PATCH /api/sources` to edit cadence.
  - **Concurrency-safe**: manual ↻ Re-scan, the background watcher, and even multiple server processes coordinate through an atomic DB ingest lease (`source.ingesting_since`), so the same source is never ingested twice at once (which would otherwise race chunk writes). A failed auto-scan stays due and retries next tick instead of going quiet for a full interval; a crashed lease self-heals after 30 minutes.

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

<!-- Version links: each header above is a GitHub compare view of that release's diff.
     [Unreleased] is a live diff of everything on `main` since the latest tag. -->
[Unreleased]: https://github.com/cosmicflow-space/mnemos/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.14.2...v0.15.0
[0.14.2]: https://github.com/cosmicflow-space/mnemos/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/cosmicflow-space/mnemos/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.12.2...v0.13.0
[0.12.2]: https://github.com/cosmicflow-space/mnemos/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/cosmicflow-space/mnemos/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.5.0...v0.8.0
[0.5.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/cosmicflow-space/mnemos/compare/v0.1.0-rc.1...v0.2.0
[0.1.0-rc.1]: https://github.com/cosmicflow-space/mnemos/releases/tag/v0.1.0-rc.1
