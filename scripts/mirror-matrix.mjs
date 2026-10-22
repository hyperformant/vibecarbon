#!/usr/bin/env node
/**
 * Emit the ghcr mirror matrix as JSON: one {src, dst, digest} entry per image
 * in `MIRRORED_IMAGES` (src/lib/images.js), registry.k8s.io and docker.io
 * alike. `src` is the upstream ref (`docker.io/library/traefik:v3.6.11`,
 * `registry.k8s.io/pause:3.9`); `dst` is the tag the job
 * pushes; `digest` is the pinned upstream linux/amd64 manifest the job copies
 * (and the digest every deployed ref carries); `index` is the upstream index
 * that child is read from, or '' to read it from the tag (MirroredImage.index).
 *
 * Consumed by the `mirror-matrix` job in
 * .github/workflows/publish-images.yml, which feeds it
 * straight into a `strategy.matrix.include`.
 *
 * WHY A SCRIPT AND NOT A `grep -oP` IN THE WORKFLOW — the cluster-autoscaler
 * mirror (#222) resolved two scalar constants, and grepping them out of
 * images.js was fine. The set is now a LIST of (repo, tag) tuples, which grep
 * cannot express: it would take one pattern per entry, and a pattern that
 * silently matches nothing writes an empty ref like ":" into $GITHUB_OUTPUT
 * rather than failing visibly. Importing the module instead makes drift
 * between the workflow and the constants structurally impossible — there is no
 * pattern to get wrong — and lets the drift guard
 * (tests/unit/deploy/k8s-image-mirrors.test.ts) execute THIS EXACT program
 * rather than a paraphrase of it.
 *
 * Usage: node scripts/mirror-matrix.mjs
 */
import { k8sMirrorTagRef, MIRRORED_IMAGES, upstreamRef } from '../src/lib/images.js';

const matrix = MIRRORED_IMAGES.map((image) => ({
  src: upstreamRef(image),
  dst: k8sMirrorTagRef(image),
  digest: image.digest,
  index: image.index ?? '',
}));

// Single line: the workflow assigns this to a $GITHUB_OUTPUT value, and
// GITHUB_OUTPUT is line-oriented — a pretty-printed blob would need heredoc
// delimiters for no benefit.
process.stdout.write(`${JSON.stringify(matrix)}\n`);
