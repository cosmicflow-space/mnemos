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
  listSources,
  getSourceByPath,
  removeSource,
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
} from "./index";

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
  it("loads all 11 bundled plugins without validation errors", () => {
    const registry = loadBundledPlugins();
    expect(registry.plugins.length).toBe(11);
  });

  it("registers chat providers (anthropic, openai, ollama)", () => {
    const registry = loadBundledPlugins();
    // anthropic + openai + ollama are real; gemini + llama-cpp are stubs without chatProviders
    expect(registry.chatProviders.size).toBeGreaterThanOrEqual(3);
    expect(registry.chatProviders.has("anthropic")).toBe(true);
    expect(registry.chatProviders.has("openai")).toBe(true);
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
    // v0.1 stubs don't register loaders; this test confirms the lookup function
    // doesn't crash when there are no loaders, and throws helpfully.
    expect(() => getDocumentLoader(registry, ".pdf")).toThrow(/No document loader/);
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
