import type { Plugin, DocumentLoader, LoadedDoc } from "@mnemos/plugin-sdk";

/**
 * Web URL loader. The `filePath` argument is treated as a URL.
 * Uses native fetch (Node 22+) + a minimal HTML-to-text extractor.
 *
 * Sources of kind 'url' (registered via `mnemos source add` with kind=url)
 * use this loader. v0.1 supports single-page fetches; multi-page crawling
 * lands in v0.2.
 */

const loader: DocumentLoader = {
  // No file extensions — this loader is selected by source.kind === 'url'
  // rather than by filename. Registry lookup falls through to id-based.
  id: "web",
  extensions: [] as readonly string[],
  async load(urlOrPath: string): Promise<LoadedDoc> {
    const url = urlOrPath.startsWith("http") ? urlOrPath : `https://${urlOrPath}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": "mnemos/0.1 (+https://github.com/sammuthu/mnemos)",
        accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
    });
    if (!response.ok) {
      throw new Error(`web loader: ${response.status} ${response.statusText} for ${url}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const html = await response.text();
    const text = contentType.includes("html") ? htmlToText(html) : html;
    return {
      text,
      metadata: {
        loader: "web",
        url,
        contentType,
        fetchedAt: Date.now(),
      },
    };
  },
};

/** Bare-bones HTML→text extractor. Drops script/style, collapses whitespace.
 * For richer extraction (article-only via readability), v0.2 can add a real
 * dependency like @mozilla/readability. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const plugin: Plugin = {
  manifest: {
    id: "mnemos-plugin-loader-web",
    displayName: "Web URL Loader",
    version: "0.1.0",
    apiVersion: "0.1",
    author: "Mnemos",
  },
  documentLoaders: [loader],
};

export default plugin;
