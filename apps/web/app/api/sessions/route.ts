import { NextResponse } from "next/server";
import { listSessions, getRecentMessages, type ChatMessage } from "@mnemos/db";
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

    const sessions = listSessions(db, 50);
    return NextResponse.json({ sessions });
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
