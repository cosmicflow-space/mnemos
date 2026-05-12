/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    // Allow workspace package imports without bundling errors
    externalDir: true,
  },
  // sqlite-vec + better-sqlite3 are native modules; keep them external on the server
  serverExternalPackages: ["better-sqlite3", "sqlite-vec"],
};

export default nextConfig;
