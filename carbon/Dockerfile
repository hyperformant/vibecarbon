# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# The ONE Node pin in this file. Every other stage derives from it, so a Node
# upgrade is a single-line edit here — and `pnpm node:sync` writes even this
# line from the repo's .nvmrc. Dockerfiles can't read .nvmrc, so
# tests/unit/lib/node-version-pins.test.ts asserts this tag's major matches it,
# and that its alpine minor matches the runtime base below.
ARG NODE_IMAGE=node:24-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# The runtime base the app runs on: vibecarbon's published node runtime
# (Alpine + the node binary + libstdc++ + the `hono` user, built from
# docker/node-runtime in the vibecarbon repo). Every vibecarbon app shares it,
# so a server pulls it from the registry once and a deploy ships only the
# layers below that are this app's own. Written by vibecarbon, and the one
# place the CLI looks for the base a deploy can pre-pull on a server.
ARG RUNTIME_IMAGE=ghcr.io/hyperformant/node-runtime:24-alpine3.24-r1

# Base image can be overridden for Turbo Layer Caching
# Default is the standard node image
ARG BASE_IMAGE=${NODE_IMAGE}
FROM ${BASE_IMAGE} AS builder

# Build args for Vite (baked into client bundle at build time). Every value
# ships in the JS bundle to every browser, so never pass a secret here.
ARG VITE_PROJECT_NAME
# Optional service feature flags (set to "true" when the service is enabled)
ARG VITE_N8N_ENABLED
ARG VITE_METABASE_ENABLED
ARG VITE_REDIS_ENABLED
ARG VITE_OBSERVABILITY_ENABLED
# Routing mode: 'subdomain' (compose) or 'path' (k8s)
ARG VITE_ROUTING_MODE
# Analytics (optional — empty by default, no tracking unless configured)
ARG VITE_PLAUSIBLE_DOMAIN
ARG VITE_PLAUSIBLE_SCRIPT_URL
ARG VITE_GITHUB_REPO_URL
# Public canonical URL (apex domain) for og: tags + sitemap. Set at deploy from
# the real domain; defaults to localhost for local builds.
ARG VITE_PUBLIC_URL

WORKDIR /app

# Install dependencies first so the layer caches independently of source.
# .dockerignore excludes node_modules, so this always runs against a clean
# /app — no need for a defensive `if [ ! -d node_modules ]` check.
COPY package.json package-lock.json ./
# npm ships with node, so nothing had to be installed to get here.
#
# `npm ci` is the ONLY install path here, deliberately. It installs exactly what
# package-lock.json records and never re-resolves — which is the entire point of
# shipping a lockfile. An `|| npm install` repair branch would quietly re-resolve
# every floating range at image-build time, so the image you ship would stop
# matching the tree you reviewed and tested (the unbounded `>=` floors in
# `overrides` jump majors when re-resolved). It would also mask a genuinely
# broken lockfile until much later.
#
# If `npm ci` fails here, the committed lockfile is wrong, not the npm version:
# run `npm install` locally and commit the resulting package-lock.json.
# `vibecarbon create` ships this lockfile straight from the template, where CI
# has already verified it against `npm ci` — it is not re-resolved per project.
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci --no-audit --no-fund

# Copy application code
COPY tsconfig.json tsconfig.server.json biome.json vite.config.ts components.json ./
COPY content/ ./content/
COPY scripts/ ./scripts/
COPY src/ ./src/

# Build client (Vite) and server (TypeScript). Split into TWO RUNs so an
# edit that only touches src/server/ doesn't bust the Vite client cache
# (and vice versa). The COPY src/ above still cache-busts both on any
# src change, but with split RUNs the slower of the two (Vite) can land
# from cache when only the other side moved.
# VITE_ env vars are available from ARGs during build
ENV VITE_PROJECT_NAME=$VITE_PROJECT_NAME
ENV VITE_N8N_ENABLED=$VITE_N8N_ENABLED
ENV VITE_METABASE_ENABLED=$VITE_METABASE_ENABLED
ENV VITE_REDIS_ENABLED=$VITE_REDIS_ENABLED
ENV VITE_OBSERVABILITY_ENABLED=$VITE_OBSERVABILITY_ENABLED
ENV VITE_ROUTING_MODE=$VITE_ROUTING_MODE
ENV VITE_PLAUSIBLE_DOMAIN=$VITE_PLAUSIBLE_DOMAIN
ENV VITE_PLAUSIBLE_SCRIPT_URL=$VITE_PLAUSIBLE_SCRIPT_URL
ENV VITE_GITHUB_REPO_URL=$VITE_GITHUB_REPO_URL
RUN npm run build:client
RUN npm run build:server

# Dependency stage — install runtime deps in a throwaway container.
FROM ${NODE_IMAGE} AS deps
WORKDIR /deps
RUN npm init -y > /dev/null 2>&1 && \
    npm install --no-package-lock pino@10

# Production stage: the shared runtime base plus this app's own files. Add
# nothing here that belongs to every app (packages, users, the node binary):
# it would ride in every deploy instead of in the base servers already hold.
FROM ${RUNTIME_IMAGE} AS runner

WORKDIR /app

# Copy pre-installed runtime dependencies from deps stage
COPY --from=deps /deps/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# The database migrations. The migrate step in this same image applies them
# (dist/server/migrate-cli.js reads db/migrations under its working directory)
# and the server checks its ledger against them, so they ship inside the
# image and no deploy step pipes SQL anywhere.
COPY db/migrations/ ./db/migrations/

# Copy entrypoint
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Security: switch to non-root user
USER hono

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
