import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A5 — Hetzner DNS uses the Hetzner Cloud API token. Every producer used to
// alias the COMPUTE token straight into `hetznerApiToken` (`hetznerApiToken:
// apiToken`), which is only correct while compute is Hetzner too. On any
// other compute provider (DigitalOcean, ...) that aliased value is the WRONG
// cloud's token. The 2026-08-08 DNS-seam convergence generalized the seam:
// resolveDnsToken(id, ...) is the same-token rule for EVERY backend —
// identity when the DNS backend's compute sibling matches (byte-identical to
// the old hetzner aliasing, no env read), the row's tokenEnv otherwise. The
// three cases below are the original decoupling regression, re-pinned
// through the generalized seam.

// Ambient-env scrub (see tests/unit/providers/token-resolution.test.ts for
// the vitest 4.1.10 vi.stubEnv(name, undefined) bug this works around): a
// HETZNER_API_TOKEN exported by the shell must not leak into these tests.
const ambientToken = process.env.HETZNER_API_TOKEN;
beforeAll(() => {
  delete process.env.HETZNER_API_TOKEN;
});
beforeEach(() => {
  delete process.env.HETZNER_API_TOKEN;
});
afterAll(() => {
  if (ambientToken === undefined) delete process.env.HETZNER_API_TOKEN;
  else process.env.HETZNER_API_TOKEN = ambientToken;
});

const { resolveDnsToken } = await import('../../../src/lib/dns-provider.js');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveDnsToken (hetzner DNS decoupling — original A5 regression)', () => {
  it('hetzner compute + token: returns the compute token verbatim, no env read', () => {
    // Decoy in the env fallback source — if the identity branch consulted
    // it, the assertion below would see the decoy instead.
    vi.stubEnv('HETZNER_API_TOKEN', 'decoy-env-token');

    const result = resolveDnsToken('hetzner', {
      computeProviderId: 'hetzner',
      computeToken: 'compute-token-abc',
    });

    expect(result).toBe('compute-token-abc');
  });

  it('digitalocean compute + HETZNER_API_TOKEN env set: returns the env value', () => {
    vi.stubEnv('HETZNER_API_TOKEN', 'env-hetzner-token');

    const result = resolveDnsToken('hetzner', {
      computeProviderId: 'digitalocean',
      computeToken: 'do-compute-token-should-be-ignored',
    });

    expect(result).toBe('env-hetzner-token');
  });

  it('digitalocean compute + nothing available: returns null', () => {
    const result = resolveDnsToken('hetzner', {
      computeProviderId: 'digitalocean',
      computeToken: undefined,
    });

    expect(result).toBeNull();
  });
});
