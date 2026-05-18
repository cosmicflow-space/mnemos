import { NextResponse } from "next/server";
import { z } from "zod";
import { scanFolder } from "@mnemos/core";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const runtime = "nodejs";

const ScanRequest = z.object({
  path: z.string().min(1),
});

/** Resolve `~/foo` to the absolute path. */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(p.replace(/^~/, homedir()));
  }
  return resolve(p);
}

/**
 * POST /api/sources/scan
 * Body: { path: string }
 *
 * Read-only filesystem inspection — counts files by type without ingesting.
 * Powers the "Browse → Scan" preview UX. Cheap enough to run on every change.
 *
 * Returns a summary the UI uses to show "Found 24 PDFs, 50 markdown files,
 * 14 plaintext, 8 source files. 20 images recognized (OCR coming in v0.2)."
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = ScanRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const absolutePath = expandHome(parsed.data.path);

  try {
    const result = await scanFolder(absolutePath);
    return NextResponse.json({
      rootPath: result.rootPath,
      summary: result.summary,
      skippedDirs: result.skippedDirs,
      // Cap file list at 200 for the response payload; UI shows totals only
      previewFiles: result.files.slice(0, 200).map((f) => ({
        relativePath: f.relativePath,
        sizeBytes: f.sizeBytes,
        category: f.classification.category,
        kind: f.classification.kind,
        label: f.classification.label,
      })),
      hasMoreFiles: result.files.length > 200,
      defaultExcluded: result.defaultExcluded,
      securityExcluded: result.securityExcluded,
      largeFiles: result.largeFiles,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "scan_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
