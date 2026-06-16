# Mnemos Install Playbook

> This file is the **source of truth** for installing Mnemos. It is readable by
> humans and parsed by `setup.mjs`. Edit the markdown and the installer updates
> itself — no per-OS shell scripts to keep in sync.

## One-command install

The only prerequisite is **Node 22+** (download from <https://nodejs.org/> if you
don't have it). Then, from the repo root:

```
node setup.mjs
```

That's it. The installer detects your OS, finds what's missing, asks before
running anything, configures your LLM provider, and starts the dev server.

---

## How `setup.mjs` reads this file

Each step below has a `check` block (a probe) and one or more `fix` blocks
tagged by platform (`darwin`, `linux`, `win32`, or `all`). The fence info-string
is the protocol:

    ```sh check all          ← runs everywhere; non-zero exit means "fix needed"
    ```sh fix darwin         ← suggested fix for macOS
    ```sh fix linux          ← suggested fix for Linux
    ```ps1 fix win32         ← suggested fix for Windows (PowerShell)

If a fix starts with `sudo`, the installer **prints it but never executes it**
— you copy/paste so you stay in control of root.

---

## Step: node-version

Mnemos needs Node 22 or newer.

```sh check all
node -e "process.exit(parseInt(process.versions.node, 10) >= 22 ? 0 : 1)"
```

```sh fix darwin
brew install node@22 && brew link --overwrite --force node@22
```

```sh fix linux
# Debian/Ubuntu (any modern distro): use NodeSource.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

```ps1 fix win32
winget install --id OpenJS.NodeJS.LTS -e
```

## Step: corepack

Corepack ships with Node 22 and gives us a portable pnpm without a global install.

```sh check all
corepack --version
```

```sh fix all
node -e "console.log('corepack is bundled with Node 22+; if this fails, reinstall Node from nodejs.org')" && exit 1
```

## Step: pnpm

Mnemos pins pnpm via corepack. The fix enables corepack and prepares pnpm 9.

```sh check all
pnpm --version
```

```sh fix all
corepack enable && corepack prepare pnpm@9 --activate
```

## Step: git

Needed for cloning, hooks, and version tracking.

```sh check all
git --version
```

```sh fix darwin
xcode-select --install
```

```sh fix linux
sudo apt-get update && sudo apt-get install -y git
```

```ps1 fix win32
winget install --id Git.Git -e
```

## Step: mnemos-state-dir

Mnemos stores its SQLite DB, audit log, and encrypted credentials in
`~/.mnemos/`. The installer creates the directory (chmod 700 on POSIX).

```sh check all
node -e "const fs=require('node:fs'); const os=require('node:os'); const p=require('node:path').join(os.homedir(),'.mnemos'); process.exit(fs.existsSync(p)?0:1)"
```

```sh fix all
node -e "const fs=require('node:fs'); const os=require('node:os'); const p=require('node:path').join(os.homedir(),'.mnemos'); fs.mkdirSync(p,{recursive:true,mode:0o700}); console.log('created '+p)"
```

## Configure: agent

This is the *one* interactive choice you make. The installer prompts you to
pick a chat provider and (if needed) writes the API key to `~/.mnemos/.env`:

- **anthropic** — Claude (requires `ANTHROPIC_API_KEY`)
- **openai** — GPT-5.5 / GPT-5.4 family (requires `OPENAI_API_KEY`)
- **gemini** — Google Gemini (requires `GEMINI_API_KEY`)
- **ollama** — fully local via Ollama (requires `ollama serve` running on
  `localhost:11434`; no key)
- **local** — bundled `node-llama-cpp` (no key, no network — first-run downloads
  a small model)

The default embedding provider is `embed-local` (bundled BGE-small ONNX), which
works offline with zero keys. You can change either in the UI later.

```sh check all
node -e "const fs=require('node:fs'); const os=require('node:os'); const p=require('node:path').join(os.homedir(),'.mnemos','.env'); process.exit(fs.existsSync(p)?0:1)"
```

> No `fix` block — the installer runs an interactive wizard for this step
> instead of executing a shell command. Re-running `setup.mjs` will skip this
> step if `~/.mnemos/.env` already exists; pass `--reconfigure` to redo it.

## Step: workspace-install

Installs every workspace package via pnpm. Native deps (`better-sqlite3`,
`sqlite-vec`, `node-llama-cpp`, `sharp`) are allow-listed in
`pnpm-workspace.yaml`, so their build scripts run automatically.

```sh check all
node -e "const fs=require('node:fs'); process.exit(fs.existsSync('node_modules/.pnpm')?0:1)"
```

```sh fix all
pnpm install
```

## Verify: dev-server

Final smoke test — boot the Next.js app and check the health endpoint.

```sh check all
node -e "fetch('http://127.0.0.1:3030/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

> No `fix` block — the installer ends by asking *"Start dev server now? [Y/n]"*.
> If you say yes, it runs `pnpm dev` and watches for the health endpoint to come
> up. If you say no, run `pnpm dev` whenever you're ready.

---

## Manual install (if you'd rather skip `setup.mjs`)

```
git clone https://github.com/cosmicflow-space/mnemos.git
cd mnemos
corepack enable && corepack prepare pnpm@9 --activate
pnpm install
mkdir -p ~/.mnemos
printf "ANTHROPIC_API_KEY=sk-ant-...\n" > ~/.mnemos/.env   # or OPENAI / GEMINI / nothing
pnpm dev
```

Then open <http://127.0.0.1:3030>.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `pnpm install` skips native build scripts | New native dep not in `allowBuilds` | Edit `pnpm-workspace.yaml`, add the package name with `true`, re-run install |
| Dev server starts but `/api/health` returns 401 | Bearer token mismatch | Check the value in `~/.mnemos/auth.key` matches the UI's stored token |
| `pnpm dev` fails with `Cannot find module '@mnemos/core'` | Workspace symlinks not built | Run `pnpm install` once from the repo root, not inside a workspace package |
| Windows: `pnpm` not found after `corepack prepare` | Shell didn't pick up new PATH | Open a new terminal window |
