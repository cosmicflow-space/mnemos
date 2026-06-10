/**
 * Smoke test — verifies the core scaffolding actually works end-to-end:
 *   - DB opens (sqlite-vec loads)
 *   - Schema applies
 *   - CRUD round-trips
 *   - Plugin registry validates manifests
 *   - Crypto round-trips
 *
 * Does NOT make any external API calls. Provider initialization is checked
 * structurally; actual chat calls require credentials and live network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDb,
  type MnemosDb,
  addSource,
  upsertFile,
  insertChunk,
  getContentChunksForFile,
  getCorpusStats,
  listSources,
  getSourceByPath,
  removeSource,
  setSourceWatchInterval,
  setSourcePaused,
  touchSourceScanned,
  listDueSources,
  tryClaimIngest,
  releaseIngest,
  STALE_INGEST_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  getTelegramState,
  setTelegramPairingCode,
  consumeTelegramPairingCode,
  addTelegramChat,
  isTelegramChatPaired,
  listTelegramChats,
  removeTelegramChat,
  setTelegramOffset,
  upsertCredential,
  getCredentialByName,
  createSession,
  appendMessage,
  getRecentMessages,
  appendAudit,
  listAuditEvents,
} from "@mnemos/db";
import {
  loadBundledPlugins,
  getChatProvider,
  getEmbeddingProvider,
  getDocumentLoader,
  generateEncryptionKey,
  encryptString,
  decryptString,
  DEFAULT_EMBEDDING_PROVIDER_ID,
  MNEMOS_EMBEDDING_DIM,
  runQuery,
} from "./index";
import type { ChatProvider, EmbeddingProvider } from "@mnemos/plugin-sdk";
import { isInventoryQuestion } from "./query/runQuery";

describe("smoke: db + registry + crypto", () => {
  let tempDir: string;
  let db: MnemosDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mnemos-smoke-"));
    db = openDb({ path: join(tempDir, "test.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("opens DB with sqlite-vec and applies schema", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("source");
    expect(names).toContain("file");
    expect(names).toContain("chunk");
    expect(names).toContain("credential");
    expect(names).toContain("session");
    expect(names).toContain("chat_message");
    expect(names).toContain("audit_event");
    expect(names).toContain("schema_version");
    // vec_chunk virtual table is registered under the same master listing
    expect(names.some((n) => n === "vec_chunk" || n.startsWith("vec_chunk"))).toBe(
      true,
    );
  });

  it("round-trips source add/list/get/remove", () => {
    const added = addSource(db, "/tmp/foo");
    expect(added.path).toBe("/tmp/foo");
    expect(added.kind).toBe("folder");
    expect(added.scope).toBe("read-only");
    expect(added.id).toBeGreaterThan(0);

    const all = listSources(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.path).toBe("/tmp/foo");

    const found = getSourceByPath(db, "/tmp/foo");
    expect(found?.id).toBe(added.id);

    const result = removeSource(db, "/tmp/foo");
    expect(result.chunksPurged).toBe(0); // no chunks to purge in this test

    expect(listSources(db)).toHaveLength(0);
  });

  it("defaults new sources to manual, and schedules per-source interval", () => {
    const now = 1_000_000_000_000;

    // Default is MANUAL (0): a new source is NOT auto-scanned until opted in.
    const def = addSource(db, "/tmp/default");
    expect(DEFAULT_WATCH_INTERVAL_MS).toBe(0);
    expect(def.watchIntervalMs).toBe(0);
    expect(def.lastScannedAt).toBeNull();
    expect(listDueSources(db, now).map((s) => s.path)).not.toContain("/tmp/default");

    // A source given an explicit cadence + never scanned → due immediately.
    const hourly = addSource(db, "/tmp/hourly", "folder", 60 * 60_000);
    expect(listDueSources(db, now).map((s) => s.path)).toContain("/tmp/hourly");
    // Just scanned → not due until a full interval elapses.
    touchSourceScanned(db, hourly.id, now);
    expect(listDueSources(db, now).map((s) => s.path)).not.toContain("/tmp/hourly");
    expect(listDueSources(db, now + 60 * 60_000).map((s) => s.path)).toContain("/tmp/hourly");

    // Editing the cadence takes effect: manual → every 5 min.
    setSourceWatchInterval(db, def.id, 5 * 60_000);
    expect(getSourceByPath(db, "/tmp/default")?.watchIntervalMs).toBe(5 * 60_000);
    expect(listDueSources(db, now).map((s) => s.path)).toContain("/tmp/default");

    // A paused source is excluded from the watcher's due-list — even when its
    // cadence makes it otherwise due. This is what stops the watcher from
    // auto-resuming a user-paused source on the next tick.
    setSourcePaused(db, def.id, true);
    expect(getSourceByPath(db, "/tmp/default")?.paused).toBe(true);
    expect(listDueSources(db, now).map((s) => s.path)).not.toContain("/tmp/default");
    setSourcePaused(db, def.id, false);
    expect(listDueSources(db, now).map((s) => s.path)).toContain("/tmp/default");

    // url/mailbox kinds are never filesystem-rescanned.
    addSource(db, "https://example.com", "url", 5 * 60_000);
    expect(listDueSources(db, now).map((s) => s.path)).not.toContain("https://example.com");
  });

  it("ingest lease is mutually exclusive, fenced, and reclaims stale claims", () => {
    const src = addSource(db, "/tmp/leased");
    const t0 = 2_000_000_000_000;

    // First claim wins (returns its token); a second concurrent claim loses.
    const token = tryClaimIngest(db, src.id, t0);
    expect(token).toBe(t0);
    expect(tryClaimIngest(db, src.id, t0)).toBeNull();
    // Still held a little later (not yet stale).
    expect(tryClaimIngest(db, src.id, t0 + 1000)).toBeNull();

    // Releasing with the right token frees it.
    releaseIngest(db, src.id, token as number);
    const token2 = tryClaimIngest(db, src.id, t0 + 2000);
    expect(token2).toBe(t0 + 2000);

    // A crashed holder's claim is reclaimable once it goes stale.
    expect(tryClaimIngest(db, src.id, t0 + 2000 + 1000)).toBeNull();
    const stolen = tryClaimIngest(db, src.id, t0 + 2000 + STALE_INGEST_MS + 1);
    expect(stolen).not.toBeNull();

    // Fencing: the old holder (token2) releasing must NOT clear the new
    // holder's (stolen) lease — its token no longer matches.
    releaseIngest(db, src.id, token2 as number);
    expect(tryClaimIngest(db, src.id, t0 + 2000 + STALE_INGEST_MS + 2)).toBeNull();
  });

  it("telegram pairing code is single-use, time-boxed, and gates the allowlist", () => {
    const now = 3_000_000_000_000;
    // Default-deny: nobody is paired, state disabled, offset 0.
    expect(getTelegramState(db).enabled).toBe(false);
    expect(getTelegramState(db).updateOffset).toBe(0);
    expect(isTelegramChatPaired(db, 12345)).toBe(false);

    setTelegramPairingCode(db, "ABCD2345", now + 600_000);

    // Wrong code, and a correct code past expiry, both fail.
    expect(consumeTelegramPairingCode(db, "WRONG777", now)).toBe(false);
    expect(consumeTelegramPairingCode(db, "ABCD2345", now + 700_000)).toBe(false);

    // Correct + unexpired succeeds exactly once (single-use).
    expect(consumeTelegramPairingCode(db, "ABCD2345", now)).toBe(true);
    expect(consumeTelegramPairingCode(db, "ABCD2345", now)).toBe(false);

    // Pairing adds to the allowlist; removal revokes.
    addTelegramChat(db, 12345, "Sam");
    expect(isTelegramChatPaired(db, 12345)).toBe(true);
    expect(listTelegramChats(db).map((c) => c.chatId)).toEqual([12345]);
    removeTelegramChat(db, 12345);
    expect(isTelegramChatPaired(db, 12345)).toBe(false);

    // Offset persists (no reprocessing across restarts).
    setTelegramOffset(db, 42);
    expect(getTelegramState(db).updateOffset).toBe(42);
  });

  it("upserts credentials idempotently", () => {
    const first = upsertCredential(db, {
      name: "anthropic",
      type: "anthropicApi",
      encryptedData: "ciphertext-v1",
    });
    expect(first.name).toBe("anthropic");

    const second = upsertCredential(db, {
      name: "anthropic",
      type: "anthropicApi",
      encryptedData: "ciphertext-v2",
    });
    expect(second.id).toBe(first.id);
    expect(second.encryptedData).toBe("ciphertext-v2");

    const fetched = getCredentialByName(db, "anthropic");
    expect(fetched?.encryptedData).toBe("ciphertext-v2");
  });

  it("appends and retrieves chat messages in chronological order", () => {
    const sessionId = "test-session-1";
    createSession(db, sessionId, "Smoke session");

    appendMessage(db, { sessionId, role: "user", content: "first" });
    appendMessage(db, { sessionId, role: "assistant", content: "second" });
    appendMessage(db, { sessionId, role: "user", content: "third" });

    const recent = getRecentMessages(db, sessionId, 10);
    expect(recent.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("audit events round-trip with parsed data", () => {
    appendAudit(db, "query", { q: "hello world", chunks: 8 });
    appendAudit(db, "ingest", { folder: "/tmp/foo", count: 100 });

    const all = listAuditEvents(db);
    expect(all).toHaveLength(2);

    const queryOnly = listAuditEvents(db, { eventType: "query" });
    expect(queryOnly).toHaveLength(1);
    expect(queryOnly[0]?.data).toEqual({ q: "hello world", chunks: 8 });
  });
});

describe("smoke: plugin registry", () => {
  it("loads all 15 bundled plugins without validation errors", () => {
    const registry = loadBundledPlugins();
    expect(registry.plugins.length).toBe(15);
  });

  it("registers chat providers (anthropic, openai, codex, gemini, ollama)", () => {
    const registry = loadBundledPlugins();
    // llama-cpp remains a stub without chatProviders
    expect(registry.chatProviders.size).toBeGreaterThanOrEqual(5);
    expect(registry.chatProviders.has("anthropic")).toBe(true);
    expect(registry.chatProviders.has("openai")).toBe(true);
    expect(registry.chatProviders.has("codex")).toBe(true);
    expect(registry.chatProviders.has("gemini")).toBe(true);
    expect(registry.chatProviders.has("ollama")).toBe(true);
  });

  it("registers embedding providers (embed-local, openai, ollama)", () => {
    const registry = loadBundledPlugins();
    expect(registry.embeddingProviders.size).toBeGreaterThanOrEqual(3);
    expect(registry.embeddingProviders.has("embed-local")).toBe(true);
    expect(registry.embeddingProviders.has("openai")).toBe(true);
    expect(registry.embeddingProviders.has("ollama")).toBe(true);
  });

  it("default embedding provider is embed-local and matches Mnemos standard dim", () => {
    expect(DEFAULT_EMBEDDING_PROVIDER_ID).toBe("embed-local");
    expect(MNEMOS_EMBEDDING_DIM).toBe(384);
    const registry = loadBundledPlugins();
    const defaultEmbed = getEmbeddingProvider(registry, DEFAULT_EMBEDDING_PROVIDER_ID);
    expect(defaultEmbed.dimensions).toBe(MNEMOS_EMBEDDING_DIM);
  });

  it("all embedding providers report the same standard dimension (384)", () => {
    const registry = loadBundledPlugins();
    for (const provider of registry.embeddingProviders.values()) {
      expect(provider.dimensions).toBe(MNEMOS_EMBEDDING_DIM);
    }
  });

  it("looks up chat provider by id", () => {
    const registry = loadBundledPlugins();
    const provider = getChatProvider(registry, "anthropic");
    expect(provider.id).toBe("anthropic");
    expect(provider.displayName).toContain("Claude");
  });

  it("throws when looking up unknown provider", () => {
    const registry = loadBundledPlugins();
    expect(() => getChatProvider(registry, "nonexistent")).toThrow(/not found/);
  });

  it("can look up loaders by id or extension (when loaders are registered)", () => {
    const registry = loadBundledPlugins();
    // Bundled loaders (pdf, markdown, plaintext, web, code) are registered, so a
    // known extension resolves to a loader; an unknown one throws helpfully.
    expect(getDocumentLoader(registry, ".pdf")).toBeTruthy();
    expect(() => getDocumentLoader(registry, ".no-such-ext")).toThrow(
      /No document loader/,
    );
  });

  it("does not register duplicate provider ids", () => {
    // The registry constructor would have thrown if there were duplicates,
    // and we successfully loaded above. This test is a no-op confirmation.
    const registry = loadBundledPlugins();
    expect(registry.chatProviders.size).toBe(
      new Set([...registry.chatProviders.keys()]).size,
    );
  });
});

describe("smoke: crypto", () => {
  it("round-trips AES-256-GCM with fresh key per call", () => {
    const key = generateEncryptionKey();
    expect(key.length).toBe(32);

    const plaintext = "sk-ant-this-is-a-test-secret-12345";
    const encoded = encryptString(plaintext, key);
    expect(encoded).not.toContain(plaintext);
    expect(encoded.split(":")).toHaveLength(3);

    const decoded = decryptString(encoded, key);
    expect(decoded).toBe(plaintext);
  });

  it("rejects wrong key with auth tag failure", () => {
    const keyA = generateEncryptionKey();
    const keyB = generateEncryptionKey();
    const encoded = encryptString("hello", keyA);
    expect(() => decryptString(encoded, keyB)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const key = generateEncryptionKey();
    const encoded = encryptString("hello", key);
    const parts = encoded.split(":");
    // Flip a bit in the ciphertext (last component)
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]?.slice(0, -2)}ff`;
    expect(() => decryptString(tampered, key)).toThrow();
  });

  it("rejects wrong key size", () => {
    const shortKey = Buffer.alloc(16);
    expect(() => encryptString("x", shortKey)).toThrow(/32 bytes/);
  });
});

describe("smoke: provider structure (no live API calls)", () => {
  it("anthropic provider has expected shape and refuses uninitialized chat", async () => {
    const registry = loadBundledPlugins();
    const provider = getChatProvider(registry, "anthropic");

    expect(provider.credentialSchema.type).toBe("anthropicApi");
    expect(provider.credentialSchema.fields.length).toBeGreaterThanOrEqual(1);

    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.some((m) => m.id.includes("sonnet"))).toBe(true);

    // Should throw if we try to chat without initializing
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
        // no-op
      }
    }).rejects.toThrow(/not initialized/);
  });

  it("openai chat provider has expected shape", async () => {
    const registry = loadBundledPlugins();
    const provider = getChatProvider(registry, "openai");
    expect(provider.credentialSchema.type).toBe("openAIApi");
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
  });

  it("openai embedding provider reports standard dim (384) via Matryoshka truncation", () => {
    const registry = loadBundledPlugins();
    const provider = getEmbeddingProvider(registry, "openai");
    expect(provider.dimensions).toBe(MNEMOS_EMBEDDING_DIM);
  });

  it("embed-local provider reports standard dim (384) and bundled model", () => {
    const registry = loadBundledPlugins();
    const provider = getEmbeddingProvider(registry, "embed-local");
    expect(provider.dimensions).toBe(384);
    expect(provider.credentialSchema.type).toBe("embedLocal");
  });
});

// Regression guard for the "metadata chunk decoy" bug: a per-file metadata chunk
// (ordinal -1) is a strong lexical match for filename-mentioning questions but
// holds no answer, so retrieval could surface it while burying the file's actual
// content. getContentChunksForFile is how runQuery expands a metadata hit back
// into the file's content. See packages/core/src/query/runQuery.ts (step 2b).
describe("co-retrieval: getContentChunksForFile", () => {
  let tempDir: string;
  let db: MnemosDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mnemos-coretrieval-"));
    db = openDb({ path: join(tempDir, "test.db") });
  });
  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedFile(path: string, contentOrdinals: number[]): number {
    const src = addSource(db, `/tmp/${path}-src`);
    const { fileId } = upsertFile(db, {
      sourceId: src.id,
      path,
      contentHash: `hash-${path}`,
      sizeBytes: 100,
      mtime: 1,
      loader: "plaintext",
    });
    const vec = new Array(384).fill(0);
    // The synthetic metadata chunk (ordinal -1) plus content chunks (0..n).
    insertChunk(db, { fileId, ordinal: -1, text: `metadata for ${path}`, startOffset: 0, endOffset: 0, embedding: vec });
    for (const o of contentOrdinals) {
      insertChunk(db, { fileId, ordinal: o, text: `content ${o}`, startOffset: o, endOffset: o + 1, embedding: vec });
    }
    return fileId;
  }

  it("returns content chunks (ordinal >= 0) in document order, excluding the metadata chunk", () => {
    const fileId = seedFile("vin.txt", [0, 1, 2]);
    const got = getContentChunksForFile(db, fileId, 5, 0.42);
    expect(got.map((c) => c.ordinal)).toEqual([0, 1, 2]); // no -1, in order
    expect(got.map((c) => c.text)).toEqual(["content 0", "content 1", "content 2"]);
    expect(got.every((c) => c.distance === 0.42)).toBe(true); // inherited distance stamped
  });

  it("caps expansion at the requested limit", () => {
    const fileId = seedFile("big.md", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const got = getContentChunksForFile(db, fileId, 3, 0.5);
    expect(got).toHaveLength(3);
    expect(got.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it("returns nothing for a metadata-only file (no content chunks)", () => {
    const fileId = seedFile("empty.txt", []);
    expect(getContentChunksForFile(db, fileId, 3, 0.1)).toHaveLength(0);
  });

  it("getCorpusStats reports whole-index totals, not a retrieved subset", () => {
    const vec = new Array(384).fill(0);
    const s1 = addSource(db, "/tmp/stats-s1");
    const f1 = upsertFile(db, { sourceId: s1.id, path: "a.md", contentHash: "1", sizeBytes: 1, mtime: 1, loader: "markdown" }).fileId;
    const f2 = upsertFile(db, { sourceId: s1.id, path: "b.txt", contentHash: "2", sizeBytes: 1, mtime: 1, loader: "plaintext" }).fileId;
    const s2 = addSource(db, "/tmp/stats-s2");
    const f3 = upsertFile(db, { sourceId: s2.id, path: "c.md", contentHash: "3", sizeBytes: 1, mtime: 1, loader: "markdown" }).fileId;
    insertChunk(db, { fileId: f1, ordinal: -1, text: "m", startOffset: 0, endOffset: 0, embedding: vec });
    insertChunk(db, { fileId: f1, ordinal: 0, text: "x", startOffset: 0, endOffset: 1, embedding: vec });
    insertChunk(db, { fileId: f2, ordinal: 0, text: "y", startOffset: 0, endOffset: 1, embedding: vec });
    insertChunk(db, { fileId: f3, ordinal: 0, text: "z", startOffset: 0, endOffset: 1, embedding: vec });

    const stats = getCorpusStats(db);
    expect(stats.totalFiles).toBe(3);
    expect(stats.totalChunks).toBe(4); // 3 content + 1 metadata, matching the Sources panel's count
    expect(stats.byType.find((t) => t.loader === "markdown")?.fileCount).toBe(2);
    expect(stats.byType.find((t) => t.loader === "plaintext")?.fileCount).toBe(1);
    const s1stats = stats.sources.find((s) => s.path === "/tmp/stats-s1");
    expect(s1stats?.fileCount).toBe(2);
    expect(s1stats?.chunkCount).toBe(3);
  });

  it("isInventoryQuestion gates corpus stats to count/inventory phrasings only", () => {
    for (const q of [
      "how many documents do I have?",
      "what is the total number of files?",
      "count my PDFs",
      "which folders are indexed?",
      "list all my documents",
      "what types of files are in here?",
    ]) {
      expect(isInventoryQuestion(q)).toBe(true);
    }
    for (const q of [
      "what is my car VIN?",
      "summarize the field test report",
      "when was the spec last modified?",
    ]) {
      expect(isInventoryQuestion(q)).toBe(false);
    }
  });
});

// End-to-end guard for the injection loop in runQuery (step 2b): when a file
// surfaces ONLY via its metadata chunk, its content must be co-retrieved AND
// spliced immediately after the metadata hit (not appended at the tail).
describe("co-retrieval: runQuery splices content next to a metadata-only file hit", () => {
  let tempDir: string;
  let db: MnemosDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mnemos-runquery-"));
    db = openDb({ path: join(tempDir, "test.db") });
  });
  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("pulls a file's content in right after its metadata chunk when only metadata ranked", async () => {
    const axis = (i: number): number[] => {
      const a = new Array(384).fill(0);
      a[i] = 1;
      return a;
    };
    const nearAxis0 = (): number[] => {
      const a = new Array(384).fill(0);
      a[0] = 0.9;
      return a;
    };

    // File A: metadata chunk sits on the query axis (closest); its content chunk
    // is orthogonal (far), so a small top-K won't retrieve the content directly.
    const srcA = addSource(db, "/tmp/run-A");
    const fileA = upsertFile(db, { sourceId: srcA.id, path: "vin.txt", contentHash: "a", sizeBytes: 50, mtime: 1, loader: "plaintext" }).fileId;
    insertChunk(db, { fileId: fileA, ordinal: -1, text: "metadata for vin.txt", startOffset: 0, endOffset: 0, embedding: axis(0) });
    insertChunk(db, { fileId: fileA, ordinal: 0, text: "the VIN is XYZ123", startOffset: 0, endOffset: 17, embedding: axis(1) });

    // File B: a filler content chunk near the query axis — takes the other top-K slot.
    const srcB = addSource(db, "/tmp/run-B");
    const fileB = upsertFile(db, { sourceId: srcB.id, path: "other.txt", contentHash: "b", sizeBytes: 50, mtime: 1, loader: "plaintext" }).fileId;
    insertChunk(db, { fileId: fileB, ordinal: 0, text: "unrelated filler", startOffset: 0, endOffset: 16, embedding: nearAxis0() });

    createSession(db, "s1", "test");

    const embedder = { embed: async () => [axis(0)] } as unknown as EmbeddingProvider;
    // Chat is never invoked: we break after the "retrieved" event.
    const chat = { chat: async function* () {} } as unknown as ChatProvider;

    let hits: Array<{ filePath: string; text: string }> | undefined;
    for await (const ev of runQuery(db, embedder, chat, { query: "VIN in vin.txt?", sessionId: "s1", topK: 2 })) {
      if (ev.phase === "retrieved") {
        hits = ev.hits;
        break;
      }
    }

    expect(hits).toBeDefined();
    const vinIdx = hits!.findIndex((h) => h.text.includes("the VIN is"));
    // The content chunk was co-retrieved even though it didn't rank in the top-2…
    expect(vinIdx).toBeGreaterThanOrEqual(0);
    // …and it sits immediately after its file's metadata chunk (adjacency, not tail).
    expect(hits![vinIdx - 1]?.text).toContain("metadata for vin.txt");
  });
});

// Direct-to-model mode (`!` prefix): runQuery must skip embedding + retrieval
// entirely and answer from the model alone. We prove "no retrieval happened" by
// passing an embedder that throws — if direct mode touched it, the query would
// surface an error phase instead of an answer.
describe("direct mode: runQuery skips retrieval", () => {
  let tempDir: string;
  let db: MnemosDb;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mnemos-direct-"));
    db = openDb({ path: join(tempDir, "test.db") });
  });
  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const chat = {
    id: "ollama",
    displayName: "Ollama",
    chat: async function* () {
      yield { delta: "You're on llama3.2:3b via Ollama." };
    },
  } as unknown as ChatProvider;

  it("answers with a NULL embedder; emits empty retrieved set + done with direct:true, no citations", async () => {
    createSession(db, "s1", "test");

    // Pass `null` for the embedder — the strongest proof direct mode never needs
    // it (matches the entrypoints, which skip embedder init for `!` queries).
    const phases: string[] = [];
    let retrievedHits: unknown[] | undefined;
    let done:
      | { direct?: boolean; citationChunkIds?: number[]; provider?: string; model?: string | null }
      | undefined;
    for await (const ev of runQuery(db, null, chat, {
      query: "which model am I using?",
      sessionId: "s1",
      model: "llama3.2:3b",
      direct: true,
    })) {
      phases.push(ev.phase);
      if (ev.phase === "retrieved") retrievedHits = ev.hits;
      if (ev.phase === "done") done = ev;
    }

    // No "embed" phase and no "error" → retrieval was skipped, embedder untouched.
    expect(phases).not.toContain("embed");
    expect(phases).not.toContain("error");
    expect(retrievedHits).toEqual([]);
    expect(done?.direct).toBe(true);
    expect(done?.citationChunkIds).toEqual([]);
    expect(done?.provider).toBe("ollama");
    expect(done?.model).toBe("llama3.2:3b");

    // Both rows of the turn persist `direct` so the label survives a reload and
    // the column describes the whole turn (not just the assistant row).
    const stored = getRecentMessages(db, "s1", 10);
    expect(stored).toHaveLength(2);
    expect(stored.every((m) => m.direct === true)).toBe(true);
  });

  it("a RAG query with no embedder fails cleanly (guard), instead of crashing", async () => {
    createSession(db, "s2", "test");
    const phases: string[] = [];
    let errored = false;
    for await (const ev of runQuery(db, null, chat, {
      query: "summarize my notes",
      sessionId: "s2",
      // no `direct` → RAG path, which requires an embedder
    })) {
      phases.push(ev.phase);
      if (ev.phase === "error") errored = true;
    }
    expect(errored).toBe(true);
    expect(phases).not.toContain("done");
  });
});
