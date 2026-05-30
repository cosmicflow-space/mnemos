/**
 * Per-file metadata chunk behavior (ingestFolder).
 *
 * Each ingested file gets one extra "metadata chunk" (ordinal -1) carrying a
 * natural-language sentence about its path, size, mtime, and type — so questions
 * like "how big is notes.txt" or "when was it modified" retrieve reliably even
 * when no content chunk ranks high.
 *
 * Uses a fake embedder (constant 384-dim vector) so the test never downloads the
 * real BGE model, but the REAL loader registry so classification/loading is
 * exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDb, type MnemosDb, addSource } from "@mnemos/db";
import type { EmbeddingProvider } from "@mnemos/plugin-sdk";
import { loadBundledPlugins, ingestFolder, MNEMOS_EMBEDDING_DIM } from "../index";

// Deterministic constant vector — retrieval ranking is irrelevant here; we only
// assert chunk rows exist. Unit-norm so sqlite-vec is happy.
const FAKE_VEC = Array.from({ length: MNEMOS_EMBEDDING_DIM }, () => 1 / Math.sqrt(MNEMOS_EMBEDDING_DIM));
const fakeEmbedder: EmbeddingProvider = {
  id: "fake-embed",
  displayName: "Fake Embedder",
  dimensions: MNEMOS_EMBEDDING_DIM,
  credentialSchema: { type: "embedLocal", displayName: "Fake", fields: [] },
  async initialize() {},
  async embed(texts: string[]) {
    return texts.map(() => [...FAKE_VEC]);
  },
};

const registry = loadBundledPlugins();

type ChunkRow = { ordinal: number; text: string };
function chunksForFile(db: MnemosDb, sourceId: number): ChunkRow[] {
  return db
    .prepare(
      `SELECT c.ordinal AS ordinal, c.text AS text
         FROM chunk c JOIN file f ON f.id = c.file_id
        WHERE f.source_id = ?
        ORDER BY c.ordinal`,
    )
    .all(sourceId) as ChunkRow[];
}

describe("ingest: per-file metadata chunk", () => {
  let tempDir: string;
  let folder: string;
  let db: MnemosDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mnemos-meta-"));
    folder = join(tempDir, "docs");
    mkdirSync(folder, { recursive: true });
    db = openDb({ path: join(tempDir, "test.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes exactly one metadata chunk (ordinal -1) carrying size + path", async () => {
    const body = "My phone number is 555-0142.\nContact me anytime.";
    writeFileSync(join(folder, "notes.txt"), body);

    const source = addSource(db, folder);
    await ingestFolder(db, registry, fakeEmbedder, source);

    const chunks = chunksForFile(db, source.id);
    const meta = chunks.filter((c) => c.ordinal === -1);
    expect(meta).toHaveLength(1);
    expect(meta[0]?.text).toContain("File metadata");
    expect(meta[0]?.text).toContain("notes.txt");
    // The raw byte count must appear so "how big" questions ground on it.
    expect(meta[0]?.text).toContain(`${Buffer.byteLength(body)} bytes`);
    // Content chunks coexist (positive ordinals).
    expect(chunks.some((c) => c.ordinal >= 0)).toBe(true);
  });

  it("does not duplicate the metadata chunk on an unchanged re-scan", async () => {
    writeFileSync(join(folder, "a.txt"), "hello world");

    const source = addSource(db, folder);
    await ingestFolder(db, registry, fakeEmbedder, source);
    await ingestFolder(db, registry, fakeEmbedder, source); // unchanged re-scan

    const meta = chunksForFile(db, source.id).filter((c) => c.ordinal === -1);
    expect(meta).toHaveLength(1);
  });

  it("backfills the metadata chunk on re-scan if it was missing", async () => {
    writeFileSync(join(folder, "b.txt"), "some content here");

    const source = addSource(db, folder);
    await ingestFolder(db, registry, fakeEmbedder, source);

    // Simulate a file ingested before this feature: drop its metadata chunk and
    // its vector row, mirroring how insertChunk/purgeFileChunks keep the two in sync.
    db.prepare(
      `DELETE FROM vec_chunk WHERE chunk_id IN (SELECT id FROM chunk WHERE ordinal = -1)`,
    ).run();
    db.prepare(`DELETE FROM chunk WHERE ordinal = -1`).run();
    expect(chunksForFile(db, source.id).filter((c) => c.ordinal === -1)).toHaveLength(0);

    // Re-scan: file is unchanged, so it hits the skip path — which must backfill.
    await ingestFolder(db, registry, fakeEmbedder, source);
    expect(chunksForFile(db, source.id).filter((c) => c.ordinal === -1)).toHaveLength(1);
  });

  it("refreshes the metadata chunk's modified-date when a file is touched", async () => {
    writeFileSync(join(folder, "touched.txt"), "stable content");
    const source = addSource(db, folder);
    await ingestFolder(db, registry, fakeEmbedder, source);

    // Touch: move mtime to a fixed past day without changing the content.
    const past = new Date("2020-01-15T12:00:00Z");
    utimesSync(join(folder, "touched.txt"), past, past);

    // Content hash is unchanged → this hits the skip path, which must still
    // refresh the metadata chunk so "when was X modified" stays accurate.
    await ingestFolder(db, registry, fakeEmbedder, source);

    const meta = chunksForFile(db, source.id).filter((c) => c.ordinal === -1);
    expect(meta).toHaveLength(1); // refreshed in place, not duplicated
    expect(meta[0]?.text).toContain("2020-01-15");
  });

  it("gives an empty file its metadata chunk (no content chunks)", async () => {
    writeFileSync(join(folder, "empty.txt"), "");

    const source = addSource(db, folder);
    await ingestFolder(db, registry, fakeEmbedder, source);

    const chunks = chunksForFile(db, source.id);
    // No content chunks, but exactly one metadata chunk so "how big is empty.txt"
    // still has something to retrieve.
    expect(chunks.filter((c) => c.ordinal >= 0)).toHaveLength(0);
    const meta = chunks.filter((c) => c.ordinal === -1);
    expect(meta).toHaveLength(1);
    expect(meta[0]?.text).toContain("empty.txt");
    expect(meta[0]?.text).toContain("0 bytes");
  });
});
