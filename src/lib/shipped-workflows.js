/**
 * Every version of the CI workflows `vibecarbon configure cicd` has installed
 * (src/lib/ci-setup.js), by checksum of its bytes.
 *
 * configure copies these from the template as they are, and until it
 * recorded their checksums it left no record of them: to upgrade, such a
 * workflow looked the same as one the user wrote. A copy listed here is the
 * CLI's own, byte for byte, so upgrade replaces it; anything else is offered
 * for review, never replaced. A version older than the public history
 * (before 2026-08-22) is not listed, so it is offered for review too.
 *
 * The list only grows. When carbon/.github/workflows/<file> changes, add the
 * new checksum (tests/unit/lib/shipped-workflows.test.ts names it); that test
 * also checks every version in git history is here. Each line names the
 * commit that shipped it. The retired deploy.yml left the template, and its
 * versions with it: upgrade no longer ships one to replace a copy with.
 */

import { hashContent } from './checksum.js';

/** @type {Readonly<Record<string, Set<string>>>} */
export const SHIPPED_WORKFLOWS = Object.freeze({
  '.github/workflows/vibecarbon-build.yml': new Set([
    'sha256:aacf3951c389427d2680f924170968e45542f5af10ba29a50ba1793e7d171a2c', // 32afb12d 2026-08-22
    'sha256:db1ef1a0d7451cf32acbf109ef1b42472bb98418a0a7a811d2d4818c3be08e01', // 075a91df 2026-08-23
    'sha256:3e4bb3db0a846b59189bdf4413ddb44c574bac797a057ba3010ee7f1166339c2', // 0e327785 2026-10-16
  ]),
});

/**
 * Whether `content` is, byte for byte, a version of the CI workflow at
 * `rel` that `configure cicd` installed.
 *
 * @param {string} rel - project-relative path
 * @param {string} content
 * @returns {boolean}
 */
export function isShippedWorkflow(rel, content) {
  return Object.hasOwn(SHIPPED_WORKFLOWS, rel) && SHIPPED_WORKFLOWS[rel].has(hashContent(content));
}
