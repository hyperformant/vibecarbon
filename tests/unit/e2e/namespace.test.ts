import { describe, expect, it } from 'vitest';
import {
  activeNamespace,
  remapEnvPrefix,
  scratchNamePrefix,
  sharedStateBucketName,
} from '../../e2e/utils/namespace.js';

// Pass env explicitly — never mutate process.env in tests.
const withNs = (ns?: string) => ({ E2E_NAMESPACE: ns }) as NodeJS.ProcessEnv;

describe('activeNamespace', () => {
  it('returns null when E2E_NAMESPACE is unset, empty, or whitespace', () => {
    expect(activeNamespace(withNs(undefined))).toBeNull();
    expect(activeNamespace(withNs(''))).toBeNull();
    expect(activeNamespace(withNs('   '))).toBeNull();
  });

  it('returns the trimmed namespace when valid', () => {
    expect(activeNamespace(withNs('ci'))).toBe('ci');
    expect(activeNamespace(withNs(' ci '))).toBe('ci');
  });

  it('throws on invalid namespaces (DNS-label safety)', () => {
    expect(() => activeNamespace(withNs('CI'))).toThrow(/E2E_NAMESPACE/);
    expect(() => activeNamespace(withNs('9ci'))).toThrow(/E2E_NAMESPACE/);
    expect(() => activeNamespace(withNs('ci-x'))).toThrow(/E2E_NAMESPACE/);
    expect(() => activeNamespace(withNs('toolongns9'))).toThrow(/E2E_NAMESPACE/);
  });
});

describe('scratchNamePrefix', () => {
  it("defaults to 'testapp-' (local runs unchanged)", () => {
    expect(scratchNamePrefix(withNs(undefined))).toBe('testapp-');
  });

  it("derives '<ns>test-' under a namespace", () => {
    expect(scratchNamePrefix(withNs('ci'))).toBe('citest-');
  });
});

describe('remapEnvPrefix', () => {
  it('leaves env prefixes unchanged without a namespace', () => {
    expect(remapEnvPrefix('e1', withNs(undefined))).toBe('e1');
    expect(remapEnvPrefix('e4', withNs(''))).toBe('e4');
  });

  it("remaps e<N> to '<ns><N>' under a namespace", () => {
    expect(remapEnvPrefix('e1', withNs('ci'))).toBe('ci1');
    expect(remapEnvPrefix('e4', withNs('ci'))).toBe('ci4');
  });

  it('only strips a LEADING e — reference-scenario prefixes keep their letter under a namespace', () => {
    // d1 → cid1 / l1 → cil1 / v1 → civ1: the provider letter survives, so
    // DNS labels and project names stay distinguishable per provider in CI.
    // Pinned because this is a deliberate (if slightly odd-looking)
    // outcome, not an oversight.
    expect(remapEnvPrefix('d1', withNs('ci'))).toBe('cid1');
    expect(remapEnvPrefix('l1', withNs('ci'))).toBe('cil1');
    expect(remapEnvPrefix('v1', withNs('ci'))).toBe('civ1');
    expect(remapEnvPrefix('s1', withNs('ci'))).toBe('cis1');
  });
});

describe('sharedStateBucketName', () => {
  it('never collides with the sweep prefix, namespaced or not', () => {
    // THE property this exists to guarantee. The orphan sweeps collect
    // scratchNamePrefix(), so a state bucket we intend to KEEP across runs must
    // not match it — otherwise every run would delete it and report a destroy
    // regression. Derived independently from scratchNamePrefix and checked
    // against it here, the same way the sweep script's prefix derivation is
    // pinned to this module's.
    for (const env of [{}, { E2E_NAMESPACE: 'ci' }, { E2E_NAMESPACE: 'perf' }]) {
      const bucket = sharedStateBucketName(env as NodeJS.ProcessEnv);
      const prefix = scratchNamePrefix(env as NodeJS.ProcessEnv);
      expect(bucket.startsWith(prefix), `${bucket} must not start with ${prefix}`).toBe(false);
    }
  });

  it('is stable across calls, which is the whole point', () => {
    // A per-run name would put every Pulumi operation back on a bucket minutes
    // old — the worst window for the state-backend class.
    const env = { E2E_NAMESPACE: 'ci' } as NodeJS.ProcessEnv;
    expect(sharedStateBucketName(env)).toBe(sharedStateBucketName(env));
  });

  it('separates namespaces so two operators do not share one bucket', () => {
    expect(sharedStateBucketName({ E2E_NAMESPACE: 'ci' } as NodeJS.ProcessEnv)).not.toBe(
      sharedStateBucketName({} as NodeJS.ProcessEnv),
    );
  });

  it('honours an explicit override', () => {
    // Bucket names are global per provider, so operators sharing an account
    // need distinct names; it is also how the cold-start path gets exercised.
    expect(
      sharedStateBucketName({ VC_E2E_STATE_BUCKET: 'my-own-state' } as NodeJS.ProcessEnv),
    ).toBe('my-own-state');
  });
});
