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
  type: "ollama",
  displayName: "Ollama (local)",
  fields: [
    {
      key: "baseURL",
      label: "Base URL",
      type: "url",
      required: false,
      description: "Default http://localhost:11434. Use http://host.docker.internal:11434 inside Docker.",
    },
  ],
};

const DEFAULT_BASE_URL = "http://localhost:11434";
// Ordered preference list — tried in order against the actually-installed models
// when the caller doesn't specify a model. Small fast first, larger fallback.
const PREFERRED_CHAT_MODELS = [
  "llama3.2:3b",
  "llama3.2",
  "qwen2.5:7b",
  "qwen2.5-coder:7b",
  "llama3.1:8b",
  "qwen2.5-coder:14b",
];
const HARD_FALLBACK_CHAT_MODEL = "llama3.2";
// Default to all-minilm (384 dim native) so it matches Mnemos's standard schema.
// Users can override via credentials.embeddingModel; if they pick a model with
// non-384 native dim, the schema still expects 384 so they'll need to handle
// truncation themselves until multi-dim support lands.
const DEFAULT_EMBED_MODEL = "all-minilm";
const MNEMOS_EMBEDDING_DIM = 384;

type OllamaChatStreamLine = {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
  /** Token counts on the final (done) line — prompt vs generated. */
  prompt_eval_count?: number;
  eval_count?: number;
};

type OllamaEmbedResponse = {
  embedding?: number[];
  embeddings?: number[][];
};

type OllamaTagsResponse = {
  models: Array<{ name: string; size: number }>;
};

async function* iterateNdjson(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error("Ollama response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      yield JSON.parse(line);
    }
  }
  if (buffer.trim().length > 0) yield JSON.parse(buffer);
}

class OllamaChatProvider implements ChatProvider {
  readonly id = "ollama";
  readonly displayName = "Ollama (local)";
  readonly credentialSchema = credentialSchema;

  private baseURL = DEFAULT_BASE_URL;
  private configuredModel: string | null = null;

  async initialize(credentials: Record<string, string>): Promise<void> {
    if (credentials.baseURL) this.baseURL = credentials.baseURL;
    // Caller may pin a model via env (MNEMOS_OLLAMA_MODEL). Empty string = unset.
    if (credentials.model && credentials.model.trim()) {
      this.configuredModel = credentials.model.trim();
    }
  }

  /** Resolve which model to actually use given opts, configured, and installed list. */
  private async resolveModel(requested?: string): Promise<string> {
    if (requested) return requested;
    if (this.configuredModel) return this.configuredModel;
    // Fall back to whatever is actually installed. Avoids the "llama3.2 not
    // found because you only have llama3.2:3b" footgun.
    try {
      const installed = await this.listModels();
      const names = new Set(installed.map((m) => m.id));
      for (const pref of PREFERRED_CHAT_MODELS) {
        if (names.has(pref)) return pref;
      }
      if (installed[0]) return installed[0].id;
    } catch {
      // Ollama unreachable — fall through to hard default; the chat call will
      // throw a clearer error than we can construct here.
    }
    return HARD_FALLBACK_CHAT_MODEL;
  }

  async *chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    const model = await this.resolveModel(opts?.model);
    const response = await fetch(`${this.baseURL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        options: {
          ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts?.maxTokens !== undefined ? { num_predict: opts.maxTokens } : {}),
        },
      }),
      signal: opts?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      // Helpful error for the most common 404 — model not pulled.
      if (response.status === 404) {
        const installed = await this.listModels().catch(() => []);
        const names = installed.map((m) => m.id).join(", ") || "(none — Ollama has no models pulled)";
        throw new Error(
          `Ollama model "${model}" not installed. Pull it with: ollama pull ${model}\nAvailable: ${names}`,
        );
      }
      throw new Error(`Ollama chat failed (${response.status}): ${text}`);
    }

    for await (const event of iterateNdjson(response)) {
      const line = event as OllamaChatStreamLine;
      const delta = line.message?.content;
      if (delta) yield { delta };
      if (line.done) {
        yield {
          delta: "",
          finishReason:
            line.done_reason === "stop" || line.done_reason === undefined
              ? "stop"
              : "length",
          usage: {
            inputTokens: line.prompt_eval_count,
            outputTokens: line.eval_count,
          },
        };
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseURL}/api/tags`);
      if (!response.ok) return [];
      const data = (await response.json()) as OllamaTagsResponse;
      return data.models.map((m) => ({
        id: m.name,
        displayName: m.name,
        contextWindow: 8192, // Ollama doesn't expose this; conservative default
      }));
    } catch {
      // Ollama not running — return empty list rather than throwing
      return [];
    }
  }
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = "ollama";
  readonly displayName = "Ollama Embeddings (local)";
  readonly dimensions = MNEMOS_EMBEDDING_DIM;
  readonly credentialSchema = credentialSchema;

  private baseURL = DEFAULT_BASE_URL;
  private model = DEFAULT_EMBED_MODEL;

  async initialize(credentials: Record<string, string>): Promise<void> {
    if (credentials.baseURL) this.baseURL = credentials.baseURL;
    if (credentials.embeddingModel) this.model = credentials.embeddingModel;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Use /api/embed (batch) when available, falling back to /api/embeddings (singular)
    const response = await fetch(`${this.baseURL}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (response.ok) {
      const data = (await response.json()) as OllamaEmbedResponse;
      if (data.embeddings) return data.embeddings;
    }

    // Fallback for older Ollama versions: serial /api/embeddings calls
    const results: number[][] = [];
    for (const text of texts) {
      const fallback = await fetch(`${this.baseURL}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!fallback.ok) {
        const body = await fallback.text();
        throw new Error(`Ollama embed failed (${fallback.status}): ${body}`);
      }
      const data = (await fallback.json()) as OllamaEmbedResponse;
      if (!data.embedding) throw new Error("Ollama embed: missing embedding in response");
      results.push(data.embedding);
    }
    return results;
  }
}

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-ollama",
    displayName: "Ollama (local)",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  chatProviders: [new OllamaChatProvider()],
  embeddingProviders: [new OllamaEmbeddingProvider()],
};

export default plugin;
