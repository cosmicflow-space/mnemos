import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

/**
 * Source-code loader. Treats code as text — the chunker handles structure.
 * Language detection is best-effort by extension; the language tag is exposed
 * as metadata so the chat-side prompt can hint the model.
 */

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".rb": "ruby",
  ".sh": "shell",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

const loader: DocumentLoader = {
  id: "code",
  extensions: Object.keys(LANG_BY_EXT),
  async load(filePath: string): Promise<LoadedDoc> {
    const text = await readFile(filePath, "utf8");
    const ext = extname(filePath).toLowerCase();
    return {
      text,
      metadata: {
        loader: "code",
        extension: ext,
        language: LANG_BY_EXT[ext] ?? "text",
        lineCount: text.split("\n").length,
      },
    };
  },
};

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-loader-code",
    displayName: "Source Code Loader",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  documentLoaders: [loader],
};

export default plugin;
