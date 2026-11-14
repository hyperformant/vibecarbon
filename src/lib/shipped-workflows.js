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
 * commit that shipped it.
 */

import { hashContent } from './checksum.js';

/** @type {Readonly<Record<string, Set<string>>>} */
export const SHIPPED_WORKFLOWS = Object.freeze({
  '.github/workflows/deploy.yml': new Set([
    'sha256:2f59f94f11f366957032fbf4636156deae3c3599f1e0153aa0c8a02417a324c1', // 32afb12d 2026-08-22
    'sha256:0636f8fa49454f2d5e3491b687e2aafce71f913eb0fb5119e6bc46c5479ab77f', // 0e327785 2026-10-16
    'sha256:1045bc70b087f558e9f175933851c55d21b0753c64904478ac227e8e7f95ded6', // 717211ef 2026-10-25
    'sha256:c72c72b061d150567b56909e62de48d8e6fe7937f9e71c25985278412f9f1b80', // 4b02b38d 2026-10-31
    'sha256:fef2a96de38886695f09c41fa428c3a50538a136c6742602ae251f8c8b3d8fa7', // 63717682 2026-10-31
    'sha256:113b978f395f9f3d25fe0bf05e68a516c209f0188799190788d33a3356ec900d', // 8b3c41f7 2026-10-31
    'sha256:71cb087ff29aeb895fad83cfeebe44c906ab3715721cf3168683fcbcc3096c5a', // 5fc64d50 2026-11-03
    'sha256:1dc39ea7147a907fc8cf609cf90f8ab0e5a4413dc5022ad1fadeedc40ca737e1', // 40da6610 2026-11-03
    'sha256:3edc8a775e4b0526eab0075105905099184c4de03be4099eea05b7a906a13942', // c30d120c 2026-11-04
    'sha256:3c425d630a708f693e4f5cefd3af00c32eec0a6885f5ed6467f91329a85708cd', // 14c0895e 2026-11-05
    'sha256:b0d6155104c520cb74de2524dcb5529dded5ec970e5d79119652d0d2c98a2064', // 3a000149 2026-11-07
    'sha256:1a31feb601f9d518b1845b4f540d4bb8b0cc5715d3b6681e65376c1dabc1ccad', // 12c76b22 2026-11-12
    'sha256:42c70cbe1ddbc83c84c8a39bd8b542c1455be5fb6b25bb392dc70484a89c42ff', // e237e3ea 2026-11-12
    'sha256:bd2626fb4a5a1a39b29cb23383a8fa24c9eb61541bcf2eeb6010e037f33bde3b', // a7e8596b 2026-11-14
  ]),
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
