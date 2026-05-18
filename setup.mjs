#!/usr/bin/env node
// Mnemos installer.
//
// Reads INSTALL.md (the playbook) and runs each step on the current OS.
// Zero npm dependencies. Only prereq is Node 22+, which is also Mnemos's
// runtime requirement, so the user installs Node once and is done.
//
// Usage:
//   node setup.mjs              # interactive
//   node setup.mjs --yes        # accept every fix (CI-friendly)
//   node setup.mjs --reconfigure # redo provider wizard even if env exists
//   node setup.mjs --help

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'
const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = path.join(REPO_ROOT, 'INSTALL.md');
const STATE_DIR = path.join(os.homedir(), '.mnemos');
const ENV_FILE = path.join(STATE_DIR, '.env');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const NON_INTERACTIVE = hasFlag('--yes') || hasFlag('-y');
const RECONFIGURE = hasFlag('--reconfigure');

if (hasFlag('--help') || hasFlag('-h')) {
  process.stdout.write(`Mnemos installer

  node setup.mjs [--yes] [--reconfigure] [--help]

  --yes / -y       Accept every fix without prompting (CI / scripted).
  --reconfigure    Rerun the provider wizard even if ~/.mnemos/.env exists.
  --help / -h      This message.

The installer reads INSTALL.md, runs each "Step:" / "Configure:" / "Verify:"
section, and asks before changing anything. Edit INSTALL.md to change the
install logic — there are no per-OS shell scripts to keep in sync.
`);
  process.exit(0);
}

// ── tiny ANSI helpers ─────────────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);

// ── playbook parser ──────────────────────────────────────────────────────────
// Sections start with `## Step: <id>`, `## Configure: <id>`, or `## Verify: <id>`.
// Inside each section, fenced code blocks carry an info-string:
//   ```<lang> <check|fix> <all|darwin|linux|win32>
function parsePlaybook(md) {
  const lines = md.split('\n');
  const sections = [];
  let cur = null;
  let inFence = false;
  let meta = null;
  let buf = [];
  for (const line of lines) {
    if (!inFence) {
      const header = /^##\s+(Step|Configure|Verify):\s*(.+)\s*$/.exec(line);
      if (header) {
        if (cur) sections.push(cur);
        cur = { kind: header[1].toLowerCase(), id: header[2].trim(), blocks: [] };
        continue;
      }
      const open = /^```(\w+)\s+(check|fix)\s+(all|darwin|linux|win32)\s*$/.exec(line);
      if (open && cur) {
        inFence = true;
        meta = { lang: open[1], kind: open[2], platform: open[3] };
        buf = [];
        continue;
      }
    } else {
      if (/^```\s*$/.test(line)) {
        cur.blocks.push({ ...meta, code: buf.join('\n').trim() });
        inFence = false;
        meta = null;
        buf = [];
        continue;
      }
      buf.push(line);
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

function pickBlock(section, kind) {
  return (
    section.blocks.find((b) => b.kind === kind && b.platform === PLATFORM) ??
    section.blocks.find((b) => b.kind === kind && b.platform === 'all') ??
    null
  );
}

// ── runners ──────────────────────────────────────────────────────────────────
function runCheck(block) {
  const r = spawnSync(block.code, [], { shell: true, encoding: 'utf8' });
  return r.status === 0;
}

async function runFix(block, rl) {
  // Refuse to silently sudo — print and bail so the user stays in control.
  const needsSudo = block.code.split('\n').some((l) => /^\s*sudo\b/.test(l));
  if (needsSudo) {
    console.log(yellow('  This fix uses sudo. The installer will NOT run it for you.'));
    console.log(dim('  Copy/paste the command above into your shell, then re-run setup.'));
    return false;
  }
  if (!NON_INTERACTIVE) {
    const ans = (await rl.question(dim('  Run this fix? [Y/n] '))).trim().toLowerCase();
    if (ans === 'n' || ans === 'no') return false;
  }
  let r;
  if (block.lang === 'ps1' && PLATFORM === 'win32') {
    r = spawnSync('powershell', ['-NoProfile', '-Command', block.code], { stdio: 'inherit' });
  } else {
    r = spawnSync(block.code, [], { shell: true, stdio: 'inherit', cwd: REPO_ROOT });
  }
  return r.status === 0;
}

// ── interactive provider wizard ──────────────────────────────────────────────
async function configureProvider(rl) {
  if (!RECONFIGURE && fs.existsSync(ENV_FILE)) {
    console.log(green('  ✓ ~/.mnemos/.env already exists — leaving alone (pass --reconfigure to redo)'));
    return;
  }
  if (NON_INTERACTIVE) {
    console.log(yellow('  --yes given but no ~/.mnemos/.env — skipping wizard, you must create it manually.'));
    return;
  }
  console.log('');
  console.log('  Pick your chat provider:');
  // Aligned with packages/core/src/registry.ts — only providers actually
  // wired today. gemini and local plugins are stubs (17-line manifests);
  // offering them here would let users finish setup in a non-working state.
  // When those plugins land, add them back to this list.
  console.log(`    ${bold('1')}) anthropic   Claude (Sonnet 4.6, Opus 4.7)   needs ANTHROPIC_API_KEY`);
  console.log(`    ${bold('2')}) openai      GPT-4o / o-series                needs OPENAI_API_KEY`);
  console.log(`    ${bold('3')}) ollama      local daemon on :11434           no key`);
  console.log(dim(`    (gemini + bundled local llama.cpp are stubs in v0.1 — landing in v0.2)`));
  const choices = { 1: 'anthropic', 2: 'openai', 3: 'ollama' };
  let provider = '';
  while (!provider) {
    const raw = (await rl.question('  Choice [1-3]: ')).trim();
    provider = choices[raw] ?? '';
  }
  let apiKey = '';
  if (['anthropic', 'openai'].includes(provider)) {
    apiKey = (await rl.question(`  Paste your ${provider} API key (or leave blank, fill in later): `)).trim();
  }
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const lines = [
    '# Mnemos config — generated by setup.mjs',
    `# Generated: ${new Date().toISOString()}`,
    `MNEMOS_DEFAULT_PROVIDER=${provider}`,
  ];
  if (provider === 'anthropic' && apiKey) lines.push(`ANTHROPIC_API_KEY=${apiKey}`);
  if (provider === 'openai' && apiKey) lines.push(`OPENAI_API_KEY=${apiKey}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* non-POSIX */ }
  console.log(green(`  ✓ wrote ${ENV_FILE} (chmod 600)`));
}

async function offerDevServer(rl) {
  if (NON_INTERACTIVE) {
    console.log(dim('  --yes given; skipping dev server boot.'));
    return;
  }
  const ans = (await rl.question('  Start dev server now? [Y/n] ')).trim().toLowerCase();
  if (ans === 'n' || ans === 'no') {
    console.log(dim('  Run `pnpm dev` when ready, then open http://127.0.0.1:3030'));
    return;
  }
  console.log(dim('  starting `pnpm dev` (Ctrl-C to stop)...'));
  spawnSync('pnpm', ['dev'], { shell: true, stdio: 'inherit', cwd: REPO_ROOT });
}

// ── main ─────────────────────────────────────────────────────────────────────
function banner() {
  console.log('');
  console.log(bold(cyan('  Mnemos installer')));
  console.log(dim(`  platform=${PLATFORM}  node=${process.versions.node}  cwd=${REPO_ROOT}`));
  console.log('');
}

async function main() {
  banner();
  if (!fs.existsSync(PLAYBOOK)) {
    console.error(red(`INSTALL.md not found at ${PLAYBOOK} — run from repo root.`));
    process.exit(1);
  }
  const sections = parsePlaybook(fs.readFileSync(PLAYBOOK, 'utf8'));
  if (sections.length === 0) {
    console.error(red('No "## Step:" / "## Configure:" / "## Verify:" sections found in INSTALL.md.'));
    process.exit(1);
  }
  const rl = readline.createInterface({ input, output });
  try {
    for (const s of sections) {
      process.stdout.write(`${bold('▸')} ${s.kind}: ${cyan(s.id)}  `);
      if (s.kind === 'configure') {
        console.log('');
        await configureProvider(rl);
        continue;
      }
      const check = pickBlock(s, 'check');
      if (!check) {
        console.log(dim('(no check block; skipping)'));
        continue;
      }
      if (runCheck(check)) {
        console.log(green('✓'));
        continue;
      }
      console.log(yellow('✗  (needs fix)'));
      const fix = pickBlock(s, 'fix');
      if (!fix) {
        if (s.kind === 'verify' && s.id === 'dev-server') {
          await offerDevServer(rl);
          continue;
        }
        console.log(red(`  No fix block for ${PLATFORM} — edit INSTALL.md to add one.`));
        process.exit(1);
      }
      console.log(dim('  Suggested fix:'));
      for (const line of fix.code.split('\n')) console.log(dim('  │ ') + line);
      const ok = await runFix(fix, rl);
      if (!ok) {
        console.log(red('  fix did not complete — re-run setup after addressing it.'));
        process.exit(1);
      }
      if (!runCheck(check)) {
        console.log(red('  check still failing after fix — bailing.'));
        process.exit(1);
      }
      console.log(green('  ✓ fixed'));
    }
    console.log('');
    console.log(green(bold('  Mnemos is ready.')));
    console.log(dim('  Open http://127.0.0.1:3030 in your browser.'));
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(red(err.stack ?? String(err)));
  process.exit(1);
});
