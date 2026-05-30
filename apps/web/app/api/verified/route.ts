import { z } from "zod";
import { NextResponse } from "next/server";
import {
  saveVerifiedAnswer,
  listVerifiedAnswers,
  deleteVerifiedAnswer,
  getChunksByIds,
} from "@mnemos/db";
import { hashString } from "@mnemos/core";
import { getDb, getDefaultEmbedder } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SaveRequest = z.object({
  question: z.string().min(1).max(8000),
  answer: z.string().min(1).max(20000),
  // Require ≥1 grounding chunk: every verified answer must be anchored to
  // source content so lazy invalidation has something to re-hash. (The UI only
  // offers "Save verified" when the answer has sources, so this just enforces it.)
  chunkIds: z.array(z.number().int().positive()).min(1).max(64),
  provider: z.string().optional(),
  model: z.string().optional(),
});

/** GET — list verified answers (management UI). */
export function GET() {
  try {
    return NextResponse.json({ answers: listVerifiedAnswers(getDb()) });
  } catch (err) {
    return NextResponse.json(
      { error: "list_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST — save a confirmed answer. Embeds the question for semantic recall and
 * records a content hash of the grounding chunks for lazy invalidation. The
 * stored answer is later injected into the prompt for closely-matching queries.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = SaveRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    const embedder = await getDefaultEmbedder();
    const [embedding] = await embedder.embed([parsed.data.question]);
    if (!embedding) throw new Error("Failed to embed the question.");

    // Hash the grounding chunks' text (same order/shape runQuery re-hashes for
    // invalidation). Missing chunks just hash to a shorter string.
    const chunks = getChunksByIds(db, parsed.data.chunkIds);
    const sourceHash = hashString(chunks.map((c) => c.text).join("\n"));

    const id = saveVerifiedAnswer(db, {
      question: parsed.data.question,
      answer: parsed.data.answer,
      embedding,
      sourceChunkIds: parsed.data.chunkIds,
      sourceHash,
      provider: parsed.data.provider ?? null,
      model: parsed.data.model ?? null,
    });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: "save_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** DELETE ?id=<n> — forget a verified answer. */
export function DELETE(req: Request) {
  const raw = (new URL(req.url).searchParams.get("id") ?? "").trim();
  // Strict digits-only — reject "1abc"/"1.9"/"" rather than parseInt-truncating.
  if (!/^\d+$/.test(raw)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const id = Number.parseInt(raw, 10);
  if (id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    deleteVerifiedAnswer(getDb(), id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "delete_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
