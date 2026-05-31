import { readFile } from "node:fs/promises";
import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

/**
 * Strip leading YAML frontmatter and return the body plus parsed frontmatter
 * as metadata. Frontmatter parsing is intentionally simple — key: value lines
 * only, no nested structures. For richer parsing, a future version could add a
 * real frontmatter parser.
 */
function splitFrontmatter(text: string): {
  body: string;
  frontmatter: Record<string, string>;
} {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { body: text, frontmatter: {} };
  }
  const endMatch = text.slice(4).match(/\n---\s*(\r?\n|$)/);
  if (!endMatch || endMatch.index === undefined) {
    return { body: text, frontmatter: {} };
  }
  const fmEnd = 4 + endMatch.index;
  const fmText = text.slice(4, fmEnd);
  const body = text.slice(fmEnd + endMatch[0].length);
  const frontmatter: Record<string, string> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key) frontmatter[key] = value;
  }
  return { body, frontmatter };
}

const loader: DocumentLoader = {
  id: "markdown",
  extensions: [".md", ".mdx", ".markdown"],
  async load(filePath: string): Promise<LoadedDoc> {
    const raw = await readFile(filePath, "utf8");
    const { body, frontmatter } = splitFrontmatter(raw);
    return {
      text: body,
      metadata: {
        loader: "markdown",
        frontmatter,
      },
    };
  },
};

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-loader-markdown",
    displayName: "Markdown Loader",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  documentLoaders: [loader],
};

export default plugin;
