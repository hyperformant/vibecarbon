import { describe, expect, it } from 'vitest';
import { pickIssuerName } from '../../../src/lib/deploy/k8s/k3s.js';

const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const PROD = 'https://acme-v02.api.letsencrypt.org/directory';

describe('pickIssuerName', () => {
  it('the staging directory picks letsencrypt-staging', () => {
    expect(pickIssuerName({ acmeServer: STAGING })).toBe('letsencrypt-staging');
  });

  it('the production directory picks letsencrypt-prod', () => {
    expect(pickIssuerName({ acmeServer: PROD })).toBe('letsencrypt-prod');
  });

  it('no server picks letsencrypt-prod (safe default)', () => {
    expect(pickIssuerName({})).toBe('letsencrypt-prod');
    expect(pickIssuerName({ acmeServer: null })).toBe('letsencrypt-prod');
  });
});
