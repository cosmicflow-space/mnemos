import OpenAI from "openai";
import type {
  Plugin,
  ChatProvider,
  EmbeddingProvider,
  ChatMessage,
  ChatOptions,
  ChatChunk,
  ModelInfo,
  CredentialSchema,
} from "@mnemos/plugin-sdk";

const credentialSchema: CredentialSchema = {
  type: "openAIApi",
  displayName: "OpenAI API",
  fields: [
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      description: "Get one at https://platform.openai.com/api-keys",
    },
    {
      key: "baseURL",
      label: "Base URL (optional)",
      type: "url",
      required: false,
      description:
        "For OpenAI-compatible endpoints. Leave blank for api.openai.com.",
    },
  ],
};

// Costs are USD per 1M tokens (input/output), point-in-time estimates for the
// UI's cost display — verify against platform.openai.com/pricing. Used only for
// indicative cost; billing is whatever OpenAI actually charges.
// When the prices below were last set — surfaced in the UI so a stale rate shows.
const PRICED_AS_OF = "2026-05-30";

const CHAT_MODELS: readonly ModelInfo[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 200000, inputCostPer1M: 1.25, outputCostPer1M: 10.0 },
  { id: "gpt-5.4", displayName: "GPT-5.4", contextWindow: 200000, inputCostPer1M: 1.25, outputCostPer1M: 10.0 },
  { id: "gpt-4o", displayName: "GPT-4o", contextWindow: 128000, inputCostPer1M: 2.5, outputCostPer1M: 10.0 },
  { id: "gpt-4o-mini", displayName: "GPT-4o mini", contextWindow: 128000, inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
];

// Cheapest capable model is the default — see the Anthropic plugin's rationale.
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 2048;

class OpenAIChatProvider implements ChatProvider {
  readonly id = "openai";
  readonly displayName = "OpenAI";
  readonly credentialSchema = credentialSchema;

  private client: OpenAI | null = null;

  async initialize(credentials: Record<string, string>): Promise<void> {
    const apiKey = credentials.apiKey;
    if (!apiKey) {
      throw new Error("OpenAI provider requires 'apiKey' in credentials");
    }
    this.client = new OpenAI({
      apiKey,
      ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
    });
  }

  async *chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    if (!this.client) {
      throw new Error("OpenAI provider not initialized. Call initialize() first.");
    }

    const stream = await this.client.chat.completions.create({
      model: opts?.model ?? DEFAULT_CHAT_MODEL,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts?.temperature,
      stream: true,
      // Opt in to a trailing usage chunk (empty choices, populated `usage`).
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      if (opts?.signal?.aborted) {
        stream.controller.abort();
        return;
      }
      // The include_usage trailer arrives as a chunk with empty `choices` and a
      // populated `usage` — handle it before the choice guard below.
      if (chunk.usage) {
        yield {
          delta: "",
          usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          },
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (delta) yield { delta };
      if (choice.finish_reason) {
        yield {
          delta: "",
          finishReason:
            choice.finish_reason === "stop"
              ? "stop"
              : choice.finish_reason === "length"
                ? "length"
                : "error",
        };
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return CHAT_MODELS.map((m) => ({ ...m, pricedAsOf: PRICED_AS_OF }));
  }
}

// OpenAI text-embedding-3-* models support Matryoshka dimension truncation
// via the `dimensions` parameter. We standardize on 384 across all Mnemos
// bundled embedding providers so the SQLite schema stays uniform.
const EMBEDDING_MODELS = new Set([
  "text-embedding-3-small",
  "text-embedding-3-large",
]);

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const MNEMOS_EMBEDDING_DIM = 384;

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly displayName = "OpenAI Embeddings";
  readonly dimensions = MNEMOS_EMBEDDING_DIM;
  readonly credentialSchema = credentialSchema;

  private client: OpenAI | null = null;
  private model = DEFAULT_EMBEDDING_MODEL;

  async initialize(credentials: Record<string, string>): Promise<void> {
    const apiKey = credentials.apiKey;
    if (!apiKey) {
      throw new Error(
        "OpenAI embedding provider requires 'apiKey' in credentials",
      );
    }
    this.client = new OpenAI({
      apiKey,
      ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
    });
    const requested = credentials.embeddingModel;
    if (requested && EMBEDDING_MODELS.has(requested)) {
      this.model = requested;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error(
        "OpenAI embedding provider not initialized. Call initialize() first.",
      );
    }
    if (texts.length === 0) return [];
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: MNEMOS_EMBEDDING_DIM,
    });
    return response.data.map((d) => d.embedding);
  }
}

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-openai",
    displayName: "OpenAI",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  chatProviders: [new OpenAIChatProvider()],
  embeddingProviders: [new OpenAIEmbeddingProvider()],
};

export default plugin;
