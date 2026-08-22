# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# The ONE Node pin in this file. Every other stage derives from it, so a Node
# upgrade is a single-line edit here — and `pnpm node:sync` writes even this
# line from the repo's .nvmrc. Dockerfiles can't read .nvmrc, so
# tests/unit/lib/node-version-pins.test.ts asserts this tag's major matches it.
#
# The alpine minor is load-bearing, not cosmetic: the runner stage below is a
# bare `alpine:3.23` that the node binary is COPY'd into, so this must stay
# pinned to the SAME alpine as that stage or the binary hits a musl/libstdc++
# mismatch at runtime.
ARG NODE_IMAGE=node:24-alpine3.23

# Base image can be overridden for Turbo Layer Caching
# Default is the standard node image
ARG BASE_IMAGE=${NODE_IMAGE}
FROM ${BASE_IMAGE} AS builder

# Build args for Vite (baked into client bundle at build time).
# The anon key is a public value — it ships in the JS bundle to every browser.
ARG VITE_PROJECT_NAME
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
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
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_N8N_ENABLED=$VITE_N8N_ENABLED
ENV VITE_METABASE_ENABLED=$VITE_METABASE_ENABLED
ENV VITE_REDIS_ENABLED=$VITE_REDIS_ENABLED
ENV VITE_OBSERVABILITY_ENABLED=$VITE_OBSERVABILITY_ENABLED
ENV VITE_ROUTING_MODE=$VITE_ROUTING_MODE
ENV VITE_PLAUSIBLE_DOMAIN=$VITE_PLAUSIBLE_DOMAIN
ENV VITE_PLAUSIBLE_SCRIPT_URL=$VITE_PLAUSIBLE_SCRIPT_URL
RUN npm run build:client
RUN npm run build:server

# Dependency stage — install runtime deps in a throwaway container.
# Also the source of the node binary for the runner stage below (see there).
FROM ${NODE_IMAGE} AS deps
WORKDIR /deps
RUN npm init -y > /dev/null 2>&1 && \
    npm install --no-package-lock pino@10

# Production stage — minimal Alpine with just the node binary
FROM alpine:3.23 AS runner

RUN apk add --no-cache libstdc++ && \
    addgroup -g 1001 -S hono && \
    adduser -S hono -u 1001 -G hono

# Take the node binary from the `deps` stage rather than naming the image a
# second time. BuildKit REJECTS `COPY --from=${NODE_IMAGE}` outright
# ("variable expansion is not supported for --from") and points at exactly
# this workaround: a stage built FROM a global ARG. `deps` is already
# FROM ${NODE_IMAGE} and already built, so this also drops a redundant
# resolve of the same image.
COPY --from=deps /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Copy pre-installed runtime dependencies from deps stage
COPY --from=deps /deps/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

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
