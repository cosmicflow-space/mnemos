import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getConfigStatus,
  setProviderConfig,
  hydrateProcessEnv,
  PROVIDER_IDS,
  type ProviderId,
} from "@/lib/config";

export const runtime = "nodejs";

// On every request, ensure ~/.mnemos/.env values are reflected in process.env
// so chat/embed routes pick up the latest credentials without a server restart.
hydrateProcessEnv();

const SaveRequest = z.object({
  provider: z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]),
  apiKey: z.string().optional(),
  ollamaBaseUrl: z.string().url().optional(),
  ollamaModel: z.string().optional(),
  model: z.string().max(200).optional(),
});

export function GET() {
  return NextResponse.json(getConfigStatus());
}

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
    const status = setProviderConfig(parsed.data);
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      {
        error: "save_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
