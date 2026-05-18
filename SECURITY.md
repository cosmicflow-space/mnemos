# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisory at
<https://github.com/cosmicflow-space/mnemos/security/advisories/new> rather
than opening a public issue. We acknowledge within 72 hours and aim to ship a
fix or mitigation within 14 days for critical issues.

For sensitive cases that can't be reported via GitHub, contact:
**security@cosmicflow.space** (PGP key on request).

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| < 0.1 | ❌ (pre-release scaffolds) |

## Trust model recap

Mnemos is a single-user, single-machine application. The architecture
invariants in [`AGENTS.md`](AGENTS.md) define the trust boundary:

- API is bound to `127.0.0.1` by default; LAN binding requires explicit
  `MNEMOS_BIND=lan` opt-in and enforces bearer-token auth.
- Bundled plugins are part of the trusted base.
- Source folders are read-only and require explicit registration.
- The audit log records exactly which chunks were retrieved and what was sent
  to any external LLM on every request.

Vulnerabilities that escalate beyond this boundary — auth bypass, secret
leak, arbitrary file read/write, code execution from indexed content — are
treated as critical.

## Out of scope

- Social engineering of contributors or maintainers.
- Findings that require physical access to the host machine.
- Findings that require the user to disable documented security defaults
  (e.g. running Mnemos as root, exposing the port without auth, manually
  bypassing the security-tier file excludes).

## Coordinated disclosure

We'll work with you on a disclosure timeline and credit you in the
CHANGELOG and the advisory unless you prefer to remain anonymous.
