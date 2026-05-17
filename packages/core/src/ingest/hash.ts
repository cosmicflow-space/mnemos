/**
 * Streaming SHA-256 content hashing.
 *
 * Used to detect whether a file has changed since last ingestion. Streaming
 * (rather than read-into-buffer) keeps memory low for large PDFs and code files.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function hashFile(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export function hashString(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
