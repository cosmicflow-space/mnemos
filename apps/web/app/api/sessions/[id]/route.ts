import { NextResponse } from "next/server";
import { getDb } from "@/lib/runtime";

export const runtime = "nodejs";

/**
 * DELETE /api/sessions/:id
 *
 * Removes a chat session and cascades to chat_message via foreign key.
 * Used by the sidebar trash icon. No auth check beyond the middleware's
 * loopback/bearer gate; on a personal machine this is safe.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  try {
    const db = getDb();
    const result = db.prepare("DELETE FROM session WHERE id = ?").run(id);
    return NextResponse.json({
      ok: true,
      removed: Number(result.changes) > 0,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "delete_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
