# Contributing to Mnemos

Mnemos is intentionally small. The fastest way to be useful: try the install, file an issue with reproduction steps, send a focused PR.

## Ground rules

- **One PR = one topic.** PRs over ~2,000 changed lines are reviewed only in exceptional circumstances.
- **Match the architectural style** in [AGENTS.md](AGENTS.md). If your change conflicts with it, open an issue or [discussion](https://github.com/cosmicflow-space/mnemos/discussions) first.
- **No scope creep.** Mnemos is RAG-only. Agent platforms, workflow builders, multi-tenant features — all rejected.
- **Read-only by default** — anything that writes to user folders needs explicit design discussion first.

## Setup

```bash
git clone https://github.com/cosmicflow-space/mnemos.git
cd mnemos
node setup.mjs   # cross-OS bootstrap; falls back to pnpm install + pnpm dev
```

Requires Node 22+. The bootstrap installs pnpm via corepack and walks you through provider configuration. See [`INSTALL.md`](INSTALL.md) for the full playbook.

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
- The plugin meets the SDK boundary discipline (imports only from `mnemos/plugin-sdk`)

## Signing commits

We **recommend** [signed commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification) and will move to **required** once the maintainer team has signing wired everywhere. Configure GPG or SSH signing once and you're set:

```bash
git config commit.gpgsign true
# Configure your signing key per GitHub docs above.
```

Signed commits show a green **Verified** badge in the GitHub UI, which is what acquisition and security reviews look for when auditing the contribution chain.

## Contributor License Agreement

First-time contributors will be prompted by the [cla-assistant.io](https://cla-assistant.io) bot on their first PR. Sign once via the GitHub-authenticated flow and you're covered for every subsequent PR to any `cosmicflow-space` repository.

See [CLA.md](CLA.md) for what you're agreeing to and why we use one (short version: it preserves the option to dual-license later without re-permissioning every prior contributor).

## License

By contributing, you agree your contributions are licensed under MIT (the project's current license) and that you grant the rights described in [CLA.md](CLA.md) to allow future re-licensing under additional terms.

## Code of Conduct

All project-related interaction is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). Report incidents privately to **conduct@cosmicflow.space**.

## Security

Vulnerability reports go through [GitHub Security Advisory](https://github.com/cosmicflow-space/mnemos/security/advisories/new) — see [SECURITY.md](SECURITY.md). Please don't file security issues as public issues.

## AI-assisted contributions

AI-assisted PRs are welcome. The contributor is responsible for the diff regardless of tooling. See [AGENTS.md](AGENTS.md) for the collaboration patterns this repo expects when LLMs are in the loop.
