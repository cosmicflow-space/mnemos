# Example `/do` verbs

A `/do` verb is a small, **you-authored, pre-tested** script plus a manifest, living in
`~/.mnemos/do/`. The whole action surface of `/do` is `ls ~/.mnemos/do/`. See
[`docs/agent/DO.md`](../../docs/agent/DO.md) for the architecture and
[`docs/agent/do-spec.md`](../../docs/agent/do-spec.md) for the authoring contract and the
adversarial test protocol a verb must pass before you trust it.

This folder ships the `fs` verb for each OS. The `fs.json` manifest is **shared**; only the
script differs, and the dispatcher picks the right one for your platform.

| File | OS |
|------|----|
| `fs` | macOS / Linux (`#!/bin/sh`, Spotlight `mdfind` fast-path + `find` fallback) |
| `fs.ps1` | Windows (PowerShell `Get-ChildItem`) |
| `fs.json` | the manifest, all platforms |

## Install the `fs` example

**macOS / Linux**

```sh
mkdir -p ~/.mnemos/do
cp examples/do/fs ~/.mnemos/do/fs && chmod +x ~/.mnemos/do/fs
cp examples/do/fs.json ~/.mnemos/do/fs.json
```

**Windows (PowerShell)**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.mnemos\do" | Out-Null
Copy-Item examples\do\fs.ps1  "$env:USERPROFILE\.mnemos\do\fs.ps1"
Copy-Item examples\do\fs.json "$env:USERPROFILE\.mnemos\do\fs.json"
```

Then, in the web app or your Telegram bot: `/do fs <name-or-glob>` to find files, and
`/do rag <n>` to add the ones you pick to the index (the write is PIN-gated).

## What `fs` is

`fs` is a `read`-tier producer: it searches file **names** under your home directory, prints
absolute paths of regular files, prunes sensitive/noisy trees, and caps its own output. It
never reads file contents — that grant happens only when you add a file with `rag`. **Read it
before you trust it**, and adapt it to your machine.

> Platform notes: macOS uses the Spotlight index (`mdfind`) so it's near-instant; Linux falls
> back to walking with `find`; Windows has no Spotlight index, so `fs.ps1` walks the tree
> (slower) and supports `*`/`?` globs (not `[…]` character classes).
