/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // The embedding worker is loaded by worker_threads via a path string, not an
  // import, so Next's tracer may not copy it into the standalone build. Force it
  // in so a production build can run ingestion. (dev resolves it from cwd.)
  outputFileTracingIncludes: {
    "/**/*": ["./lib/embed-worker.mjs"],
  },
  // Workspace packages live as TS source and import each other relatively
  // (no build step in dev). transpilePackages tells Next to run them through
  // its bundler instead of trying to import compiled dist/ output.
  transpilePackages: [
    "@mnemos/core",
    "@mnemos/db",
    "@mnemos/plugin-sdk",
    "@mnemos/plugin-anthropic",
    "@mnemos/plugin-openai",
    "@mnemos/plugin-gemini",
    "@mnemos/plugin-ollama",
    "@mnemos/plugin-llama-cpp",
    "@mnemos/plugin-embed-local",
    "@mnemos/plugin-loader-pdf",
    "@mnemos/plugin-loader-docx",
    "@mnemos/plugin-loader-xlsx",
    "@mnemos/plugin-loader-ocr",
    "@mnemos/plugin-loader-markdown",
    "@mnemos/plugin-loader-plaintext",
    "@mnemos/plugin-loader-web",
    "@mnemos/plugin-loader-code",
  ],
  experimental: {
    externalDir: true,
  },
  // Server-external packages: declarative API that covers the standard server
  // bundle. Kept in sync with the webpack-callback list below — both layers
  // are needed because the declarative list doesn't apply to the RSC
  // compilation in Next 15.
  //
  // Every entry must ALSO be resolvable from this app directory, or the bundler
  // cannot externalize it and bundles it instead. Under pnpm that means listing
  // it in this app's package.json even when the import arrives through a
  // workspace package (better-sqlite3 / sqlite-vec come via @mnemos/db).
  // Turbopack (`next dev --turbopack`, and the default in newer Next) ignores
  // the webpack callback below, so the declaration is the only layer left.
  serverExternalPackages: [
    "better-sqlite3",
    "sqlite-vec",
    "node-llama-cpp",
    "@xenova/transformers",
    "onnxruntime-node",
    "pdf-parse",
    "mammoth",
    "exceljs",
    "tesseract.js",
    "sharp",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Native-addon packages locate their .node binary relative to their own
      // install directory (better-sqlite3 13: `../prebuilds/<platform>.node`
      // from its __dirname). Bundled, __dirname points into .next/ where no
      // binary exists, so the first DB open fails. Externalizing sends the
      // require through Node's loader, which keeps the real package path.
      const nativeExternals = [
        "better-sqlite3",
        "sqlite-vec",
        "node-llama-cpp",
        "onnxruntime-node",
        "sharp",
        "@xenova/transformers",
        "pdf-parse",
        "mammoth",
        "exceljs",
        "tesseract.js",
      ];
      const existing = Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean);
      config.externals = [
        ...existing,
        ({ request }, callback) => {
          if (request && nativeExternals.includes(request)) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
