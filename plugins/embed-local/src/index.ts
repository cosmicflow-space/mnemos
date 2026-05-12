import type {
  Plugin,
  EmbeddingProvider,
  CredentialSchema,
} from "@mnemos/plugin-sdk";

/**
 * Bundled local embedding provider.
 *
 * Runs entirely in-process using @xenova/transformers (ONNX runtime).
 * Default model: BAAI/bge-small-en-v1.5 — 384 dim, ~130MB weights, downloaded
 * on first use and cached at `~/.cache/huggingface/transformers` (or the dir
 * specified by MNEMOS_TRANSFORMERS_CACHE).
 *
 * No external services required. This is the default embedding provider for
 * Mnemos v0.1 — the "drop a folder, ask a question" wow moment works with
 * zero configuration beyond the optional chat-LLM credentials.
 */

const credentialSchema: CredentialSchema = {
  type: "embedLocal",
  displayName: "Local Embeddings (bundled)",
  fields: [
    {
      key: "model",
      label: "Model",
      type: "string",
      required: false,
      description:
        "Hugging Face model id. Default Xenova/bge-small-en-v1.5 (384d). Alternatives: Xenova/bge-base-en-v1.5 (768d, schema-incompatible in v0.1).",
    },
    {
      key: "cacheDir",
      label: "Cache directory",
      type: "string",
      required: false,
      description: "Override for model weight cache. Default uses Hugging Face cache.",
    },
  ],
};

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";
const MNEMOS_EMBEDDING_DIM = 384;

// Lazy pipeline — created on first embed() call, not at module-load time.
type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

class EmbedLocalProvider implements EmbeddingProvider {
  readonly id = "embed-local";
  readonly displayName = "Local (BGE-small, bundled)";
  readonly dimensions = MNEMOS_EMBEDDING_DIM;
  readonly credentialSchema = credentialSchema;

  private model = DEFAULT_MODEL;
  private extractor: FeatureExtractor | null = null;
  private extractorPromise: Promise<FeatureExtractor> | null = null;

  async initialize(credentials: Record<string, string>): Promise<void> {
    if (credentials.model) this.model = credentials.model;
    if (credentials.cacheDir) {
      process.env.HF_HOME = credentials.cacheDir;
      process.env.TRANSFORMERS_CACHE = credentials.cacheDir;
    } else if (process.env.MNEMOS_TRANSFORMERS_CACHE) {
      process.env.HF_HOME = process.env.MNEMOS_TRANSFORMERS_CACHE;
      process.env.TRANSFORMERS_CACHE = process.env.MNEMOS_TRANSFORMERS_CACHE;
    }
    // Pipeline construction is deferred to first embed() call so we don't
    // download model weights until they're actually needed.
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        // Dynamic import keeps @xenova/transformers from being eagerly loaded
        // (it pulls in onnxruntime-node which is heavy).
        const { pipeline } = await import("@xenova/transformers");
        const ex = (await pipeline(
          "feature-extraction",
          this.model,
        )) as unknown as FeatureExtractor;
        this.extractor = ex;
        return ex;
      })();
    }
    return this.extractorPromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }
}

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-embed-local",
    displayName: "Local Embeddings (bundled)",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  embeddingProviders: [new EmbedLocalProvider()],
};

export default plugin;
