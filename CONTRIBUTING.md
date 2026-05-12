# Contributing to Mnemos

Mnemos is intentionally small. The fastest way to be useful: try the install, file an issue with reproduction steps, send a focused PR.

## Ground rules

- **One PR = one topic.** PRs over ~2,000 changed lines are reviewed only in exceptional circumstances.
- **Match the architectural style** in [AGENTS.md](AGENTS.md). If your change conflicts with it, open an issue first.
- **No scope creep.** Mnemos is RAG-only. Agent platforms, workflow builders, multi-tenant features — all rejected.
- **Read-only by default** — anything that writes to user files needs explicit scope-pairing design discussion first.

## Setup

```bash
git clone https://github.com/sammuthu/mnemos.git
cd mnemos
pnpm install
pnpm dev
```

Requires Node 22+ and pnpm 9+.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm lint
```

All must pass before opening a PR.

## Plugin contributions

External plugins live in their own repos as `mnemos-plugin-*` npm packages. The bundled plugins in this repo are the official baseline; add new bundled plugins via PR only when:
- The capability is not addressable as a third-party plugin
- There's a clear maintainer-ownership commitment
- The plugin meets the SDK boundary discipline

## License

By contributing, you agree your contributions are licensed under MIT (same as the project).

## Security

See [SECURITY.md](SECURITY.md) (coming in v0.1). Report vulnerabilities privately via GitHub Security Advisory.
