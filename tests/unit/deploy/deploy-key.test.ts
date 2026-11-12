/**
 * PR 2 final review C1(a): a deploy of an environment that already has
 * servers, from a machine without its deploy key, used to mint a new key and
 * run the up with it. On DigitalOcean the new key replaced the droplet, and
 * the database on it. requireDeployKey (src/lib/deploy/deploy-key.js) is the
 * one check every key-generating path runs first; this file pins its verdicts
 * and its message. deploy-key-refusal.test.ts drives each mode's generator.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const { DeployKeyMissingError, recordsServers, requireDeployKey } = await import(
  // @ts-expect-error: JS module without types
  '../../../src/lib/deploy/deploy-key.js'
);

/** A project dir, with the deploy key's halves written as asked. */
function project({ privateKey = false, publicKey = false } = {}) {
  const dir = createTempDir('deploy-key-');
  mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
  const keyPath = join(dir, '.vibecarbon', 'deploy_key_prod');
  if (privateKey) writeFileSync(keyPath, 'PRIVATE', { mode: 0o600 });
  if (publicKey) writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAA test');
  return { dir, keyPath };
}

const composeEnv = { servers: [{ name: 'master', id: '42', ip: '203.0.113.5' }] };
const k8sHaEnv = { ha: { primary: { masterIp: '203.0.113.6' }, standby: { masterIp: '' } } };

describe('recordsServers', () => {
  it('an env with no record, or servers with no address, records none', () => {
    expect(recordsServers(undefined)).toBe(false);
    expect(recordsServers({})).toBe(false);
    expect(recordsServers({ servers: [] })).toBe(false);
    expect(recordsServers({ servers: [{ name: 'master', ip: '' }] })).toBe(false);
  });

  it('a servers[] entry with an address records one (compose, compose-ha, k8s)', () => {
    expect(recordsServers(composeEnv)).toBe(true);
    expect(
      recordsServers({ servers: [{ name: 'db' }, { name: 'worker-1', ip: '10.0.0.4' }] }),
    ).toBe(true);
  });

  it("k8s-ha's ha.primary or ha.standby master address records one", () => {
    expect(recordsServers(k8sHaEnv)).toBe(true);
    expect(recordsServers({ ha: { standby: { masterIp: '203.0.113.7' } } })).toBe(true);
  });
});

describe('requireDeployKey', () => {
  it('a first deploy (nothing recorded) goes on without a key: it makes one', () => {
    const { keyPath } = project();
    expect(() => requireDeployKey({ environment: 'prod', envConfig: {}, keyPath })).not.toThrow();
  });

  it('an env with servers and both halves of its key here goes on', () => {
    const { keyPath } = project({ privateKey: true, publicKey: true });
    expect(() =>
      requireDeployKey({ environment: 'prod', envConfig: composeEnv, keyPath }),
    ).not.toThrow();
  });

  /** The refusal's message for `environment`, the key missing in a fresh project. */
  const refusal = (environment = 'prod') => {
    const { dir, keyPath } = project();
    let caught: Error | undefined;
    try {
      requireDeployKey({ environment, envConfig: composeEnv, keyPath, cwd: dir });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(DeployKeyMissingError);
    return String(caught?.message);
  };

  it('an env with servers and no key here stops, naming the file, where it lives, and the rerun', () => {
    const message = refusal();
    expect(message).toContain('.vibecarbon/deploy_key_prod');
    expect(message).toContain('.vibecarbon/deploy_key_prod.pub');
    expect(message).toMatch(/machine that deployed prod/);
    expect(message).toContain('would replace them and lose the data on them');
    expect(message).not.toContain('—');
  });

  it('names the way out when the key is gone for good or the servers are: a destroy, which works without the key, removes what still runs, and keeps the backups', () => {
    const lines = refusal().split('\n');
    // Each command on its own line, nothing after it, so each copies whole.
    expect(lines).toContain('  vibecarbon deploy prod');
    expect(lines.at(-1)).toBe('  vibecarbon destroy prod -force');
    const prose = lines.filter((l) => !l.startsWith('  ')).join(' ');
    expect(prose).toMatch(/If that key is gone for good, or those servers no longer exist/);
    expect(prose).toMatch(/Destroy works without the key/);
    expect(prose).toMatch(/deletes every server of prod that is still running, and the data on it/);
    // Without the key there is no backup first, which -force allows.
    expect(prose).toMatch(/can't back up the database first without the key, so it needs -force/);
    expect(prose).toMatch(/the backups already in your bucket stay/);
    expect(prose).toMatch(/The next deploy then starts fresh, with a new key/);
  });

  it('k8s-ha: the recorded master address alone is enough to stop', () => {
    const { keyPath } = project();
    expect(() => requireDeployKey({ environment: 'prod', envConfig: k8sHaEnv, keyPath })).toThrow(
      DeployKeyMissingError,
    );
  });

  it('one half missing stops too, and names only that half', () => {
    const onlyPrivate = project({ privateKey: true });
    expect(() =>
      requireDeployKey({
        environment: 'prod',
        envConfig: composeEnv,
        keyPath: onlyPrivate.keyPath,
        cwd: onlyPrivate.dir,
      }),
    ).toThrow(/deploy_key_prod\.pub is missing/);
    const onlyPublic = project({ publicKey: true });
    expect(() =>
      requireDeployKey({
        environment: 'prod',
        envConfig: composeEnv,
        keyPath: onlyPublic.keyPath,
        cwd: onlyPublic.dir,
      }),
    ).toThrow(/\.vibecarbon\/deploy_key_prod is missing/);
  });

  it('an HA stack name is named by its environment, as the operator types it', () => {
    const { dir, keyPath } = project();
    expect(() =>
      requireDeployKey({ environment: 'prod-primary', envConfig: k8sHaEnv, keyPath, cwd: dir }),
    ).toThrow(/\n {2}vibecarbon deploy prod\n[\s\S]*\n {2}vibecarbon destroy prod -force$/);
  });
});
