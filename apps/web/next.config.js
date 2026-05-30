/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
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
  serverExternalPackages: [
    "better-sqlite3",
    "sqlite-vec",
    "bindings",
    "node-llama-cpp",
    "@xenova/transformers",
    "onnxruntime-node",
    "pdf-parse",
    "mammoth",
    "exceljs",
    "sharp",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // The `bindings` package walks Error.stack to locate the calling
      // module's .node addon (bindings.js line 178: `fileName.indexOf(...)`).
      // If webpack bundles bindings OR its callers, the stack frames become
      // `webpack-internal:///...` and fileName ends up undefined — the
      // famous "Cannot read properties of undefined (reading 'indexOf')"
      // failure on first DB open. Externalizing both bindings AND every
      // native-addon package that loads it sends the require through Node's
      // native loader, where Error.stack is intact.
      const nativeExternals = [
        "better-sqlite3",
        "sqlite-vec",
        "bindings",
        "node-llama-cpp",
        "onnxruntime-node",
        "sharp",
        "@xenova/transformers",
        "pdf-parse",
        "mammoth",
        "exceljs",
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
