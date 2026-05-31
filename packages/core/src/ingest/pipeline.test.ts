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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDb, type MnemosDb, addSource } from "@mnemos/db";
import type { EmbeddingProvider } from "@mnemos/plugin-sdk";
import { loadBundledPlugins, ingestFolder, scanFolder, estimateIngest, MNEMOS_EMBEDDING_DIM } from "../index";

describe("estimateIngest", () => {
  const f = (sizeBytes: number, kind: string) => ({ sizeBytes, classification: { kind } });
  it("estimates ~2 chunks per image (OCR), not bytes-proportional", () => {
    const est = estimateIngest([f(5_000_000, "image"), f(2_000_000, "image")]);
    expect(est.chunks).toBe(4); // 2 each, regardless of (large) byte size
  });
  it("scales text-file chunk count with size and derives seconds", () => {
    const small = estimateIngest([f(700, "plaintext")]);
    const big = estimateIngest([f(70_000, "markdown")]);
    expect(big.chunks).toBeGreaterThan(small.chunks);
    expect(big.seconds).toBe(Math.ceil(big.chunks / 8));
  });
  it("discounts PDF/office bytes (text < file bytes)", () => {
    // same byte size: a PDF yields fewer estimated chunks than plain text
    expect(estimateIngest([f(100_000, "pdf")]).chunks).toBeLessThan(
      estimateIngest([f(100_000, "plaintext")]).chunks,
    );
  });
});

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

  it("marks a load-error file 'failed', skips it on auto re-scan, re-attempts with retryFailed", async () => {
    // Garbage bytes with a .xlsx extension → the xlsx loader (exceljs) throws.
    writeFileSync(join(folder, "corrupt.xlsx"), "not a real spreadsheet");
    const source = addSource(db, folder);

    // 1st ingest: the load error is recorded.
    const r1 = await ingestFolder(db, registry, fakeEmbedder, source);
    expect(r1.errors.length).toBeGreaterThanOrEqual(1);

    // 2nd ingest (auto — no retryFailed): the failed file is skipped, NOT
    // re-parsed (zero new errors), so a background watcher won't re-burn on it.
    const r2 = await ingestFolder(db, registry, fakeEmbedder, source);
    expect(r2.errors).toHaveLength(0);
    expect(r2.filesSkipped).toBeGreaterThanOrEqual(1);

    // 3rd ingest (retryFailed — user-initiated): re-attempts it (errors again).
    const r3 = await ingestFolder(db, registry, fakeEmbedder, source, { retryFailed: true });
    expect(r3.errors.length).toBeGreaterThanOrEqual(1);
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

describe("ingest: single-file sources", () => {
  let tempDir: string;
  let db: MnemosDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mnemos-file-"));
    db = openDb({ path: join(tempDir, "test.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("scanFolder treats a single file as one scanned file (relativePath = basename)", async () => {
    const filePath = join(tempDir, "report.txt");
    writeFileSync(filePath, "quarterly numbers");

    const scan = await scanFolder(filePath);
    expect(scan.files).toHaveLength(1);
    expect(scan.files[0]?.relativePath).toBe("report.txt");
    expect(scan.files[0]?.absolutePath).toBe(filePath);
    expect(scan.files[0]?.classification.category).toBe("supported");
  });

  it("scanFolder still security-excludes a hard-locked single file (.env)", async () => {
    const filePath = join(tempDir, ".env");
    writeFileSync(filePath, "ANTHROPIC_API_KEY=sk-should-never-be-indexed");

    const scan = await scanFolder(filePath);
    // Security hard-lock applies even when the file is explicitly chosen.
    expect(scan.files).toHaveLength(0);
    expect(scan.securityExcluded.totalCount).toBe(1);
  });

  it("hard-locks a single file by PARENT directory (e.g. ~/.aws/config)", async () => {
    // basename "config" carries no signal — only the .aws/ parent does. The
    // hard-lock must check the absolute path, not just the basename.
    const awsDir = join(tempDir, ".aws");
    mkdirSync(awsDir, { recursive: true });
    const filePath = join(awsDir, "config");
    writeFileSync(filePath, "[default]\nregion=us-east-1\naws_secret_access_key=...");

    const scan = await scanFolder(filePath);
    expect(scan.files).toHaveLength(0);
    expect(scan.securityExcluded.totalCount).toBe(1);
  });

  it("hard-locks a benignly-named symlink that points at a secret", async () => {
    const secret = join(tempDir, ".env");
    writeFileSync(secret, "OPENAI_API_KEY=sk-secret");
    const link = join(tempDir, "harmless-notes.txt");
    symlinkSync(secret, link);

    // The link name looks innocent; resolving it reveals the .env target.
    const scan = await scanFolder(link);
    expect(scan.files).toHaveLength(0);
    expect(scan.securityExcluded.totalCount).toBe(1);
  });

  it("hard-locks files when a credential directory is registered as a FOLDER", async () => {
    const awsDir = join(tempDir, ".aws");
    mkdirSync(awsDir, { recursive: true });
    writeFileSync(join(awsDir, "config"), "region=us-east-1");
    writeFileSync(join(awsDir, "notes.txt"), "just notes");

    // Registering the .aws dir itself as a source root must not strip the
    // .aws/ context — every file under it is hard-locked.
    const scan = await scanFolder(awsDir);
    expect(scan.files).toHaveLength(0);
    expect(scan.securityExcluded.totalCount).toBe(2);
  });

  it("hard-locks a benignly-named DIRECTORY symlink pointing at a credential dir", async () => {
    // The picker can navigate (and a user can pick) a symlinked directory. If
    // the scan walked the alias path instead of the real target, credential
    // files inside (.ssh/config, known_hosts) would dodge the hard-lock and be
    // ingested. The walk must canonicalize the root first.
    const sshDir = join(tempDir, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(join(sshDir, "config"), "Host github.com");
    writeFileSync(join(sshDir, "known_hosts"), "github.com ssh-ed25519 AAAA...");
    const alias = join(tempDir, "my-notes"); // innocent-looking folder name
    symlinkSync(sshDir, alias);

    const scan = await scanFolder(alias);
    expect(scan.files).toHaveLength(0);
    expect(scan.securityExcluded.totalCount).toBe(2);
  });

  it("ingests a single-file source into content + metadata chunks", async () => {
    const registry = loadBundledPlugins();
    const filePath = join(tempDir, "notes.md");
    writeFileSync(filePath, "# Notes\n\nThe launch code is alpha-seven.");

    const source = addSource(db, filePath, "file");
    expect(source.kind).toBe("file");

    const result = await ingestFolder(db, registry, fakeEmbedder, source);
    expect(result.filesProcessed).toBe(1);

    const chunks = db
      .prepare(
        `SELECT c.ordinal AS ordinal, c.text AS text
           FROM chunk c JOIN file f ON f.id = c.file_id
          WHERE f.source_id = ? ORDER BY c.ordinal`,
      )
      .all(source.id) as Array<{ ordinal: number; text: string }>;

    // At least one content chunk (ordinal >= 0) plus the metadata chunk (-1).
    expect(chunks.some((c) => c.ordinal >= 0)).toBe(true);
    const meta = chunks.filter((c) => c.ordinal === -1);
    expect(meta).toHaveLength(1);
    expect(meta[0]?.text).toContain("notes.md");
  });
});
