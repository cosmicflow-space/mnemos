import { GoogleGenAI } from "@google/genai";
import type {
  Plugin,
  ChatProvider,
  ChatMessage,
  ChatOptions,
  ChatChunk,
  ModelInfo,
  CredentialSchema,
} from "@mnemos/plugin-sdk";

/**
 * Gemini ChatProvider — AI Studio API key via the official @google/genai SDK.
 *
 * Deliberately NOT the Gemini CLI OAuth login: that credential only works
 * against the private Code Assist endpoint, third-party reuse of it violates
 * Google's ToS, and the OAuth tier is being retired. The API key is the
 * sanctioned programmatic path.
 */
const credentialSchema: CredentialSchema = {
  type: "geminiApi",
  displayName: "Google Gemini API",
  fields: [
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      description: "Get one at https://aistudio.google.com/apikey",
    },
  ],
};

// USD per 1M tokens — indicative for the UI's cost display, same caveat as the
// other frontier plugins: billing is whatever Google actually charges.
const PRICED_AS_OF = "2026-06-16";

const CHAT_MODELS: readonly ModelInfo[] = [
  { id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash-Lite", contextWindow: 1000000, inputCostPer1M: 0.1, outputCostPer1M: 0.4 },
  { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", contextWindow: 1000000, inputCostPer1M: 0.3, outputCostPer1M: 2.5 },
  { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", contextWindow: 1000000, inputCostPer1M: 1.25, outputCostPer1M: 10.0 },
  { id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash (preview)", contextWindow: 1000000, inputCostPer1M: 0.5, outputCostPer1M: 3.0 },
  { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro (preview)", contextWindow: 1000000, inputCostPer1M: 2.0, outputCostPer1M: 12.0 },
];

// Cheapest capable model is the default — see the Anthropic plugin's rationale.
const DEFAULT_CHAT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_MAX_TOKENS = 2048;

class GeminiChatProvider implements ChatProvider {
  readonly id = "gemini";
  readonly displayName = "Google Gemini";
  readonly credentialSchema = credentialSchema;

  private client: GoogleGenAI | null = null;

  async initialize(credentials: Record<string, string>): Promise<void> {
    const apiKey = credentials.apiKey;
    if (!apiKey) {
      throw new Error("Gemini provider requires 'apiKey' in credentials");
    }
    this.client = new GoogleGenAI({ apiKey });
  }

  async *chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    if (!this.client) {
      throw new Error("Gemini provider not initialized. Call initialize() first.");
    }

    // Gemini separates the system prompt from the turn list and names the
    // assistant role "model". Multiple system messages collapse into one block.
    const systemInstruction = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: m.content }],
      }));

    const stream = await this.client.models.generateContentStream({
      model: opts?.model ?? DEFAULT_CHAT_MODEL,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        maxOutputTokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts?.signal ? { abortSignal: opts.signal } : {}),
      },
    });

    // usageMetadata arrives on (at least) the final chunk; remember the last
    // seen values and emit them once the stream ends.
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    for await (const chunk of stream) {
      if (opts?.signal?.aborted) return;
      if (chunk.usageMetadata) {
        tokensIn = chunk.usageMetadata.promptTokenCount ?? tokensIn;
        tokensOut = chunk.usageMetadata.candidatesTokenCount ?? tokensOut;
      }
      const delta = chunk.text;
      if (delta) yield { delta };
    }
    yield {
      delta: "",
      finishReason: "stop",
      usage: { inputTokens: tokensIn, outputTokens: tokensOut },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return CHAT_MODELS.map((m) =>
      m.inputCostPer1M != null ? { ...m, pricedAsOf: PRICED_AS_OF } : { ...m },
    );
  }
}

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-gemini",
    displayName: "Google Gemini",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  chatProviders: [new GeminiChatProvider()],
};

export default plugin;
