/**
 * @mnemos/plugin-sdk
 *
 * The ONLY surface plugins are allowed to import from.
 * Plugins must declare apiVersion: '0.1' in their manifest.
 *
 * Backward-compatible additions are welcome; breaking changes bump apiVersion.
 */

export type PluginApiVersion = "0.1";

export type PluginManifest = {
  id: string;
  displayName: string;
  version: string;
  apiVersion: PluginApiVersion;
  author?: string;
  homepage?: string;
};

// ----- Chat / LLM provider -----

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type ChatChunk = {
  delta: string;
  finishReason?: "stop" | "length" | "tool_use" | "error";
};

export type ModelInfo = {
  id: string;
  displayName: string;
  contextWindow: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
};

export type CredentialField = {
  key: string;
  label: string;
  type: "string" | "password" | "url";
  required: boolean;
  description?: string;
};

export type CredentialSchema = {
  type: string; // canonical, e.g., 'anthropicApi'
  displayName: string;
  fields: CredentialField[];
};

export interface ChatProvider {
  readonly id: string;
  readonly displayName: string;
  readonly credentialSchema: CredentialSchema;
  initialize(credentials: Record<string, string>): Promise<void>;
  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk>;
  listModels(): Promise<ModelInfo[]>;
}

// ----- Embedding provider -----

export interface EmbeddingProvider {
  readonly id: string;
  readonly displayName: string;
  readonly dimensions: number;
  readonly credentialSchema: CredentialSchema;
  initialize(credentials: Record<string, string>): Promise<void>;
  embed(texts: string[]): Promise<number[][]>;
}

// ----- Document loader -----

export type LoadedDoc = {
  text: string;
  metadata: Record<string, unknown>;
};

export interface DocumentLoader {
  readonly id: string;
  readonly extensions: readonly string[];
  load(filePath: string): Promise<LoadedDoc>;
}

// ----- Plugin shape -----

export type Plugin = {
  manifest: PluginManifest;
  chatProviders?: readonly ChatProvider[];
  embeddingProviders?: readonly EmbeddingProvider[];
  documentLoaders?: readonly DocumentLoader[];
};
