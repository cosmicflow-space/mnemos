import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  listSessions,
  getRecentMessages,
  listTelegramChats,
  createSession,
  type ChatMessage,
} from "@mnemos/db";
import { getDb } from "@/lib/runtime";

export const runtime = "nodejs";

/**
 * GET /api/sessions
 *   Returns recent sessions (newest first, default limit 50).
 *
 * GET /api/sessions?id=<sessionId>
 *   Returns the messages for that session (oldest-first, up to 200 turns).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const db = getDb();

    if (id) {
      const messages = getRecentMessages(db, id, 200);
      return NextResponse.json({
        messages: messages.map((m: ChatMessage) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: m.citations,
          provider: m.provider,
          model: m.model,
          tokensIn: m.tokensIn,
          tokensOut: m.tokensOut,
          direct: m.direct,
          createdAt: m.createdAt,
        })),
      });
    }

    // Annotate each session with whether it's the one currently live on a paired
    // Telegram chat (the 📱 "active on Telegram" badge), so the user can pick a
    // phone thread up in the browser. `telegramPaired` tells the UI whether to
    // offer "Continue on phone" on the other sessions. No schema change — derived
    // from the existing chat→session binding.
    const sessions = listSessions(db, 50);
    const boundSessionIds = new Set(
      listTelegramChats(db)
        .map((c) => c.sessionId)
        .filter((s): s is string => Boolean(s)),
    );
    const telegramPaired = listTelegramChats(db).length > 0;
    return NextResponse.json({
      telegramPaired,
      sessions: sessions.map((s) => ({
        ...s,
        telegramActive: boundSessionIds.has(s.id),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "sessions_query_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/sessions — create a new empty session and return its id.
 *
 * Used when a `/do` command is the first action in a fresh chat: the working-set
 * state and any later questions must share one real session id (so it shows in
 * the sidebar and continues to the phone). Titled lazily by the first question.
 */
export function POST() {
  try {
    const id = randomUUID();
    createSession(getDb(), id);
    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json(
      { error: "session_create_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
