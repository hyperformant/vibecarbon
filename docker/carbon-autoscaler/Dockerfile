# The ONE Node pin in this file — written from the repo's .nvmrc by
# `pnpm node:sync` and asserted against it by
# tests/unit/lib/node-version-pins.test.ts.
ARG NODE_IMAGE=node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
FROM ${NODE_IMAGE}
WORKDIR /app
# Runtime deps of the server.js static import graph (provider modules
# lazy-import @pulumi inside method bodies, never at import time; undici is
# fetch-retry's HTTP client). Versions pinned to root package.json — the
# image-ref drift test asserts parity.
RUN npm install --no-save --omit=dev @grpc/grpc-js@^1.14.4 @grpc/proto-loader@^0.8.1 undici@^8.5.0 @clack/prompts@^1.6.0 \
    && addgroup -S carbon && adduser -S carbon -G carbon
COPY src/autoscaler/ ./src/autoscaler/
COPY src/lib/ ./src/lib/
COPY package.json ./
# Numeric UID:GID (carbon:carbon) — the deployment's securityContext sets
# runAsNonRoot, and kubelet REFUSES a named USER with
# CreateContainerConfigError ("cannot verify user is non-root"); it can only
# verify a numeric one. Field-proven 2026-07-27 (first k8s e2e on this image).
USER 100:101
HEALTHCHECK CMD ["node", "src/autoscaler/healthcheck.js", "--liveness"]
ENTRYPOINT ["node", "src/autoscaler/server.js"]

# OCI metadata — this is what makes the ghcr package page self-documenting.
# `org.opencontainers.image.description` is the ONLY input to a container
# package's description on GitHub; there is no UI field to type one in, so a
# package built without this label renders as a bare list of tags.
#
# LAST in the file deliberately: LABEL is config metadata, not a filesystem
# layer, so rewording this prose can never invalidate the npm-install cache
# above it.
#
# `.source` and `.licenses` are the repo's own declared `repository.url` and
# `license` from package.json, minus the `.git` suffix — the drift guard
# asserts that equality rather than letting a second copy of the URL rot here.
# Note what the value is NOT: it is not the git remote. `repository.url` names
# hyperformant/vibecarbon, the canonical home; the dev remote today is
# brandonpowers/vibecarbon. Pointing at the canonical URL is what ghcr wants
# anyway — it attaches a repo's README to a package only when the two share an
# owner, and only `hyperformant/*` shares one with these packages. Nothing
# renders until that repo exists, and then it renders with no change here.
#
# Guarded by tests/unit/deploy/oci-image-metadata.test.ts.
LABEL org.opencontainers.image.title="carbon-autoscaler" \
      org.opencontainers.image.description="Vibecarbon's cloud-agnostic autoscaler backend: it implements the Kubernetes cluster-autoscaler externalgrpc CloudProvider contract on top of vibecarbon's provider registry, so one unmodified cluster-autoscaler can add and remove nodes on any cloud vibecarbon supports. Runs as a sidecar to the mirrored upstream cluster-autoscaler, pinned to the k3s control-plane node. Not a general-purpose autoscaler — it speaks only to the cluster it was deployed alongside." \
      org.opencontainers.image.source="https://github.com/hyperformant/vibecarbon" \
      org.opencontainers.image.licenses="FSL-1.1-MIT"
