import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readCredentialValue,
  fingerprint,
  type ProviderId,
} from "@/lib/credential-scan";
import { setProviderConfig } from "@/lib/config";

export const runtime = "nodejs";

const PROVIDER_VALUES = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "local",
] as const satisfies readonly Exclude<ProviderId, "anthropic-oauth">[];

const ImportRequest = z.object({
  provider: z.enum(PROVIDER_VALUES),
  source: z.enum(["env", "rc-file", "json-file"]),
  location: z.string().min(1),
});

/**
 * POST /api/credentials/import
 *
 * Reads the value at the user-confirmed location and writes it into
 * `~/.mnemos/.env`. This is the *one* place the user grants permission for
 * Mnemos to actually open the file's contents — every prior step was
 * existence-only.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = ImportRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const value = readCredentialValue(parsed.data);
    if (!value) {
      return NextResponse.json(
        { error: "not_found", message: "No credential value at that location." },
        { status: 404 },
      );
    }

    const status = setProviderConfig({
      provider: parsed.data.provider,
      apiKey: value,
    });

    return NextResponse.json({
      ok: true,
      status,
      fingerprint: fingerprint(value),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "import_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
