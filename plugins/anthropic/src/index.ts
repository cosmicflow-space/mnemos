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

class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic";
  readonly displayName = "Anthropic Claude";
  readonly credentialSchema = credentialSchema;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async initialize(_credentials: Record<string, string>): Promise<void> {
    // v0.1 stub: wire Anthropic SDK client in next pass
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *chat(_messages: ChatMessage[], _opts?: ChatOptions): AsyncIterable<ChatChunk> {
    yield { delta: "[anthropic plugin stub — implementation in next pass]" };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", contextWindow: 200000 },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextWindow: 200000 },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", contextWindow: 200000 },
    ];
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
