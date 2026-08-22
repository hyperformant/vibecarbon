#!/usr/bin/env node
/**
 * Emit the ghcr mirror matrix as JSON: one {src, dst} pair per entry in
 * `MIRRORED_K8S_IMAGES` (src/lib/images.js).
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
import { MIRRORED_K8S_IMAGES, k8sMirrorRef, k8sUpstreamRef } from '../src/lib/images.js';

const matrix = MIRRORED_K8S_IMAGES.map((image) => ({
  src: k8sUpstreamRef(image),
  dst: k8sMirrorRef(image),
}));

// Single line: the workflow assigns this to a $GITHUB_OUTPUT value, and
// GITHUB_OUTPUT is line-oriented — a pretty-printed blob would need heredoc
// delimiters for no benefit.
process.stdout.write(`${JSON.stringify(matrix)}\n`);
