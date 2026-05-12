# Mnemos — multi-stage build
# Single container holding the Next.js app + native deps (better-sqlite3, sqlite-vec)

# ---- Stage 1: dependencies ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/cli/package.json packages/cli/
COPY plugins/anthropic/package.json plugins/anthropic/
COPY plugins/openai/package.json plugins/openai/
COPY plugins/gemini/package.json plugins/gemini/
COPY plugins/ollama/package.json plugins/ollama/
COPY plugins/llama-cpp/package.json plugins/llama-cpp/
COPY plugins/loader-pdf/package.json plugins/loader-pdf/
COPY plugins/loader-markdown/package.json plugins/loader-markdown/
COPY plugins/loader-plaintext/package.json plugins/loader-plaintext/
COPY plugins/loader-web/package.json plugins/loader-web/
COPY plugins/loader-code/package.json plugins/loader-code/

RUN pnpm install --frozen-lockfile

# ---- Stage 2: build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm build

# ---- Stage 3: runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 node-app \
    && useradd -u 1001 -g node-app -m -s /bin/bash node-app

ENV NODE_ENV=production
ENV MNEMOS_BIND=0.0.0.0
ENV MNEMOS_PORT=3030

COPY --from=build --chown=node-app:node-app /app/apps/web/.next/standalone ./
COPY --from=build --chown=node-app:node-app /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node-app:node-app /app/apps/web/public ./apps/web/public

USER node-app

EXPOSE 3030

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
