/**
 * One switch (E2E_ACME_CA) picks the CA for the whole e2e harness, and a
 * preflight gate refuses to provision when that CA's directory is down (LE
 * staging maintenance, 2026-11-03, was only discovered 15 minutes in, at
 * ssl_valid).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { k8sIssuerName } from '../../../src/lib/deploy/k8s/k3s.js';
import {
  ACME_PRODUCTION_DIRECTORY,
  ACME_STAGING_DIRECTORY,
  REPO_ROOT,
  resolveE2EAcmeCa,
  setupE2EEnv,
} from '../../e2e/utils/e2e-env.js';
import { checkAcmeDirectory } from '../../e2e/utils/preflight.js';

const acme = { url: ACME_STAGING_DIRECTORY, label: "Let's Encrypt staging" };

describe('checkAcmeDirectory gate', () => {
  it('passes a healthy directory', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ newNonce: 'x' }), { status: 200 })) as typeof fetch;
    const r = await checkAcmeDirectory(acme, fetchImpl);
    expect(r.status).toBe('ok');
  });

  it('refuses a directory that resets the connection, naming URL, error and both ways forward', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }) as typeof fetch;
    const r = await checkAcmeDirectory(acme, fetchImpl);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain(ACME_STAGING_DIRECTORY);
    expect(r.detail).toContain('ECONNRESET');
    expect(r.detail).toContain('https://letsencrypt.status.io');
    expect(r.detail).toContain('E2E_ACME_CA=production');
  });

  it('refuses a non-2xx answer', async () => {
    const fetchImpl = (async () => new Response('down', { status: 503 })) as typeof fetch;
    const r = await checkAcmeDirectory(acme, fetchImpl);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('HTTP 503');
  });

  it('bounds the request: a hung directory fails at the timeout', async () => {
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
    const r = await checkAcmeDirectory(acme, fetchImpl, 20);
    expect(r.status).toBe('failed');
  });
});

describe('E2E_ACME_CA switch', () => {
  it('defaults to staging and accepts production only as an opt-in', () => {
    expect(resolveE2EAcmeCa({}).directory).toBe(ACME_STAGING_DIRECTORY);
    expect(resolveE2EAcmeCa({ E2E_ACME_CA: 'staging' }).staging).toBe(true);
    expect(resolveE2EAcmeCa({ E2E_ACME_CA: 'production' }).directory).toBe(
      ACME_PRODUCTION_DIRECTORY,
    );
    expect(() => resolveE2EAcmeCa({ E2E_ACME_CA: 'prod-ish' })).toThrow(/E2E_ACME_CA/);
  });

  const flipped = (value?: string) => {
    const env: NodeJS.ProcessEnv = {
      VIBECARBON_LICENSE_PRIVATE_KEY: process.env.VIBECARBON_LICENSE_PRIVATE_KEY,
    };
    if (value) env.E2E_ACME_CA = value;
    return env;
  };

  it('flips ACME_CA_SERVER, the k8s issuer and the trust wiring together', () => {
    for (const [value, issuer, staging] of [
      [undefined, 'letsencrypt-staging', true],
      ['production', 'letsencrypt-prod', false],
    ] as const) {
      const env = flipped(value);
      const r = (() => {
        try {
          return setupE2EEnv({ env, applyInProcess: false, warn: () => {} });
        } catch (e) {
          // No signing key in this environment: the CA decision is the part under test.
          if (/LICENSE/i.test(String((e as Error).message))) return null;
          throw e;
        }
      })();
      const acme = resolveE2EAcmeCa(env);
      env.ACME_CA_SERVER = acme.directory;
      expect(k8sIssuerName({ envLocal: { ACME_CA_SERVER: acme.directory } })).toBe(issuer);
      if (r) {
        expect(env.ACME_CA_SERVER).toBe(acme.directory);
        expect(r.tls === null).toBe(!staging);
      }
    }
  });
});

describe('no hard-coded CA URL outside the helper', () => {
  const SKIP = new Set(['node_modules', 'certs', '.git', 'results']);
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|js)$/.test(name)) out.push(p);
    }
    return out;
  };
  it('e2e harness files name the directory URLs only in e2e-env.js', () => {
    const files = [
      ...walk(join(REPO_ROOT, 'tests', 'e2e')),
      join(REPO_ROOT, 'scripts', 'iter-step.js'),
    ];
    const offenders = files
      .filter((f) => !f.endsWith(join('utils', 'e2e-env.js')))
      .filter((f) => /acme(-staging)?-v02\.api\.letsencrypt\.org/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });
});
