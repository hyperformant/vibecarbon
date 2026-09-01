/**
 * Sibling-convergence registry (sibling-surface drift failure class,
 * 2026-07-30).
 *
 * Four of the escapes that motivated this were "the same logical operation
 * implemented twice, fixed once": compose kept warn-and-continue admin-user
 * creation months after k8s failed loud; Hetzner list calls stayed
 * un-paginated after DO's were fixed; Cloudflare DNS destroy deleted only
 * the apex while the Hetzner branch beside it deleted the pair; iter-step
 * hand-copied three of the runner's env vars and silently ran production
 * Let's Encrypt. In every case the durable fix was CONVERGENCE — one shared
 * helper, N consumers — plus a pin that the consumers actually route
 * through it.
 *
 * This file is the registry of those convergences. Each row asserts, from
 * source text, that the helper is still exported where the row says and
 * that every consumer still references it by name — so a refactor that
 * re-inlines a private copy on one side (de-convergence, the first step of
 * every parity drift) fails here by name instead of surfacing as next
 * quarter's asymmetric bug. Behavioral depth lives in each row's deepTests
 * (also existence-checked so the pointers can't rot).
 *
 * When you converge a new sibling pair on a shared helper, ADD A ROW. The
 * decision procedure in docs/tests.md ("which guard must accompany a
 * change") points here.
 *
 * KNOWN LIMIT (PR #214 review, empirically probed): this registry is
 * file-level and listed-consumer-only. It catches a LISTED consumer
 * dropping its reference (de-convergence), but NOT a new file that
 * re-implements the operation without ever touching the helper, and not a
 * re-inline inside a listed file that still mentions the helper's name.
 * New bypassing call sites are caught only by the parity rule at review
 * time — or by a call-site-level repo sweep when the operation has a
 * greppable wire signature (see list-endpoint-pagination-sweep.test.ts
 * for the pattern).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const REGISTRY = [
  {
    helper: 'listHetznerPages',
    definition: 'src/lib/providers/hetzner-pagination.js',
    consumers: [
      'src/lib/providers/hetzner.js', // destroy sweeps + fetchServerTypes catalog
      'scripts/sweep-hetzner.js', // standalone zero-orphan audit
      'tests/e2e/scenarios/_run-lifecycle.ts', // per-run orphan sweep
    ],
    deepTests: [
      'tests/unit/providers/hetzner-pagination.test.ts',
      'tests/unit/e2e/sweep-pagination.test.ts',
      'tests/unit/providers/list-endpoint-pagination-sweep.test.ts',
    ],
  },
  {
    helper: 'deleteApexAndWildcard',
    definition: 'src/lib/cloudflare-dns.js',
    consumers: [
      'src/destroy.js', // destroyComposeTier + destroyK8sTier
      'src/lib/deploy/compose/ha.js', // destroyComposeHA
    ],
    deepTests: ['tests/unit/lib/delete-apex-and-wildcard.test.ts'],
  },
  {
    helper: 'pushImageOverSshTunnel',
    definition: 'src/lib/deploy/registry-push.js',
    consumers: [
      'src/lib/deploy/k8s/k3s.js', // k8s app/backup image push
      'src/lib/deploy/effects/index.js', // compose warm-redeploy layer push
    ],
    deepTests: ['tests/unit/deploy/registry-push.test.ts'],
  },
  {
    helper: 'isBucketAlreadyGone',
    definition: 'tests/e2e/utils/bucket-already-gone.ts',
    consumers: [
      'tests/e2e/utils/sweep-digitalocean.ts', // Spaces bucket delete
      'tests/e2e/utils/sweep-vultr.ts', // Object Storage bucket delete
      'tests/e2e/utils/sweep-linode.ts', // Object Storage bucket delete
      'tests/e2e/utils/sweep-scaleway.ts', // Object Storage bucket delete
    ],
    deepTests: ['tests/unit/e2e/bucket-already-gone.test.ts'],
  },
  {
    helper: 'e2eCliEnv',
    definition: 'tests/e2e/utils/e2e-env.js',
    consumers: [
      'scripts/iter-step.js', // kept-rig single-step iteration
      'tests/e2e/utils/cli-runner.ts', // full-run step execution
    ],
    deepTests: ['tests/unit/e2e/iter-step-env-parity.test.ts'],
  },
  {
    helper: 'fetchServerTypes',
    definition: 'tests/e2e/utils/server-types.ts',
    consumers: [
      'tests/e2e/scenarios/_run-lifecycle.ts', // verify-scale type snapshots
      'tests/e2e/metrics/collector.ts', // cost metrics IP→type resolution
    ],
    deepTests: ['tests/unit/e2e/server-types.test.ts'],
  },
  {
    helper: 'gitScrubbedEnv',
    definition: 'tests/_shared/git-env.ts',
    consumers: [
      'tests/integration/template/create.test.ts', // fixture git assertions
      'tests/integration/cli/upgrade/upgrade.test.ts', // upgrade hygiene fixture commits
      'tests/e2e/scenarios/_run-lifecycle.ts', // setup-repo add/commit/push
    ],
    deepTests: ['tests/unit/lib/git-scrubbed-env.test.ts'],
  },
  {
    // Same shape as gitScrubbedEnv, one layer up: an env var the RUNNER sets
    // that silently redirects what the fixture is testing. Fixed inline in two
    // files first, and the third site was missed until its assertion failed —
    // textbook sibling drift, so converged and pinned here. The FOURTH site
    // (the real-infra e2e harness) was missed by that convergence too and cost
    // a full e2e run: every e2e `create` built a pnpm project, so the matrix
    // never exercised the npm default and broke on the pnpm path instead.
    helper: 'pmScrubbedEnv',
    definition: 'tests/_shared/pm-env.js',
    consumers: [
      'tests/integration/template/create.test.ts', // default-options fixture
      'tests/integration/template/lint-build.test.ts', // npm lint/build/ci gate
      'tests/integration/_harness/real-project.ts', // cached CLI fixture
      'tests/e2e/utils/e2e-env.js', // every real-infra CLI child
    ],
    deepTests: ['tests/unit/lib/pm-scrubbed-env.test.ts'],
  },
] as const;

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe.each(REGISTRY)('convergence: $helper', ({ helper, definition, consumers, deepTests }) => {
  it(`is exported from ${definition}`, () => {
    expect(read(definition)).toMatch(new RegExp(`export (?:async )?function ${helper}\\b`));
  });

  it.each([...consumers])('%s routes through it', (consumer) => {
    expect(
      read(consumer),
      `${consumer} no longer references ${helper}. If it grew its own copy, that is ` +
        'de-convergence — the first step of every sibling-parity drift. Route it back through ' +
        `${definition}, or update this registry WITH a parity argument for why the surfaces ` +
        'may now diverge.',
    ).toContain(helper);
  });

  it.each([...deepTests])('deep test %s still exists', (deepTest) => {
    expect(existsSync(join(ROOT, deepTest))).toBe(true);
  });
});
