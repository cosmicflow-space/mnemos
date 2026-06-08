/**
 * POST /api/telegram/bind-session — "Continue on phone".
 *
 * Re-points the operator's paired Telegram chat(s) at a chosen session, so a
 * thread started (or continued) in the browser can be picked up on the phone.
 * Because focus + working-set are keyed by the shared session id, the phone
 * inherits the exact scope — nothing else to copy. Query-only trust model is
 * intact: this changes which session the chat is bound to, never a user file.
 */

import { z } from "zod";
import { getSession, listTelegramChats, setTelegramChatSession } from "@mnemos/db";
import { getDb } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ sessionId: z.string().min(1) });

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ ok: false, reason: "invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ ok: false, reason: "invalid request" }, { status: 400 });
  }
  const db = getDb();
  const { sessionId } = parsed.data;

  if (!getSession(db, sessionId)) {
    return Response.json({ ok: false, reason: "unknown session" }, { status: 404 });
  }
  const chats = listTelegramChats(db);
  if (chats.length === 0) {
    return Response.json({ ok: false, reason: "no paired Telegram chat" }, { status: 409 });
  }
  for (const chat of chats) setTelegramChatSession(db, chat.chatId, sessionId);
  return Response.json({ ok: true, bound: chats.length });
}
