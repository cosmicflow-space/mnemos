import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

const loader: DocumentLoader = {
  id: "plaintext",
  extensions: [".txt", ".log", ".csv", ".tsv", ".json", ".jsonl"],
  async load(filePath: string): Promise<LoadedDoc> {
    const text = await readFile(filePath, "utf8");
    return {
      text,
      metadata: {
        loader: "plaintext",
        extension: extname(filePath).toLowerCase(),
      },
    };
  },
};

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-loader-plaintext",
    displayName: "Plaintext Loader",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  documentLoaders: [loader],
};

export default plugin;
