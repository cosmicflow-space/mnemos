/**
 * Plugin registry.
 *
 * v0.1 uses static imports of bundled plugins. v0.2 adds dynamic discovery of
 * `mnemos-plugin-*` npm packages.
 *
 * Validation enforces the SDK contract: manifest.apiVersion === '0.1', no
 * duplicate provider IDs, no missing required fields.
 */

import type {
  Plugin,
  ChatProvider,
  EmbeddingProvider,
  DocumentLoader,
} from "@mnemos/plugin-sdk";

// Static imports of bundled plugins. Adding a new bundled plugin = add an import here.
import anthropicPlugin from "@mnemos/plugin-anthropic";
import openaiPlugin from "@mnemos/plugin-openai";
import geminiPlugin from "@mnemos/plugin-gemini";
import ollamaPlugin from "@mnemos/plugin-ollama";
import llamaCppPlugin from "@mnemos/plugin-llama-cpp";
import loaderPdfPlugin from "@mnemos/plugin-loader-pdf";
import loaderMarkdownPlugin from "@mnemos/plugin-loader-markdown";
import loaderPlaintextPlugin from "@mnemos/plugin-loader-plaintext";
import loaderWebPlugin from "@mnemos/plugin-loader-web";
import loaderCodePlugin from "@mnemos/plugin-loader-code";

const BUNDLED_PLUGINS: readonly Plugin[] = [
  anthropicPlugin,
  openaiPlugin,
  geminiPlugin,
  ollamaPlugin,
  llamaCppPlugin,
  loaderPdfPlugin,
  loaderMarkdownPlugin,
  loaderPlaintextPlugin,
  loaderWebPlugin,
  loaderCodePlugin,
];

export type PluginRegistry = {
  readonly plugins: readonly Plugin[];
  readonly chatProviders: ReadonlyMap<string, ChatProvider>;
  readonly embeddingProviders: ReadonlyMap<string, EmbeddingProvider>;
  readonly documentLoaders: ReadonlyMap<string, DocumentLoader>;
  readonly loadersByExtension: ReadonlyMap<string, DocumentLoader>;
};

export class PluginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginValidationError";
  }
}

function validateManifest(plugin: Plugin): void {
  const { manifest } = plugin;
  if (!manifest) {
    throw new PluginValidationError(`Plugin missing manifest`);
  }
  if (manifest.apiVersion !== "0.1") {
    throw new PluginValidationError(
      `Plugin ${manifest.id} has apiVersion=${manifest.apiVersion}, expected 0.1`,
    );
  }
  if (!manifest.id || !manifest.displayName || !manifest.version) {
    throw new PluginValidationError(
      `Plugin manifest missing required fields: ${JSON.stringify(manifest)}`,
    );
  }
}

export function loadBundledPlugins(): PluginRegistry {
  const chatProviders = new Map<string, ChatProvider>();
  const embeddingProviders = new Map<string, EmbeddingProvider>();
  const documentLoaders = new Map<string, DocumentLoader>();
  const loadersByExtension = new Map<string, DocumentLoader>();

  for (const plugin of BUNDLED_PLUGINS) {
    validateManifest(plugin);

    for (const provider of plugin.chatProviders ?? []) {
      if (chatProviders.has(provider.id)) {
        throw new PluginValidationError(
          `Duplicate chat provider id: ${provider.id} (plugin ${plugin.manifest.id})`,
        );
      }
      chatProviders.set(provider.id, provider);
    }

    for (const provider of plugin.embeddingProviders ?? []) {
      if (embeddingProviders.has(provider.id)) {
        throw new PluginValidationError(
          `Duplicate embedding provider id: ${provider.id} (plugin ${plugin.manifest.id})`,
        );
      }
      embeddingProviders.set(provider.id, provider);
    }

    for (const loader of plugin.documentLoaders ?? []) {
      if (documentLoaders.has(loader.id)) {
        throw new PluginValidationError(
          `Duplicate document loader id: ${loader.id} (plugin ${plugin.manifest.id})`,
        );
      }
      documentLoaders.set(loader.id, loader);
      for (const ext of loader.extensions) {
        const normalized = ext.toLowerCase();
        if (loadersByExtension.has(normalized)) {
          throw new PluginValidationError(
            `Duplicate loader for extension ${normalized}`,
          );
        }
        loadersByExtension.set(normalized, loader);
      }
    }
  }

  return {
    plugins: BUNDLED_PLUGINS,
    chatProviders,
    embeddingProviders,
    documentLoaders,
    loadersByExtension,
  };
}

// ---- Convenience lookups ----

export function getChatProvider(
  registry: PluginRegistry,
  id: string,
): ChatProvider {
  const provider = registry.chatProviders.get(id);
  if (!provider) {
    throw new Error(
      `Chat provider not found: ${id}. Available: ${[...registry.chatProviders.keys()].join(", ")}`,
    );
  }
  return provider;
}

export function getEmbeddingProvider(
  registry: PluginRegistry,
  id: string,
): EmbeddingProvider {
  const provider = registry.embeddingProviders.get(id);
  if (!provider) {
    throw new Error(
      `Embedding provider not found: ${id}. Available: ${[...registry.embeddingProviders.keys()].join(", ")}`,
    );
  }
  return provider;
}

export function getDocumentLoader(
  registry: PluginRegistry,
  idOrExtension: string,
): DocumentLoader {
  const normalized = idOrExtension.toLowerCase();
  const byExt = registry.loadersByExtension.get(normalized);
  if (byExt) return byExt;
  const byId = registry.documentLoaders.get(idOrExtension);
  if (byId) return byId;
  throw new Error(
    `No document loader for ${idOrExtension}. Available extensions: ${[
      ...registry.loadersByExtension.keys(),
    ].join(", ")}`,
  );
}
