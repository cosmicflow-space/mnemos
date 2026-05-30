import { NextResponse } from "next/server";
import { z } from "zod";
import { randomInt } from "node:crypto";
import {
  getTelegramState,
  setTelegramEnabled,
  setTelegramPairingCode,
  listTelegramChats,
  removeTelegramChat,
} from "@mnemos/db";
import { getDb } from "@/lib/runtime";
import { setEnvValue, getDefaultProviderId } from "@/lib/config";
import { telegramGetMe } from "@/lib/telegram";

export const runtime = "nodejs";

const TOKEN_ENV = "MNEMOS_TELEGRAM_BOT_TOKEN";
const PAIRING_TTL_MS = 10 * 60_000;
// Crockford-ish base32: no 0/1/I/L/O/U → unambiguous when typed on a phone.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function currentToken(): string {
  return (process.env[TOKEN_ENV] ?? "").trim();
}

function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * GET /api/telegram — channel status for the settings UI. Never returns the
 * token itself (only whether one is set).
 */
export async function GET() {
  try {
    const db = getDb();
    const state = getTelegramState(db);
    const chats = listTelegramChats(db);
    const pairingActive =
      Boolean(state.pairingCode) && (state.pairingExpiresAt ?? 0) > Date.now();
    return NextResponse.json({
      enabled: state.enabled,
      hasToken: currentToken().length > 0,
      providerId: getDefaultProviderId(),
      pairing: pairingActive
        ? { code: state.pairingCode, expiresAt: state.pairingExpiresAt }
        : null,
      chats: chats.map((c) => ({
        chatId: c.chatId,
        label: c.label,
        pairedAt: c.pairedAt,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "status_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

const PostRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-token"), token: z.string().min(20).max(100) }),
  z.object({ action: z.literal("enable") }),
  z.object({ action: z.literal("disable") }),
  z.object({ action: z.literal("pair-code") }),
]);

/**
 * POST /api/telegram — manage the channel.
 *   { action: "set-token", token } → validate via getMe, save to ~/.mnemos/.env
 *   { action: "enable" | "disable" } → toggle the poller
 *   { action: "pair-code" }         → mint a single-use, 10-min pairing code
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = PostRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const db = getDb();

    if (parsed.data.action === "set-token") {
      const token = parsed.data.token.trim();
      // Confirm the token is real before persisting, so we don't enable a dead
      // channel. getMe returns the bot's @username on success.
      const me = await telegramGetMe(token);
      if (!me) {
        return NextResponse.json(
          { error: "invalid_token", message: "Telegram rejected this token. Check it with @BotFather." },
          { status: 400 },
        );
      }
      setEnvValue(TOKEN_ENV, token);
      return NextResponse.json({ ok: true, botUsername: me.username });
    }

    if (parsed.data.action === "enable") {
      if (currentToken().length === 0) {
        return NextResponse.json(
          { error: "no_token", message: "Add a bot token before enabling." },
          { status: 400 },
        );
      }
      setTelegramEnabled(db, true);
      return NextResponse.json({ ok: true, enabled: true });
    }

    if (parsed.data.action === "disable") {
      setTelegramEnabled(db, false);
      return NextResponse.json({ ok: true, enabled: false });
    }

    // pair-code
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    setTelegramPairingCode(db, code, expiresAt);
    return NextResponse.json({ ok: true, code, expiresAt });
  } catch (err) {
    return NextResponse.json(
      { error: "action_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

const DeleteRequest = z.object({ chatId: z.number().int() });

/** DELETE /api/telegram — revoke a paired chat. */
export async function DELETE(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = DeleteRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    removeTelegramChat(getDb(), parsed.data.chatId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "delete_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
