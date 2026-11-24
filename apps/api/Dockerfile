# syntax=docker/dockerfile:1.20

FROM oven/bun:1.3 AS base
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS manifests
COPY package.json bun.lock bunfig.toml ./
COPY --parents apps/*/package.json packages/*/package.json contracts/*/package.json vendor/*/package.json ./

# Stage 1: Install deps and build
# Filtered install: a full workspace install would run node-pty's gyp build
# (a native dependency), which needs Python that oven/bun doesn't ship.
FROM manifests AS builder
RUN bun install --frozen-lockfile --filter @devflow/api
COPY --parents apps/api packages contracts vendor ./
RUN cd apps/api && bun run build

# Stage 2: Install production deps only
FROM manifests AS prod-deps
RUN bun install --frozen-lockfile --production --filter @devflow/api

# Stage 3: Final runtime image
FROM node:24-slim AS runner
WORKDIR /usr/src/app/apps/api
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 hono

COPY --from=prod-deps --chown=hono:nodejs /usr/src/app /usr/src/app
COPY --from=builder --chown=hono:nodejs /usr/src/app/apps/api/dist ./dist

USER hono
ENV NODE_ENV=production PORT=8700
EXPOSE 8700
CMD ["node", "./dist/index.mjs"]
