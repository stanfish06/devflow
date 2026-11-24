# syntax=docker/dockerfile:1.20

FROM oven/bun:1.3 AS base
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS manifests
COPY package.json bun.lock bunfig.toml ./
COPY --parents apps/*/package.json packages/*/package.json contracts/*/package.json vendor/*/package.json ./

# Stage 1: Install deps and build
# Filtered install: a full workspace install would run node-pty's gyp build
# (dep of devflow-electron), which needs Python that oven/bun doesn't ship.
FROM manifests AS builder
RUN bun install --frozen-lockfile --filter @devflow/sync-proxy
COPY --parents apps/sync-proxy packages contracts vendor ./
RUN cd apps/sync-proxy && bun run build

# Stage 2: Install production deps only
FROM manifests AS prod-deps
RUN bun install --frozen-lockfile --production --filter @devflow/sync-proxy

# Stage 3: Final runtime image
FROM node:24-slim AS runner
WORKDIR /usr/src/app/apps/sync-proxy
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 hono

COPY --from=prod-deps --chown=hono:nodejs /usr/src/app /usr/src/app
COPY --from=builder --chown=hono:nodejs /usr/src/app/apps/sync-proxy/dist ./dist

USER hono
ENV NODE_ENV=production PORT=8888
EXPOSE 8888
CMD ["node", "./dist/index.mjs"]
