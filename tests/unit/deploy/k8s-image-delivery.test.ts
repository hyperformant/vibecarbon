import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_ACCEPT,
  MANIFEST_DIGEST_SH,
  parseLocalRegistryRef,
  planImageDelivery,
  standbyImageRef,
} from '../../../src/lib/deploy/k8s/image-delivery.js';

describe('image-delivery helpers', () => {
  it('parses a local-registry ref', () => {
    expect(parseLocalRegistryRef('10.0.1.1:5000/quorum:abc123-20261020T120000Z')).toEqual({
      host: '10.0.1.1:5000',
      repo: 'quorum',
      tag: 'abc123-20261020T120000Z',
      repoTag: 'quorum:abc123-20261020T120000Z',
    });
  });
  it('refuses a non-local ref and a tagless one', () => {
    expect(() => parseLocalRegistryRef('ghcr.io/o/r:main')).toThrow(/not a local-registry ref/);
    expect(() => parseLocalRegistryRef('10.0.1.1:5000/quorum')).toThrow(/not a local-registry ref/);
  });
  it('re-prefixes the primary ref for the standby registry', () => {
    expect(
      standbyImageRef({
        primaryRef: '10.110.0.2:5000/quorum:t1',
        standbyMasterPrivateIp: '10.120.0.3',
      }),
    ).toBe('10.120.0.3:5000/quorum:t1');
    expect(() =>
      standbyImageRef({ primaryRef: '10.0.1.1:5000/q:t', standbyMasterPrivateIp: '' }),
    ).toThrow(/standbyMasterPrivateIp is required/);
  });
  it('plans delivery by role', () => {
    const operator = { build: true, sideload: true, registryPush: true, awaitPeerImage: false };
    expect(planImageDelivery({ role: 'standby' })).toEqual({
      build: false,
      sideload: false,
      registryPush: false,
      awaitPeerImage: true,
    });
    expect(planImageDelivery({ role: 'primary' })).toEqual(operator);
    expect(planImageDelivery({})).toEqual(operator);
  });
  it('the digest helper sends the full Accept list and reads the header case-insensitively', () => {
    expect(MANIFEST_DIGEST_SH).toContain(MANIFEST_ACCEPT);
    expect(MANIFEST_DIGEST_SH).toMatch(/curl -fsSI/);
    expect(MANIFEST_DIGEST_SH).toContain('tolower($1)=="docker-content-digest"');
  });
});

describe('MANIFEST_DIGEST_SH runs', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function runDigest(stubBody: string) {
    dir = mkdtempSync(join(tmpdir(), 'digest-stub-'));
    const curl = join(dir, 'curl');
    writeFileSync(curl, `#!/bin/sh\n${stubBody}\n`);
    chmodSync(curl, 0o755);
    return spawnSync('sh', ['-c', `${MANIFEST_DIGEST_SH}; digest h r t`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  }

  it('prints the Docker-Content-Digest value', () => {
    const r = runDigest(`printf 'HTTP/1.1 200 OK\\r\\ndocker-content-digest: sha256:aa\\r\\n'`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('sha256:aa\n');
  });
  it('prints nothing and exits 0 on a 404', () => {
    const r = runDigest('exit 22');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
