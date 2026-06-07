# Example `/do` verbs

A `/do` verb is a small, **you-authored, pre-tested** script plus a manifest, living in
`~/.mnemos/do/`. The whole action surface of `/do` is `ls ~/.mnemos/do/`. See
[`docs/agent/DO.md`](../../docs/agent/DO.md) for the architecture and
[`docs/agent/do-spec.md`](../../docs/agent/do-spec.md) for the authoring contract and the
adversarial test protocol a verb must pass before you trust it.

## Install the `fs` example

```sh
mkdir -p ~/.mnemos/do
cp examples/do/fs ~/.mnemos/do/fs && chmod +x ~/.mnemos/do/fs
cp examples/do/fs.json ~/.mnemos/do/fs.json
```

Then, in the web app or your Telegram bot: `/do fs <name-or-glob>` to find files, and
`/do rag <n>` to add the ones you pick to the index (the write is PIN-gated).

## What `fs` is

`fs` is a `read`-tier producer: it searches file **names** under `$HOME` (Spotlight fast-path
with a `find` fallback), prints absolute paths of regular files, prunes sensitive/noisy trees,
and caps its own output. It never reads file contents — that grant happens only when you add a
file with `rag`. **Read it before you trust it**, and adapt it to your machine.
