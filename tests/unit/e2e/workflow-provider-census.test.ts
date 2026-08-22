/**
 * Census: the CI workflow's two hand-maintained provider lists must match
 * the provider registry (`tests/config.ts` `e2e.providers`) exactly.
 *
 * Written after Task 8's review (task-8-review.md M-1) found the
 * provider-parallel restructure of `.github/workflows/e2e-us-perf.yml`
 * introduced two literals that don't key off the registry:
 *
 *   - the `provider:` workflow_dispatch input's `options:` list;
 *   - the `fromJSON('["hetzner","digitalocean"]')` array in the matrix
 *     `strategy` expression (the `provider: all` expansion).
 *
 * Spec Part 1 promises "adding provider #3 = one config entry" — without
 * this census, that promise silently stops being true for this one file:
 * a third provider would compile, pass every OTHER census, and still be
 * unreachable from a real dispatch until someone thought to grep this YAML
 * by hand.
 *
 * The `options:` list is real YAML structure, so it's parsed (js-yaml, same
 * idiom as node-version-pins.test.ts / pnpm-version-pins.test.ts). The
 * `fromJSON(...)` literal lives inside a GH Actions EXPRESSION STRING, not
 * YAML structure of its own — `provider: ${{ inputs.provider == 'all' &&
 * fromJSON('[...]') || ... }}` is one scalar string as far as YAML is
 * concerned — so it's extracted with a targeted regex instead. The regex is
 * anchored on `fromJSON('...')` (single-quoted argument) specifically so it
 * does NOT also match the sibling `fromJSON(format('["{0}"]', inputs.provider))`
 * call in the same expression, which names no providers of its own.
 *
 * Family check (2026-08-08): grepped every other `.github/workflows/*.yml`
 * for hetzner/digitalocean literals — none hardcode provider TOKENS (a
 * handful of comments mention the cloud names architecturally, e.g. ARM
 * SKU availability notes in publish-images.yml / publish-db-image.yml).
 * This file is the only CI-topology site that needs a census entry today.
 */
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';

const WORKFLOW_PATH = '.github/workflows/e2e-us-perf.yml';

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

const REGISTRY_PROVIDERS = Object.keys(testConfig.e2e.providers).sort();

describe('e2e-us-perf.yml provider lists match the registry (tests/config.ts e2e.providers)', () => {
  it("the `provider` workflow_dispatch input's options list is exactly the registry's providers, plus 'all'", () => {
    const doc = loadYaml(readWorkflow()) as {
      on?: { workflow_dispatch?: { inputs?: { provider?: { options?: string[] } } } };
    };
    const options = doc.on?.workflow_dispatch?.inputs?.provider?.options;
    expect(
      options,
      'e2e-us-perf.yml: `provider` input or its `options:` list is missing',
    ).toBeDefined();
    expect([...(options ?? [])].sort()).toEqual([...REGISTRY_PROVIDERS, 'all'].sort());
  });

  it("the matrix strategy's fromJSON('[...]') literal (the `provider: all` expansion) names exactly the registry's providers", () => {
    const yaml = readWorkflow();
    // Deliberately excludes the sibling `fromJSON(format('["{0}"]', ...))`
    // call in the same expression — that one is dynamic (echoes whichever
    // single provider was dispatched) and names nothing to census.
    const match = /fromJSON\('(\[[^\]]*\])'\)/.exec(yaml);
    expect(
      match,
      "e2e-us-perf.yml: no fromJSON('[...]') literal found — did the matrix strategy expression change shape?",
    ).not.toBeNull();
    const literal = JSON.parse(match?.[1] ?? '[]') as string[];
    expect([...literal].sort()).toEqual(REGISTRY_PROVIDERS);
  });
});

/**
 * Every credential a provider DECLARES as required must actually reach the
 * runner. The registry's `requiredEnv` is what preflight demands and what the
 * operator is told to set; if the workflow forgets to map one, the leg runs
 * with a silently incomplete credential set and fails somewhere downstream
 * wearing a misleading error.
 *
 * Run 31663154544 lost the whole Linode leg this way. `LINODE_STORAGE_REGION`
 * was mapped nowhere in the workflow (Vultr's equivalent was), so bucket
 * creation went to the account's default cluster instead of its assigned one
 * and failed as `exists but is owned by another account` — a message that
 * reads like a name collision and is really a wrong endpoint. It was even
 * classified `[infra: S3 transient]` and retried, because nothing upstream
 * knew the value was missing rather than wrong.
 *
 * Asserting against `requiredEnv` rather than a hand-listed set is what makes
 * this hold for provider #6: declare a credential, and this fails until the
 * workflow carries it.
 */
describe('e2e-us-perf.yml carries every credential the registry marks required', () => {
  /** Every env key bound anywhere in the matrix job — job level or any step. */
  function matrixJobEnvKeys(): Set<string> {
    const doc = loadYaml(readWorkflow()) as {
      jobs: Record<
        string,
        { env?: Record<string, unknown>; steps: { env?: Record<string, unknown> }[] }
      >;
    };
    const job = doc.jobs.matrix;
    const keys = new Set(Object.keys(job.env ?? {}));
    for (const step of job.steps ?? []) {
      for (const k of Object.keys(step.env ?? {})) keys.add(k);
    }
    return keys;
  }

  it('maps every provider.requiredEnv var into the matrix job', () => {
    const bound = matrixJobEnvKeys();
    const providers = testConfig.e2e.providers as unknown as Record<
      string,
      { requiredEnv: string[] }
    >;
    const missing: string[] = [];
    for (const [id, entry] of Object.entries(providers)) {
      for (const key of entry.requiredEnv ?? []) {
        if (!bound.has(key)) missing.push(`${id}: ${key}`);
      }
    }
    expect(
      missing,
      `requiredEnv vars the workflow never binds:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('binds the storage-region var for every provider whose registry entry requires one', () => {
    // The specific shape of the Linode escape: the key/secret pair was mapped
    // but the cluster slug that decides WHICH endpoint they authenticate
    // against was not, so the credentials were valid and pointed nowhere useful.
    const bound = matrixJobEnvKeys();
    const providers = testConfig.e2e.providers as unknown as Record<
      string,
      { requiredEnv: string[] }
    >;
    for (const [id, entry] of Object.entries(providers)) {
      const region = (entry.requiredEnv ?? []).find((k) => k.endsWith('_STORAGE_REGION'));
      if (!region) continue;
      expect(bound.has(region), `${id} requires ${region} but the workflow never binds it`).toBe(
        true,
      );
    }
  });
});
