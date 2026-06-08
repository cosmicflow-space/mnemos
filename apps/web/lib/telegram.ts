/**
 * Telegram remote channel — ask your personal RAG from your phone.
 *
 * Long-poll, NOT a webhook: this process reaches OUT to api.telegram.org and
 * holds a getUpdates connection. So it works behind NAT with no public IP, no
 * tunnel, and nothing inbound is ever exposed — the same outbound-only posture
 * as the chat providers and the auto-rescan watcher.
 *
 * Security model (default-deny):
 *   - Only chats in the telegram_chat allowlist may query. A stranger who finds
 *     the bot handle never reaches runQuery.
 *   - Pairing is the ONLY action an unpaired chat can take: `/pair <code>` with
 *     a single-use, time-boxed code shown in the Mnemos UI.
 *   - Query-only. No source/admin/mutating commands over the bot.
 *
 * Privacy: documents never leave the machine, but the question and answer
 * transit Telegram (and the configured LLM). The pairing reply states this once.
 *
 * Started once from instrumentation.ts. The token + enabled flag are read fresh
 * each iteration from process.env / the DB, so toggling them in the UI takes
 * effect live without a restart. Hard-disable with MNEMOS_DISABLE_TELEGRAM=1.
 */

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runQuery, getChatProvider } from "@mnemos/core";
import {
  createSession,
  getSession,
  setSessionTitle,
  getTelegramState,
  setTelegramOffset,
  consumeTelegramPairingCode,
  addTelegramChat,
  isTelegramChatPaired,
  getTelegramChatSession,
  setTelegramChatSession,
  listTelegramChats,
  appendAudit,
  findIndexedFilesByName,
} from "@mnemos/db";
import { getDb, getRegistry, getDefaultEmbedder } from "./runtime";
import {
  getDefaultProviderId,
  getDefaultModel,
  credentialsForProvider,
} from "./config";
import { parseQueryRoute, isFrontierTier, type RouteTier } from "./query-routing";
import { listVerbs, runVerb } from "./do-runner";
import {
  sessionKey,
  setBuffer,
  setPending,
  getPending,
  clearPending,
  setRagStatus,
  getRagStatus,
  setFocus,
  getFocus,
  setCited,
  getCited,
  clearCited,
  type FocusFile,
} from "./do-state";
import { resolveRag, ragGate } from "./do-commands";
import { isMetadataOnly, metadataOnlyText, META_ONLY_CHARS, titleFromQuery } from "./focus-util";
import { pinExists, setPin, verify as verifyPin, getCadence } from "./do-pin";
import { addPathsToRag, reindexFile, type RagOutcome } from "./do-rag";
import { resolveFrontierModel } from "./model-routing";
import { formatTipsText } from "./input-tips";
import { computeCostReport, formatCostText } from "./cost-stats";

const TG_API = "https://api.telegram.org";
const TG_MSG_LIMIT = 4096;
const LONG_POLL_SEC = 30;
const IDLE_MS = 5_000;

const HELP =
  "Send a question and I'll answer from your indexed documents, with sources.\n\n" +
  formatTipsText() +
  "\n\nCommands:\n/new — start a fresh conversation\n/tips — show the input shortcuts\n/help — this message";

const PRIVACY_NOTE =
  "ℹ️ Privacy: your documents stay on your computer. Your questions and my " +
  "answers pass through Telegram (and whichever model you've configured). Your " +
  "computer must be awake with Mnemos running for me to reply.";

let started = false;

/** Start the poll loop once. No-op if already started or hard-disabled. */
export function startTelegram(): void {
  if (started) return;
  if (process.env.MNEMOS_DISABLE_TELEGRAM === "1") return;
  started = true;
  void loop();
  // eslint-disable-next-line no-console
  console.log("[mnemos/telegram] poller started");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

async function loop(): Promise<void> {
  // Runs for the life of the process. Idles cheaply until a token is present
  // and the channel is enabled, so it's safe to start unconditionally.
  let announcedThisBoot = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const token = (process.env.MNEMOS_TELEGRAM_BOT_TOKEN ?? "").trim();
    let enabled = false;
    let offset = 0;
    try {
      const state = getTelegramState(getDb());
      enabled = state.enabled;
      offset = state.updateOffset;
    } catch {
      // DB not ready — idle and retry.
    }
    if (!token || !enabled) {
      await sleep(IDLE_MS);
      continue;
    }

    // First time the channel is live this boot: deliver any pending deploy
    // announcement (a reliable "deployment is done" ping to the operator's phone).
    if (!announcedThisBoot) {
      announcedThisBoot = true;
      await sendBootAnnounce(token).catch(() => {});
    }

    let updates: TgUpdate[];
    try {
      updates = await tgGetUpdates(token, offset, LONG_POLL_SEC);
    } catch (err) {
      // Bad token, transient network, webhook conflict, etc. Back off so a
      // persistent error (e.g. 401) doesn't hot-loop. Never log the token/URL.
      // eslint-disable-next-line no-console
      console.warn(
        `[mnemos/telegram] getUpdates failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(IDLE_MS);
      continue;
    }

    if (updates.length === 0) continue;

    for (const u of updates) {
      try {
        await handleUpdate(token, u);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mnemos/telegram] update ${u.update_id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Advance the offset past everything we just received so a restart doesn't
    // reprocess. Persist even if a handler threw — the message was delivered.
    const maxId = updates.reduce((m, u) => Math.max(m, u.update_id), offset);
    try {
      setTelegramOffset(getDb(), maxId + 1);
    } catch {
      /* best effort */
    }
  }
}

/** Normalize a user-typed pairing code: uppercase, strip anything non-alphanumeric
 * (so "4f7k-9q2m" and "4F7K 9Q2M" both match the stored "4F7K9Q2M"). */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function handleUpdate(token: string, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg || typeof msg.text !== "string") return;
  const chatId = msg.chat.id;

  // Private 1:1 chats ONLY. A pairing code must never authorize a group,
  // supergroup, or channel — that would let every member of that chat query the
  // corpus, breaking the one-operator trust model. Refuse before pairing OR
  // answering. (Telegram chat.type is 'private' | 'group' | 'supergroup' | 'channel'.)
  if (msg.chat.type !== "private") {
    await tgSend(token, chatId, "🔒 Mnemos only works in a direct message — message me 1:1.").catch(
      () => {},
    );
    return;
  }

  const text = msg.text.trim();
  const db = getDb();
  const name = msg.from?.username
    ? `@${msg.from.username}`
    : (msg.from?.first_name ?? null);

  // Debug: log the command head (never the code/question content) + chat type
  // so pairing issues are diagnosable from the server log.
  // eslint-disable-next-line no-console
  console.log(
    `[mnemos/telegram] in: chat=${msg.chat.type} cmd=${text.startsWith("/") ? text.split(/\s/)[0] : "(text)"}`,
  );

  // /pair <code> — the only action an UNPAIRED chat may take.
  if (text === "/pair" || text.startsWith("/pair ") || text.startsWith("/pair@")) {
    const code = normalizeCode(text.replace(/^\/pair(@\S+)?/i, ""));
    const ok = Boolean(code) && consumeTelegramPairingCode(db, code);
    // eslint-disable-next-line no-console
    console.log(`[mnemos/telegram] /pair consumed=${ok}`);
    if (ok) {
      addTelegramChat(db, chatId, name);
      await tgSend(token, chatId, `✅ Paired. You can now ask questions.\n\n${PRIVACY_NOTE}`);
    } else {
      await tgSend(
        token,
        chatId,
        "❌ Invalid or expired pairing code. Generate a fresh one in Mnemos → Settings → Telegram.",
      );
    }
    return;
  }

  // Default-deny everything else for non-allowlisted chats. We send one hint
  // (so the operator knows how to pair) but never touch the corpus.
  if (!isTelegramChatPaired(db, chatId)) {
    await tgSend(
      token,
      chatId,
      "🔒 This Mnemos bot is private. If you're its operator, send /pair <code> with a code from Mnemos → Settings → Telegram.",
    );
    return;
  }

  if (text === "/start" || text === "/help" || text.startsWith("/help@") || text.startsWith("/start@")) {
    await tgSend(token, chatId, HELP);
    return;
  }
  if (text === "/new" || text.startsWith("/new@")) {
    // Unbind so the next question opens a fresh session. The prior thread (with
    // its focus, if any) stays in history — reopen it here or in the web app.
    setTelegramChatSession(db, chatId, null);
    await tgSend(token, chatId, "🧹 Started a new conversation.");
    return;
  }
  if (/^\/focus(@\S+)?(\s|$)/i.test(text)) {
    await handleFocus(token, chatId, text.replace(/^\/focus(@\S+)?\s*/i, "").trim());
    return;
  }
  if (text === "/done" || text.startsWith("/done@")) {
    const cur = currentKey(chatId);
    const was = cur ? getFocus(cur) !== null : false;
    // Leaving focus starts a clean global thread; the focused thread is left in
    // history with its focus intact (resumable). No need to clear it in place.
    if (was) freshSession(chatId);
    await tgSend(
      token,
      chatId,
      was ? "🌐 Focus off. Back to searching all your files." : "You're not focused on a file. /focus <name> to scope to one.",
    );
    return;
  }
  if (text === "/reindex" || text.startsWith("/reindex@")) {
    await handleReindex(token, chatId);
    return;
  }
  if (text === "/tips" || text.startsWith("/tips@")) {
    await tgSend(token, chatId, formatTipsText());
    return;
  }
  if (text === "/cost" || text.startsWith("/cost@")) {
    const report = await computeCostReport(db, getRegistry());
    await tgSend(token, chatId, formatCostText(report));
    return;
  }
  if (/^\/do(@\S+)?(\s|$)/i.test(text)) {
    await handleDo(token, chatId, text.replace(/^\/do(@\S+)?\s*/i, "").trim());
    return;
  }
  if (text.startsWith("/")) {
    await tgSend(token, chatId, "Unknown command. Just send a question, or /new to reset.");
    return;
  }

  // A 6-digit message answers a pending PIN gate (a parked write), if any.
  if (/^\d{6}$/.test(text) && (await tryPinReply(token, chatId, text))) {
    return;
  }

  await answerQuestion(token, chatId, text);
}

/**
 * `/do` — run a read-only Mnemos alias (a vetted script in ~/.mnemos/do/).
 * Bare `/do` lists available aliases; `/do <verb> <glob>` runs one. Read-only:
 * verbs that mutate the index are refused here (see lib/do-runner.ts).
 */
const DO_TELEGRAM_LIMIT = 25; // keep the message well under Telegram's 4096-char cap

/**
 * Conversation state (focus, selection buffer, cited list, pending PIN) is keyed
 * by the chat's SHARED Mnemos session id — not by `tg:<chatId>` — so it travels
 * with the conversation to the web app and back (see do-state.sessionKey).
 */

/** The chat's current session id, or null if it hasn't started one yet. */
function currentSession(chatId: number): string | null {
  return getTelegramChatSession(getDb(), chatId);
}

/** The state key for the chat's current session, or null if none exists yet. */
function currentKey(chatId: number): string | null {
  const s = currentSession(chatId);
  return s ? sessionKey(s) : null;
}

/** The chat's session id, creating + binding one if absent (titled lazily from
 * the first question, exactly like a web session). */
function ensureSession(chatId: number): string {
  const existing = getTelegramChatSession(getDb(), chatId);
  if (existing) return existing;
  return freshSession(chatId);
}

/** The state key for the chat's session, creating the session if needed. */
function stateKey(chatId: number): string {
  return sessionKey(ensureSession(chatId));
}

/**
 * Start a brand-new clean thread bound to this chat. Called on every focus
 * transition (enter / switch / exit) so a focused chat is its OWN thread —
 * otherwise the previous document's discussion leaks via session memory into the
 * new scope. The prior session stays in history with its focus intact, so it can
 * be reopened (here or in the web app) and resumed.
 */
function freshSession(chatId: number): string {
  const id = randomUUID();
  createSession(getDb(), id); // null title — set from the first question
  setTelegramChatSession(getDb(), chatId, id);
  return id;
}

const ANNOUNCE_PATH = path.join(os.homedir(), ".mnemos", ".announce");

/**
 * Keep Telegram's "typing…" indicator alive — it auto-expires after ~5s, so on a
 * RAG/focus answer that takes seconds-to-minutes it would vanish and look stuck.
 * Refresh it every 4.5s until the returned stop() is called.
 */
function startTypingKeepalive(token: string, chatId: number): () => void {
  void tgAction(token, chatId, "typing").catch(() => {});
  const timer = setInterval(() => {
    void tgAction(token, chatId, "typing").catch(() => {});
  }, 4500);
  return () => clearInterval(timer);
}

/**
 * One-shot deploy announcement: if the operator wrote `~/.mnemos/.announce`
 * before a restart, deliver it to every paired chat once the poller is live,
 * then delete it. Because it fires only when the channel is actually up, it's a
 * reliable "deployment is done" ping — no need to check the computer.
 */
async function sendBootAnnounce(token: string): Promise<void> {
  let message: string;
  try {
    message = (await readFile(ANNOUNCE_PATH, "utf8")).trim();
  } catch {
    return; // nothing pending
  }
  try {
    if (message) {
      for (const chat of listTelegramChats(getDb())) {
        await tgSend(token, chat.chatId, message).catch(() => {});
      }
    }
  } finally {
    await rm(ANNOUNCE_PATH, { force: true }).catch(() => {});
  }
}

/**
 * Audit every `/do` action — the operator's source of truth for what the system
 * actually did (e.g. which files a write added), which is part of why exposing
 * `/do` over Telegram is justifiable. Best-effort: never block the user action.
 * NEVER logs PIN digits.
 */
function auditDo(chatId: number, event: string, data: Record<string, unknown>): void {
  try {
    appendAudit(getDb(), event, { channel: "telegram", chatId, ...data });
  } catch {
    /* audit must not break the action */
  }
}

/** Short label for the active focus: a single file's name, or "N files". */
function focusLabel(files: FocusFile[]): string {
  return files.length === 1 && files[0] ? files[0].name : `${files.length} files`;
}

/**
 * `/focus <name>` — scope the conversation to an ALREADY-INDEXED file by name
 * (e.g. one the user just saw cited). Distinct from `/do rag`, which adds a new
 * file and auto-focuses. Bare `/focus` shows the current focus.
 */
async function handleFocus(token: string, chatId: number, arg: string): Promise<void> {
  if (!arg) {
    const key = currentKey(chatId);
    const cur = key ? getFocus(key) : null;
    await tgSend(
      token,
      chatId,
      cur
        ? `🎯 Focused on ${focusLabel(cur)}. /done to exit.`
        : "Not focused. /focus <name> to scope to an indexed file, or /do fs <name> to find a new one.",
    );
    return;
  }

  // Numeric → pick from the LAST answer's cited sources (the `/focus <n>` hint).
  if (/^\d+$/.test(arg)) {
    // Read the cited list from the CURRENT session before transitioning away.
    const cur = currentKey(chatId);
    const cited = cur ? getCited(cur) : null;
    const n = Number(arg);
    const pick = cited && n >= 1 && n <= cited.length ? cited[n - 1] : undefined;
    if (pick) {
      // Focus is a transition → fresh thread scoped to the picked file (no leak).
      setFocus(sessionKey(freshSession(chatId)), [pick]);
      auditDo(chatId, "do_focus", { fileId: pick.fileId, name: pick.name, via: "focus-n" });
      await tgSend(token, chatId, `🎯 Now focused on ${pick.name} — questions are scoped to this file. /done to exit.`);
      if (isMetadataOnly(pick.fileId)) await tgSend(token, chatId, metadataOnlyText(pick.fileId, pick.name));
    } else {
      await tgSend(token, chatId, "Ask a question first, then reply /focus <n> to scope to one of its listed sources.");
    }
    return;
  }

  const matches = findIndexedFilesByName(getDb(), arg, 25);
  if (matches.length === 0) {
    await tgSend(token, chatId, `No indexed file matches "${arg}". Find and add it: /do fs ${arg}`);
    return;
  }
  if (matches.length > 1) {
    // Full paths, not basenames — so duplicate basenames are distinguishable and
    // the user can retype with a folder segment (the matcher matches on path too).
    const names = matches.slice(0, 8).map((m) => `• ${m.path}`).join("\n");
    const more = matches.length > 8 ? `\n…and ${matches.length - 8} more` : "";
    await tgSend(
      token,
      chatId,
      `Several indexed files match "${arg}":\n${names}${more}\n\nBe more specific (e.g. include a parent folder).`,
    );
    return;
  }

  const [first] = matches;
  if (!first) return;
  const f: FocusFile = { fileId: first.fileId, name: first.name };
  // Focus is a transition → fresh thread scoped to the new file (no leak).
  setFocus(sessionKey(freshSession(chatId)), [f]);
  auditDo(chatId, "do_focus", { fileId: f.fileId, name: f.name, via: "focus" });
  await tgSend(token, chatId, `🎯 Now focused on ${f.name} — questions are scoped to this file. /done to exit.`);
  if (isMetadataOnly(f.fileId)) await tgSend(token, chatId, metadataOnlyText(f.fileId, f.name));
}

/** `/reindex` — force re-extraction of the focused file (retry a metadata-only file). */
async function handleReindex(token: string, chatId: number): Promise<void> {
  const cur = currentKey(chatId);
  const target = cur ? getFocus(cur)?.[0] : undefined;
  if (!target) {
    await tgSend(token, chatId, "Focus on a file first (/focus <name>), then /reindex to re-extract it.");
    return;
  }
  await tgSend(token, chatId, `⏳ Re-extracting "${target.name}"… (scanned PDFs run OCR — may take a moment)`);
  const res = await reindexFile(target.fileId);
  auditDo(chatId, "do_reindex", { fileId: target.fileId, ok: res.ok, contentChars: res.contentChars });

  if (!res.ok) {
    await tgSend(token, chatId, `⚠️ Couldn't re-extract "${target.name}": ${res.reason ?? "it failed"}.`);
    return;
  }
  if (res.contentChars >= META_ONLY_CHARS) {
    // Now readable — fresh thread, still scoped to this file.
    setFocus(sessionKey(freshSession(chatId)), [target]);
    await tgSend(token, chatId, `✅ Extracted text from "${target.name}" — it's readable now. Ask away.`);
    return;
  }
  const why = /\.pdf$/i.test(target.name)
    ? "Even OCR couldn't read it — likely a blank or very low-quality scan."
    : "This file type has no extractable text.";
  await tgSend(token, chatId, `📄 Still no readable text in "${target.name}". ${why}`);
}

async function handleDo(token: string, chatId: number, rest: string): Promise<void> {
  if (!rest) {
    const verbs = await listVerbs();
    const lines = verbs.map((v) => `• ${v.name} — ${v.summary}`);
    lines.push("• rag — add files you found to the index (PIN-gated)");
    await tgSend(
      token,
      chatId,
      `Mnemos aliases:\n${lines.join("\n")}\n\nUse: /do fs <name>, then /do rag <n>.`,
    );
    return;
  }

  const sp = rest.indexOf(" ");
  const verb = (sp === -1 ? rest : rest.slice(0, sp)).trim().toLowerCase();
  const arg = sp === -1 ? "" : rest.slice(sp + 1).trim();

  if (verb === "rag") return handleRag(token, chatId, arg);
  if (verb === "pin") return handlePin(token, chatId, arg);
  if (verb === "status") return handleRagStatus(token, chatId);

  // A read-tier script verb (e.g. fs). A producer's output becomes the buffer.
  const res = await runVerb(verb, arg);
  if (!res.ok) {
    await tgSend(token, chatId, `⚠️ ${res.error}`);
    return;
  }
  if (res.lines.length === 0) {
    await tgSend(token, chatId, `No files match "${arg}".`);
    return;
  }
  setBuffer(stateKey(chatId), verb, res.lines);
  auditDo(chatId, "do_verb", { verb, arg, resultCount: res.lines.length, truncated: res.truncated });

  const shown = res.lines.slice(0, DO_TELEGRAM_LIMIT);
  const numbered = shown.map((p, i) => `[${i + 1}] ${p}`).join("\n");
  const overflow =
    res.truncated || res.lines.length > shown.length
      ? `\n…more matches — narrow the pattern (e.g. add an extension).`
      : "";
  await tgSend(
    token,
    chatId,
    `${res.lines.length} match(es) for "${arg}":\n${numbered}${overflow}\n\nAdd to the index: /do rag <n> · 1-3 · all`,
  );
}

/** `/do rag <sel>` — add buffer-selected files to the index, behind the PIN. */
async function handleRag(token: string, chatId: number, arg: string): Promise<void> {
  if (arg.trim().toLowerCase() === "status") return handleRagStatus(token, chatId);

  const key = stateKey(chatId);
  const sel = resolveRag(key, arg);
  if (sel.kind === "empty") {
    await tgSend(token, chatId, "Nothing to add yet — run /do fs <name> first, then /do rag <n>.");
    return;
  }
  if (sel.kind === "error") {
    await tgSend(token, chatId, `⚠️ ${sel.message}`);
    return;
  }
  if (sel.kind === "none") {
    await tgSend(token, chatId, "No files selected.");
    return;
  }
  const { paths } = sel;

  // Single source of truth for the write-gate (PIN / anomaly / lockout).
  const gate = ragGate(paths);
  const anomaly = gate.kind === "pin" || gate.kind === "ready" ? gate.anomaly : false;
  auditDo(chatId, "do_rag_attempt", { count: paths.length, anomaly, prompted: gate.kind === "pin" });

  if (gate.kind === "setup") {
    await tgSend(
      token,
      chatId,
      "🔒 Set a PIN once to enable adding files: reply  /do pin <6 digits>  (it guards every add).",
    );
    return;
  }
  if (gate.kind === "locked") {
    await tgSend(token, chatId, `🔒 Too many wrong PINs. Try again in ${Math.ceil(gate.ms / 60000)} min.`);
    return;
  }
  if (gate.kind === "ready") {
    await startRag(token, chatId, paths);
    return;
  }
  setPending(key, { verb: "rag", paths });
  const why = gate.anomaly ? ` (${paths.length} files at once)` : "";
  await tgSend(
    token,
    chatId,
    `🔒 Reply with your 6-digit PIN to add ${paths.length} file(s)${why}. ` +
      `(Your reply is visible in chat history — you can delete it after.)`,
  );
}

/** A 6-digit reply to a parked write. Returns true if it consumed the message. */
async function tryPinReply(token: string, chatId: number, digits: string): Promise<boolean> {
  const key = currentKey(chatId);
  const pending = key ? getPending(key) : null;
  if (!key || !pending) return false;
  const res = verifyPin(digits);
  auditDo(chatId, "do_pin", {
    ok: res.ok,
    locked: !res.ok && res.lockedMs != null,
    attemptsLeft: !res.ok ? (res.attemptsLeft ?? null) : null,
  });
  if (!res.ok) {
    clearPending(key);
    const msg =
      res.lockedMs != null
        ? `❌ Wrong PIN — locked for ${Math.ceil(res.lockedMs / 60000)} min.`
        : `❌ Wrong PIN${res.attemptsLeft != null ? ` (${res.attemptsLeft} left)` : ""}. Re-run /do rag to try again.`;
    await tgSend(token, chatId, msg);
    return true;
  }
  clearPending(key);
  await startRag(token, chatId, pending.paths);
  return true;
}

/**
 * Kick the ingest in the BACKGROUND and reply immediately. Awaiting the ingest
 * here would block the single-threaded poller (and the user) until a large file
 * finished chunking — so we acknowledge now, record status, and send a "ready"
 * follow-up when it completes. `/do rag status` reports progress meanwhile.
 */
async function startRag(token: string, chatId: number, paths: string[]): Promise<void> {
  const key = stateKey(chatId);
  const names = paths.map((p) => p.split("/").pop() ?? p);
  setRagStatus(key, "chunking", { files: names });
  await tgSend(
    token,
    chatId,
    `⏳ Adding ${paths.length} file(s) — chunking now. I'll say when they're ready (or check /do rag status).`,
  );

  // Fire-and-forget: the poller moves on; this resolves on the event loop.
  void addPathsToRag(paths)
    .then(async (outcome) => {
      setRagStatus(key, "done", {
        added: outcome.added.length,
        updated: outcome.updated.length,
        unchanged: outcome.unchanged.length,
        failed: outcome.failed.length,
        chunks: outcome.chunks,
        files: names,
      });
      auditDo(chatId, "do_rag_done", {
        added: outcome.added.length,
        updated: outcome.updated.length,
        unchanged: outcome.unchanged.length,
        failed: outcome.failed.length,
        chunks: outcome.chunks,
      });
      // Auto-focus on the file(s) just added — selecting a file via /do is intent.
      // A freshly-added file starts its own clean thread (focus on the new session).
      let focusNote = "";
      if (outcome.focus.length > 0) {
        setFocus(sessionKey(freshSession(chatId)), outcome.focus);
        auditDo(chatId, "do_focus", { count: outcome.focus.length, via: "rag" });
        focusNote = `\n\n🎯 Now focused on ${focusLabel(outcome.focus)} — questions are scoped to it. /done to exit.`;
      }
      await tgSend(token, chatId, `✅ Ready — ${formatRag(outcome)}${focusNote}`);
    })
    .catch(async (err) => {
      setRagStatus(key, "error", { message: err instanceof Error ? err.message : String(err) });
      await tgSend(token, chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
}

/** `/do rag status` — what's chunking now, and what was added recently. */
async function handleRagStatus(token: string, chatId: number): Promise<void> {
  const cur = currentKey(chatId);
  const status = cur ? getRagStatus(cur) : null;
  if (!status) {
    await tgSend(token, chatId, "Nothing added yet. Use /do fs <name>, then /do rag <n>.");
    return;
  }
  const ago = Math.max(0, Math.round((Date.now() - status.updatedAt) / 1000));
  const files = Array.isArray(status.detail.files) ? (status.detail.files as string[]) : [];
  const list = files.length ? `\n${files.map((f) => `• ${f}`).join("\n")}` : "";

  if (status.state === "chunking") {
    await tgSend(token, chatId, `⏳ Chunking now (started ${ago}s ago):${list}`);
  } else if (status.state === "error") {
    await tgSend(token, chatId, `⚠️ Last add failed: ${String(status.detail.message ?? "unknown")}`);
  } else {
    const chunks = typeof status.detail.chunks === "number" ? status.detail.chunks : 0;
    await tgSend(
      token,
      chatId,
      `✅ Ready (${ago}s ago) — ${chunks} chunk(s) embedded, searchable now.${list}`,
    );
  }
}

function formatRag(o: RagOutcome): string {
  const parts: string[] = [];
  if (o.added.length) parts.push(`✅ added ${o.added.length}`);
  if (o.updated.length) parts.push(`♻️ re-indexed ${o.updated.length}`);
  if (o.unchanged.length) parts.push(`↩️ already up to date ${o.unchanged.length}`);
  if (o.failed.length) parts.push(`⚠️ failed ${o.failed.length}`);
  const head = parts.length ? parts.join(" · ") : "nothing to do";
  const chunks = o.chunks > 0 ? `\n${o.chunks} chunk(s) embedded — now searchable.` : "";
  const fails = o.failed.length
    ? `\n${o.failed.map((f) => `• ${f.path.split("/").pop()}: ${f.reason}`).join("\n")}`
    : "";
  return `${head}.${chunks}${fails}`;
}

/** `/do pin <6 digits>` — set the write PIN the first time (one-time bootstrap). */
async function handlePin(token: string, chatId: number, arg: string): Promise<void> {
  const digits = arg.trim();
  if (!/^\d{6}$/.test(digits)) {
    await tgSend(token, chatId, "Usage: /do pin <6 digits> — e.g. /do pin 246810");
    return;
  }
  if (pinExists()) {
    await tgSend(token, chatId, "A PIN is already set. Change it in the Mnemos web app.");
    return;
  }
  setPin(digits);
  auditDo(chatId, "do_pin_set", { via: "telegram" });
  await tgSend(
    token,
    chatId,
    `✅ PIN set (re-asked ${getCadence()}, or on an unusual add). It guards adding files to the index.\n\n` +
      `⚠️ Security: this PIN is now a reusable write secret sitting in your Telegram history — ` +
      `delete that message now. For the most private setup, set or change your PIN in the Mnemos web app instead.`,
  );
}

async function answerQuestion(token: string, chatId: number, question: string): Promise<void> {
  const db = getDb();
  // Routing prefix (!, !!, !!!, +, ++) — same parser as the web UI. `!` = skip
  // files (direct); `+` = use files + frontier; repeats escalate the model tier.
  // All inert in Telegram, so the syntax is identical to the web app.
  const route = parseQueryRoute(question);
  const { direct, tier, q } = route;
  if (!q) {
    await tgSend(token, chatId, "Add a question after the prefix, e.g. !which model am I using?");
    return;
  }
  await tgAction(token, chatId, "typing").catch(() => {});

  // The chat's shared session (conversation memory + the cross-surface state
  // key). Titled lazily from the first question — exactly like a web session —
  // so the sidebar shows real text, not a generic "Telegram" label.
  const sessionId = ensureSession(chatId);
  const sess = getSession(db, sessionId);
  if (sess && !sess.title) setSessionTitle(db, sessionId, titleFromQuery(q));
  const key = sessionKey(sessionId);

  const registry = getRegistry();

  // Resolve tier → provider/model. Local tier uses the operator's configured
  // provider (default local Ollama); frontier tiers route to the cheapest /
  // flagship configured frontier model. No key → ask the user to add one.
  let providerId = getDefaultProviderId();
  let model = getDefaultModel();
  if (isFrontierTier(tier)) {
    const { resolved, suggestProviderId } = await resolveFrontierModel(registry, tier);
    if (!resolved) {
      const providerName =
        (suggestProviderId && registry.chatProviders.get(suggestProviderId)?.displayName) ||
        "a frontier provider";
      await tgSend(
        token,
        chatId,
        `⚠️ The "${route.sigil}" prefix needs a frontier model. Configure ${providerName} (API key) in Mnemos → Settings → AI Model, or drop the prefix to stay local.`,
      );
      return;
    }
    providerId = resolved.providerId;
    model = resolved.model;
  }

  let provider;
  try {
    provider = getChatProvider(registry, providerId);
  } catch {
    await tgSend(token, chatId, "⚠️ No chat model is configured in Mnemos yet.");
    return;
  }
  const creds = credentialsForProvider(providerId);
  const missing = provider.credentialSchema.fields.filter((f) => f.required && !creds[f.key]);
  if (missing.length > 0) {
    await tgSend(
      token,
      chatId,
      `⚠️ ${provider.displayName} needs a credential configured in Mnemos before I can answer.`,
    );
    return;
  }
  try {
    await provider.initialize(creds);
  } catch {
    await tgSend(token, chatId, "⚠️ Couldn't initialize the chat model.");
    return;
  }

  // File Focus Mode: scope retrieval to the active file(s) — unless this is a
  // direct (`!`) message, which intentionally bypasses files entirely. Focus is
  // scope; the `!`/`+` prefix is tier. The two are orthogonal.
  const focus = direct ? null : getFocus(key);

  // If the focused file(s) have no readable text, don't let the model improvise —
  // say so plainly (with the file's location) and offer /reindex. Done BEFORE the
  // embedder init so an embedder hiccup can't mask the honest metadata-only reply.
  if (focus && focus.every((f) => isMetadataOnly(f.fileId))) {
    const f0 = focus[0];
    if (f0) {
      await tgSend(token, chatId, metadataOnlyText(f0.fileId, f0.name));
      return;
    }
  }

  // Direct mode skips retrieval, so it must not require the embedder — a `!`
  // question should answer even if the local embedder isn't ready.
  let embedder: Awaited<ReturnType<typeof getDefaultEmbedder>> | null = null;
  if (!direct) {
    try {
      embedder = await getDefaultEmbedder();
    } catch {
      await tgSend(token, chatId, "⚠️ The local embedder isn't ready yet — try again shortly.");
      return;
    }
  }

  // Hold the "typing…" indicator for the whole generation — answers can take
  // seconds to minutes, and the indicator would otherwise expire and look stuck.
  const stopTyping = startTypingKeepalive(token, chatId);
  let answer = "";
  // Cited files in display order, de-duplicated by file — so a normal answer can
  // offer `/focus <n>` to scope to one of its own sources.
  const citedFiles: FocusFile[] = [];
  const seenFiles = new Set<number>();
  try {
    for await (const ev of runQuery(db, embedder, provider, {
      query: q,
      sessionId,
      model,
      direct,
      scopeFileIds: focus?.map((f) => f.fileId),
    })) {
      if (ev.phase === "delta") answer += ev.delta;
      else if (ev.phase === "retrieved") {
        for (const h of ev.hits) {
          if (seenFiles.has(h.fileId)) continue;
          seenFiles.add(h.fileId);
          citedFiles.push({ fileId: h.fileId, name: h.filePath.split("/").pop() ?? h.filePath });
        }
      } else if (ev.phase === "error") {
        await tgSend(token, chatId, `⚠️ ${ev.message}`);
        return;
      }
    }
  } catch (err) {
    await tgSend(token, chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
    return;
  } finally {
    stopTyping();
  }

  // Offer `/focus <n>` on the cited docs — but only on a normal multi-file answer
  // (not when already focused, and not for a direct `!` query). Remember the same
  // list we display, so the numbers line up with `/focus <n>`.
  const offerFocus = !focus && !direct && citedFiles.length > 0;
  const shown = citedFiles.slice(0, 8);
  if (offerFocus) setCited(key, shown);
  else clearCited(key); // an answer with no fresh numbered list invalidates /focus <n>

  // The footer keeps the active scope (and the way out) in view on every focused answer.
  const footer = focus ? `\n\n🎯 Focused on ${focusLabel(focus)} · /done to exit` : "";
  await tgSend(
    token,
    chatId,
    formatAnswer(answer, shown.map((f) => f.name), { direct, tier, model, offerFocus }) + footer,
  );
}

/** Plain-text answer (no parse_mode, so model markdown/code can't break
 * rendering) + a compact, de-duplicated source list. Truncated to Telegram's
 * 4096-char limit; full splitting is a Phase-2 nicety. A header surfaces the
 * routing mode + (for frontier tiers) the model used, mirroring the web badges. */
function formatAnswer(
  answer: string,
  sourceNames: string[],
  opts: { direct: boolean; tier: RouteTier; model?: string; offerFocus: boolean },
): string {
  const body = answer.trim() || "(no answer produced)";
  const { direct, tier, model, offerFocus } = opts;
  const frontier = isFrontierTier(tier);
  const modelTag = frontier && model ? ` · ${model}` : "";
  const header = direct
    ? `🧠 Direct${modelTag} (no file search)\n\n`
    : frontier
      ? `☁️ Frontier${modelTag}\n\n`
      : "";
  // On a normal answer, number the cited documents so the user can drill into one
  // with `/focus <n>`. (Suppressed when already focused — the 🎯 footer covers it.)
  const footer =
    offerFocus && sourceNames.length > 0
      ? `\n\n📎 Sources:\n${sourceNames.map((n, i) => `[${i + 1}] ${n}`).join("\n")}` +
        `\n\nReply /focus <n> to chat with just that document.`
      : "";
  let out = header + body + footer;
  if (out.length > TG_MSG_LIMIT) {
    out = out.slice(0, TG_MSG_LIMIT - 20).trimEnd() + "\n…(truncated)";
  }
  return out;
}

// ---- Telegram Bot API client (fetch-based; no dependency) ------------------

type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; username?: string };
  };
};

async function tgCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  // The token lives in the URL path. Errors are constructed from `method` +
  // the API's own `description`/status ONLY — the URL (and thus the token) is
  // never placed in a thrown/logged string. The network-failure path is caught
  // explicitly so a low-level fetch error can't surface a token-bearing URL.
  let res: Response;
  try {
    res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`${method}: request failed (network)`);
  }
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) {
    throw new Error(`${method}: ${data.description ?? `HTTP ${res.status}`}`);
  }
  return data.result as T;
}

function tgGetUpdates(token: string, offset: number, timeoutSec: number): Promise<TgUpdate[]> {
  return tgCall<TgUpdate[]>(token, "getUpdates", {
    offset,
    timeout: timeoutSec,
    allowed_updates: ["message"],
  });
}

function tgSend(token: string, chatId: number, text: string): Promise<unknown> {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

function tgAction(token: string, chatId: number, action: string): Promise<unknown> {
  return tgCall(token, "sendChatAction", { chat_id: chatId, action });
}

/** Validate a bot token by calling getMe. Returns the bot's @username, or null
 * if the token is rejected. Used by the settings route on token save. */
export async function telegramGetMe(token: string): Promise<{ username: string } | null> {
  try {
    const me = await tgCall<{ username?: string }>(token, "getMe", {});
    return me.username ? { username: me.username } : { username: "" };
  } catch {
    return null;
  }
}
