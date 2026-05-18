---
name: Feature request
about: Suggest a capability or improvement
title: "[feature] "
labels: enhancement
assignees: ''
---

## What problem does this solve

<!-- Describe the user problem, not the solution. Focus on the friction
you hit or the question you couldn't answer. -->

## Proposed solution

<!-- Your idea for how to address it. Sketches, API shapes, UI mocks all welcome. -->

## Alternatives considered

<!-- Other ways to solve the same problem, and why you didn't pick them. -->

## Scope fit

Mnemos is intentionally narrow (see [AGENTS.md](../AGENTS.md) north-star).
Confirm your request fits:

- [ ] It's RAG-related (not a general agent / workflow builder feature)
- [ ] It's single-user / single-machine (not multi-tenant)
- [ ] It doesn't require writing to user files (Mnemos is read-only by default)
- [ ] If it adds a provider or loader, it can ship as a plugin via `mnemos/plugin-sdk`

If any of these are unchecked, please open a [discussion](https://github.com/cosmicflow-space/mnemos/discussions) instead — that's the right venue for scope debates.

## Additional context

<!-- Screenshots, related issues, links. -->
