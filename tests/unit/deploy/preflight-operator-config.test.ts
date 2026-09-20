import { describe, expect, it } from 'vitest';
import { checkDeployPrerequisites } from '../../../src/lib/deploy/preflight.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

// A stub PATH-lookup: everything present (host-tool checks aren't under
// test here — see preflight.test.ts for those).
const has = () => true;

const GOOD_HETZNER_TOKEN = 'a'.repeat(64);

describe('checkDeployPrerequisites — operator config gate', () => {
  it('throws with the Configuration problems header when a scoped value is malformed', () => {
    expect(() =>
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['provider:hetzner'],
        env: { HETZNER_API_TOKEN: '"abc"' },
      }),
    ).toThrow(/^Configuration problems \(nothing was provisioned\):/);
  });

  it('the thrown message names the malformed variable and points at .env.local', () => {
    let message = '';
    try {
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['provider:hetzner'],
        env: { HETZNER_API_TOKEN: '"abc"' },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/HETZNER_API_TOKEN/);
    expect(message).toMatch(/Set them in \.env\.local/);
  });

  it('does not throw when every scoped value is well-formed', () => {
    expect(() =>
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['provider:hetzner'],
        env: {
          HETZNER_API_TOKEN: GOOD_HETZNER_TOKEN,
          HETZNER_ACCESS_KEY: 'access-key-id',
          HETZNER_SECRET_KEY: 'a-secret-key-long-enough',
        },
      }),
    ).not.toThrow();
  });

  it('does not throw when no operatorScopes are given (default)', () => {
    expect(() => checkDeployPrerequisites('compose', { has })).not.toThrow();
  });

  it('lists problems from every scope together, in one throw', () => {
    let message = '';
    try {
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['provider:hetzner', 'tls'],
        env: {
          HETZNER_API_TOKEN: '"abc"',
          ACME_CA_SERVER: 'not-a-url',
        },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/HETZNER_API_TOKEN/);
    expect(message).toMatch(/ACME_CA_SERVER/);
  });

  it('never fails on an optional key that is simply absent', () => {
    expect(() =>
      checkDeployPrerequisites('compose', {
        has,
        ProviderClass: HetznerProvider,
        operatorScopes: ['tls', 'access', 'state'],
        env: {},
      }),
    ).not.toThrow();
  });
});
