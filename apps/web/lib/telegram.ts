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
import { runQuery, getChatProvider } from "@mnemos/core";
import {
  createSession,
  getTelegramState,
  setTelegramOffset,
  consumeTelegramPairingCode,
  addTelegramChat,
  isTelegramChatPaired,
  getTelegramChatSession,
  setTelegramChatSession,
} from "@mnemos/db";
import { getDb, getRegistry, getDefaultEmbedder } from "./runtime";
import {
  getDefaultProviderId,
  getDefaultModel,
  credentialsForProvider,
} from "./config";

const TG_API = "https://api.telegram.org";
const TG_MSG_LIMIT = 4096;
const LONG_POLL_SEC = 30;
const IDLE_MS = 5_000;

const HELP =
  "Send me a question and I'll answer from your indexed documents, with sources. " +
  "Commands:\n/new — start a fresh conversation\n/help — this message";

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
    setTelegramChatSession(db, chatId, null); // next question starts fresh
    await tgSend(token, chatId, "🧹 Started a new conversation.");
    return;
  }
  if (text.startsWith("/")) {
    await tgSend(token, chatId, "Unknown command. Just send a question, or /new to reset.");
    return;
  }

  await answerQuestion(token, chatId, text);
}

async function answerQuestion(token: string, chatId: number, question: string): Promise<void> {
  const db = getDb();
  await tgAction(token, chatId, "typing").catch(() => {});

  // Per-chat session for conversation memory.
  let sessionId = getTelegramChatSession(db, chatId);
  if (!sessionId) {
    sessionId = randomUUID();
    createSession(db, sessionId, "Telegram");
    setTelegramChatSession(db, chatId, sessionId);
  }

  // Use the operator's configured provider (default local Ollama).
  const providerId = getDefaultProviderId();
  const registry = getRegistry();
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

  let embedder;
  try {
    embedder = await getDefaultEmbedder();
  } catch {
    await tgSend(token, chatId, "⚠️ The local embedder isn't ready yet — try again shortly.");
    return;
  }

  const model = getDefaultModel();
  let answer = "";
  const sources: string[] = [];
  try {
    for await (const ev of runQuery(db, embedder, provider, { query: question, sessionId, model })) {
      if (ev.phase === "delta") answer += ev.delta;
      else if (ev.phase === "retrieved") for (const h of ev.hits) sources.push(h.filePath);
      else if (ev.phase === "error") {
        await tgSend(token, chatId, `⚠️ ${ev.message}`);
        return;
      }
    }
  } catch (err) {
    await tgSend(token, chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await tgSend(token, chatId, formatAnswer(answer, sources));
}

/** Plain-text answer (no parse_mode, so model markdown/code can't break
 * rendering) + a compact, de-duplicated source list. Truncated to Telegram's
 * 4096-char limit; full splitting is a Phase-2 nicety. */
function formatAnswer(answer: string, sources: string[]): string {
  const body = answer.trim() || "(no answer produced)";
  const unique = [...new Set(sources.map((s) => s.split("/").pop() ?? s))];
  const footer =
    unique.length > 0
      ? `\n\n📎 Sources: ${unique.slice(0, 5).join(", ")}${unique.length > 5 ? ` +${unique.length - 5} more` : ""}`
      : "";
  let out = body + footer;
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
