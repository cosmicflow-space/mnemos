import Anthropic from "@anthropic-ai/sdk";
import type {
  Plugin,
  ChatProvider,
  ChatMessage,
  ChatOptions,
  ChatChunk,
  ModelInfo,
  CredentialSchema,
} from "@mnemos/plugin-sdk";

const credentialSchema: CredentialSchema = {
  type: "anthropicApi",
  displayName: "Anthropic API",
  fields: [
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      description: "Get one at https://console.anthropic.com/settings/keys",
    },
  ],
};

// When the prices below were last set. Surfaced in the UI so a stale rate is
// obvious — providers change pricing; verify before relying on it.
const PRICED_AS_OF = "2026-05-30";

const KNOWN_MODELS: readonly ModelInfo[] = [
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    contextWindow: 200000,
    inputCostPer1M: 15.0,
    outputCostPer1M: 75.0,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    contextWindow: 200000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200000,
    inputCostPer1M: 0.8,
    outputCostPer1M: 4.0,
  },
];

// Cheapest capable model is the default — Mnemos queries are RAG over the
// user's own docs, which Haiku handles well at a fraction of Sonnet/Opus cost.
// The UI's model dropdown lets users pick a stronger model per query.
const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 2048;

class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic";
  readonly displayName = "Anthropic Claude";
  readonly credentialSchema = credentialSchema;

  private client: Anthropic | null = null;

  async initialize(credentials: Record<string, string>): Promise<void> {
    const apiKey = credentials.apiKey;
    if (!apiKey) {
      throw new Error("Anthropic provider requires 'apiKey' in credentials");
    }
    this.client = new Anthropic({ apiKey });
  }

  async *chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    if (!this.client) {
      throw new Error("Anthropic provider not initialized. Call initialize() first.");
    }

    // Anthropic API takes system as a separate field, not as a message role.
    const systemMessages = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages.filter((m) => m.role !== "system");

    const stream = this.client.messages.stream({
      model: opts?.model ?? DEFAULT_MODEL,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts?.temperature,
      ...(systemMessages ? { system: systemMessages } : {}),
      messages: turns.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    try {
      for await (const event of stream) {
        if (opts?.signal?.aborted) {
          stream.controller.abort();
          throw new Error("Aborted");
        }
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { delta: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      yield {
        delta: "",
        finishReason: final.stop_reason === "end_turn" ? "stop" : "length",
        usage: {
          inputTokens: final.usage?.input_tokens,
          outputTokens: final.usage?.output_tokens,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.message === "Aborted") {
        yield { delta: "", finishReason: "error" };
        return;
      }
      throw err;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return KNOWN_MODELS.map((m) => ({ ...m, pricedAsOf: PRICED_AS_OF }));
  }
}

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-anthropic",
    displayName: "Anthropic Claude",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  chatProviders: [new AnthropicProvider()],
};

export default plugin;
