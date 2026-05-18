<!--
Thanks for opening a PR! A few quick checks before you mark it ready for
review. Delete sections that don't apply.
-->

## What this PR does

<!-- One paragraph. Focus on the *why*, not the *what* — the diff shows the what. -->

## How to verify

<!-- Steps a reviewer can take to confirm the change works end-to-end.
Ideally: a curl/UI sequence + the expected output. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (API / schema / plugin SDK)
- [ ] Documentation only
- [ ] Refactor / internal cleanup

## Checklist

- [ ] One PR = one topic. (PRs > 2,000 lines are reviewed only in exceptional cases.)
- [ ] Matches the architectural style in [`AGENTS.md`](../AGENTS.md).
- [ ] Tests pass: `pnpm test && pnpm typecheck && pnpm lint`
- [ ] If this touches the pipeline or schema, I've considered the atomic-ingest invariants (`ingest_status` transitions, `countChunksForFile` guard).
- [ ] If this adds a new dependency, I've checked the 48-hour-minimum-release-age policy in `pnpm-workspace.yaml`.
- [ ] If this adds a new plugin or provider, it imports only from `mnemos/plugin-sdk`.
- [ ] I've updated `CHANGELOG.md` if the change is user-visible.
- [ ] CLA — bot will prompt me; this is my reminder that I'll need to sign it for first-time contributions.

## Related issues / discussions

<!-- "Fixes #123" or "Refs #45" or a link to the discussion this implements. -->
