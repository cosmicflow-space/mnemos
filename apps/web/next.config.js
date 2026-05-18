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
    "@mnemos/plugin-loader-markdown",
    "@mnemos/plugin-loader-plaintext",
    "@mnemos/plugin-loader-web",
    "@mnemos/plugin-loader-code",
  ],
  experimental: {
    externalDir: true,
  },
  // Server-external packages: keep these from being bundled by webpack on the
  // server. Necessary for (a) native modules (better-sqlite3, sqlite-vec,
  // onnxruntime via @xenova/transformers) and (b) packages with binary test
  // fixtures that break webpack tracing (pdf-parse ships a test PDF).
  serverExternalPackages: [
    "better-sqlite3",
    "sqlite-vec",
    "@xenova/transformers",
    "onnxruntime-node",
    "pdf-parse",
    "sharp",
  ],
};

export default nextConfig;
