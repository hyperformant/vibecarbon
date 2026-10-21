/**
 * Task 6: a pilot-light failover reads the standby's app image live, before
 * the first write (`liftStranded`), and applies the same rule as the recorded
 * `standby-image-missing` cause: a planned failover refuses (a deploy copies
 * it while the primary is up), an unplanned one refuses naming
 * -force-unproven, and with that flag it promotes with a loud warning. A
 * check that cannot read the registry counts as missing. A journal resume
 * skips the check (R6): a half-done failover must be finishable.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failoverHA } from '../../../src/failover.js';
import {
  assertStandbyHasAppImage,
  buildStandbyImageCheckScript,
} from '../../../src/lib/deploy/k8s/ha/image-copy.js';
import { MANIFEST_DIGEST_SH } from '../../../src/lib/deploy/k8s/image-delivery.js';

describe('assertStandbyHasAppImage', () => {
  it('returns the digest of a local-registry image', async () => {
    const run = vi.fn(async () => 'IMAGE=10.0.1.1:5000/quorum:t1\nDIGEST=sha256:aa');
    await expect(assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run })).resolves.toBe(
      'sha256:aa',
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(buildStandbyImageCheckScript());
  });

  it('refuses when the registry lacks it, naming the ref', async () => {
    const run = vi.fn(async () => 'IMAGE=10.0.1.1:5000/quorum:t1\nDIGEST=');
    const err = await assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run }).catch(
      (e) => e,
    );
    expect(err.message).toBe(
      'standby registry lacks the app image 10.0.1.1:5000/quorum:t1; redeploy (vibecarbon deploy) while the primary is up',
    );
    expect(err.standbyImage).toEqual({ state: 'missing', ref: '10.0.1.1:5000/quorum:t1' });
  });

  it('an external image needs no registry', async () => {
    const run = vi.fn(async () => 'IMAGE=ghcr.io/o/r:main');
    await expect(assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run })).resolves.toBe(
      'external',
    );
  });

  it('an unreadable deployment is its own one-line failure', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: ssh'), {
        stderr: 'Error from server (NotFound): deployments.apps "app" not found\n',
      });
    });
    const err = await assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run }).catch(
      (e) => e,
    );
    expect(err.message).toMatch(
      /^could not read the standby app image: Error from server \(NotFound\)/,
    );
    expect(err.message).not.toContain('\n');
    expect(err.standbyImage).toEqual({
      state: 'unknown',
      cause: 'Error from server (NotFound): deployments.apps "app" not found',
    });
  });

  it('output with no IMAGE line is unreadable, not present', async () => {
    const run = vi.fn(async () => '');
    await expect(
      assertStandbyHasAppImage({ standbyIp: 'S', sshKeyPath: '/k', run }),
    ).rejects.toThrow(/^could not read the standby app image: /);
  });
});

describe('buildStandbyImageCheckScript (executed against stub kubectl and curl)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function runScript(kubectl: string, curl: string) {
    dir = mkdtempSync(join(tmpdir(), 'image-check-stub-'));
    for (const [name, body] of [
      ['kubectl', kubectl],
      ['curl', curl],
    ]) {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    }
    return spawnSync('sh', ['-s'], {
      input: buildStandbyImageCheckScript(),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  }

  it('reuses the shared digest helper', () => {
    expect(buildStandbyImageCheckScript()).toContain(MANIFEST_DIGEST_SH);
  });

  it('prints the image and its digest for a local-registry ref', () => {
    const r = runScript(
      'echo 10.0.1.1:5000/quorum:t1',
      // Only the tag the image names answers.
      'case "$*" in *http://10.0.1.1:5000/v2/quorum/manifests/t1*) printf "HTTP/1.1 200 OK\\r\\nDocker-Content-Digest: sha256:aa\\r\\n";; *) exit 22;; esac',
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      'IMAGE=10.0.1.1:5000/quorum:t1',
      'DIGEST=sha256:aa',
    ]);
  });

  it('prints an empty digest when the registry has no such tag', () => {
    const r = runScript('echo 10.0.1.1:5000/quorum:t1', 'exit 22');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['IMAGE=10.0.1.1:5000/quorum:t1', 'DIGEST=']);
  });

  it('does not touch a registry for an external image', () => {
    const r = runScript('echo ghcr.io/o/r:main', 'echo curl-called >&2; exit 1');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('IMAGE=ghcr.io/o/r:main');
    expect(r.stderr).not.toContain('curl-called');
  });

  it('fails with kubectl stderr when the deployment cannot be read', () => {
    const r = runScript('echo "Error from server (NotFound): nope" >&2; exit 1', 'exit 1');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Error from server (NotFound): nope');
    expect(r.stdout).not.toContain('IMAGE=');
  });
});

// ---------------------------------------------------------------------------
// failoverHA: where the live check sits and what it decides.
// ---------------------------------------------------------------------------

const SYSID = '7412345678901234567';
const MISSING = Object.assign(
  new Error(
    'standby registry lacks the app image 10.0.1.9:5000/quorum:t1; redeploy (vibecarbon deploy) while the primary is up',
  ),
  { standbyImage: { state: 'missing', ref: '10.0.1.9:5000/quorum:t1' } },
);
const UNREADABLE = Object.assign(
  new Error('could not read the standby app image: ssh: connect to host 10.0.0.9 port 22: refused'),
  { standbyImage: { state: 'unknown', cause: 'ssh: connect to host 10.0.0.9 port 22: refused' } },
);

interface Run {
  primaryReachable: boolean;
  image?: Error | null;
  forceUnproven?: boolean;
  journal?: boolean;
  recordedMissing?: boolean;
  present?: string;
}

async function runFailover({
  primaryReachable,
  image = null,
  forceUnproven,
  journal,
  recordedMissing,
  present = 'sha256:aa',
}: Run) {
  const order: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  let thrown: unknown;
  const servers = {
    primary: { ip: '10.0.0.1', floatingIp: '10.0.0.1', region: 'nbg1' },
    standby: { ip: '10.0.0.9', floatingIp: '10.0.0.99', dbIp: '10.0.0.10', region: 'ash' },
  };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    order.push(`exit(${code})`);
    throw new Error('__exit__');
  }) as never);
  const errSpy = vi.spyOn(p.log, 'error').mockImplementation((m) => {
    errors.push(String(m));
  });
  const warnSpy = vi.spyOn(p.log, 'warn').mockImplementation((m) => {
    warns.push(String(m));
  });
  const step =
    <T>(name: string, value?: T) =>
    async () => {
      order.push(name);
      return value;
    };
  const assertStandbyImage = vi.fn(async (srv: { standby: { ip: string } }, key: string) => {
    order.push(`assertStandbyImage(${srv.standby.ip},${key})`);
    if (image) throw image;
    return present;
  });
  const deps = {
    identify: () => servers,
    getKeyPath: () => '/fake/key',
    keyExists: () => true,
    preflight: async () => {
      order.push('preflight');
      return {
        workerSpec: { count: 2, serverType: 'cx23' },
        scaleUpList: [{ name: 'app', namespace: 'vibecarbon', replicas: 2 }],
        standbyStack: 'e4-standby',
        creds: { apiToken: 't' },
      };
    },
    assertStandbyImage,
    isPrimaryReady: async () => {
      order.push('isPrimaryReady');
      return primaryReachable;
    },
    liftStranded: step('liftStranded', 'none'),
    readStandbyState: async () => ({
      inRecovery: !journal,
      systemIdentifier: SYSID,
      replayLsn: '0/3000060',
      receiverStatus: primaryReachable ? 'streaming' : null,
      lastMsgAgeS: primaryReachable ? 1 : null,
    }),
    readPrimaryState: async () => ({
      inRecovery: false,
      systemIdentifier: SYSID,
      replayLsn: null,
      receiverStatus: null,
      lastMsgAgeS: null,
    }),
    provision: step('provision', { provisioned: true }),
    confirmQuiesced: async () => {
      order.push('confirmQuiesced');
      return { ok: true, remaining: [] };
    },
    fenceWrites: async () => {},
    unfenceWrites: async () => true,
    assertUnfenced: async () => {},
    writeMarker: () => {},
    clearMarker: () => {},
    catchUp: async () => ({ caughtUp: true, lagBytes: 0, primaryLsn: '0/3000060' }),
    reseed: async () => {},
    writeJournal: async () => 'journal-id',
    clearJournal: async () => {},
    promote: step('promote', 'promoted'),
    confirmUnproven: async () => {},
    scale: async (_ip: string, _key: string, _list: unknown, _n: unknown, label: string) => {
      order.push(`scale:${label}`);
    },
    restoreWalgRole: async () => ({ promoted: { ok: true }, demoted: { ok: true } }),
    gate: async () => {},
    promoteIssuer: async () => ({ patched: [] }),
    addonRollouts: async () => ({ notReady: [] }),
    writeFence: async () => ({ ok: true }),
    recordFence: () => {},
    swapRoles: () => {
      order.push('saveConfig');
    },
    reconcileRetired: async () => ({ fenced: [], unreachable: [] }),
    pushBaseBackup: async () => ({ name: 'base_1' }),
  };
  let flippedTo: string | null = null;
  const strategy = {
    getAuth: async () => ({ token: 't', zoneId: 'z' }),
    updateDns: async (_a: unknown, _d: string, ip: string) => {
      flippedTo = ip;
    },
    readDns: async () => (flippedTo ? [flippedTo] : []),
  };
  const envConfig = {
    domain: 'app.example.com',
    region: 'nbg1',
    secondaryRegion: 'ash',
    replication: 'streaming',
    ...(recordedMissing && { degraded: true, degradedCause: 'standby-image-missing' }),
    ha: {
      primary: { masterIp: '10.0.0.1' },
      standby: { masterIp: '10.0.0.9' },
      systemIdentifier: SYSID,
      ...(journal && {
        failoverInFlight: {
          id: 'j1',
          target: 'standby',
          startedAt: '2026-10-21T00:00:00Z',
          primaryLsn: null,
          systemIdentifier: SYSID,
        },
      }),
    },
  };
  const parsed = { dryRun: false, yes: true, serverType: null, forceUnproven: !!forceUnproven };
  const tracker = { spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }) };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
    await failoverHA('e4', envConfig, {}, parsed, tracker, strategy, deps as any);
  } catch (err) {
    /* exits throw; the order array is recorded */
    thrown = err;
  } finally {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  }
  return { order, errors, warns, assertStandbyImage, thrown };
}

const WRITES = ['liftStranded', 'provision', 'confirmQuiesced', 'promote'];
const touched = (order: string[]) =>
  order.filter((s) => WRITES.includes(s) || s.startsWith('scale:'));

describe('failoverHA: the live standby image check', () => {
  it('runs once, against the standby master, after preflight and before the first write', async () => {
    const { order, assertStandbyImage } = await runFailover({ primaryReachable: true });
    expect(assertStandbyImage).toHaveBeenCalledTimes(1);
    const at = order.indexOf('assertStandbyImage(10.0.0.9,/fake/key)');
    expect(at).toBeGreaterThan(order.indexOf('preflight'));
    expect(at).toBeLessThan(order.indexOf('liftStranded'));
    expect(order).toContain('promote');
  });

  it('planned, image missing: exits 1 naming the ref and the deploy, nothing touched', async () => {
    const { order, errors } = await runFailover({ primaryReachable: true, image: MISSING });
    expect(order).toContain('exit(1)');
    expect(touched(order)).toEqual([]);
    // The command ends the message on its own line, so it copies cleanly.
    expect(errors.join('\n')).toMatch(
      /^Failover refused: .*10\.0\.1\.9:5000\/quorum:t1.*run this to copy it, then fail over:\n {2}vibecarbon deploy e4$/,
    );
  });

  it('planned, registry unreadable: exits 1 with the cause, nothing touched', async () => {
    const { order, errors } = await runFailover({ primaryReachable: true, image: UNREADABLE });
    expect(order).toContain('exit(1)');
    expect(touched(order)).toEqual([]);
    expect(errors.join('\n')).toBe(
      'Failover refused: could not read the standby app image (ssh: connect to host 10.0.0.9 ' +
        'port 22: refused), so nothing proves a promoted standby could start the app. Fix ' +
        'ssh/kubectl access to the standby master, then fail over again.',
    );
    // A deploy does not fix an unreachable standby master.
    expect(errors.join('\n')).not.toMatch(/vibecarbon deploy/);
  });

  it('unplanned without -force-unproven, image missing: exits 1 naming the flag, not a deploy', async () => {
    const { order, errors } = await runFailover({ primaryReachable: false, image: MISSING });
    expect(order).toContain('exit(1)');
    expect(touched(order)).toEqual([]);
    expect(errors.join('\n')).toMatch(
      /primary is unreachable, so no deploy can copy it there now.*-force-unproven/,
    );
    expect(errors.join('\n')).not.toMatch(/run vibecarbon deploy/);
  });

  it('unplanned without -force-unproven, registry unreadable: names the cause and the flag', async () => {
    const { order, errors } = await runFailover({ primaryReachable: false, image: UNREADABLE });
    expect(order).toContain('exit(1)');
    expect(touched(order)).toEqual([]);
    const msg = errors.join('\n');
    expect(msg).toMatch(/^Failover refused: could not read the standby app image \(ssh: connect/);
    expect(msg).toMatch(/Fix ssh\/kubectl access to the standby master.*-force-unproven/);
    expect(msg).not.toMatch(/no deploy can copy it/);
    expect(msg).not.toMatch(/vibecarbon deploy/);
  });

  it('unplanned with -force-unproven: promotes, warning once with the command on its own line', async () => {
    const { order, warns } = await runFailover({
      primaryReachable: false,
      image: MISSING,
      forceUnproven: true,
    });
    expect(order).not.toContain('exit(1)');
    expect(order).toContain('promote');
    const imageWarns = warns.filter((w) => /app image/.test(w));
    expect(imageWarns).toHaveLength(1);
    expect(imageWarns[0].split('\n')).toContain('  vibecarbon deploy e4');
    expect(imageWarns[0]).toMatch(/the promoted standby has no app image; it serves nothing until/);
  });

  it('a recorded cause the live check confirms warns once, not twice', async () => {
    const { order, warns } = await runFailover({
      primaryReachable: false,
      image: MISSING,
      forceUnproven: true,
      recordedMissing: true,
    });
    expect(order).toContain('promote');
    expect(warns.filter((w) => /app image/.test(w))).toHaveLength(1);
  });

  it('a live "present" overrides a recorded cause: a planned failover proceeds', async () => {
    const { order, thrown } = await runFailover({ primaryReachable: true, recordedMissing: true });
    expect(thrown).toBeUndefined();
    expect(order).not.toContain('exit(1)');
    expect(order).toContain('promote');
  });

  it('a live "external" image overrides a recorded cause too', async () => {
    const { order, thrown } = await runFailover({
      primaryReachable: true,
      recordedMissing: true,
      present: 'external',
    });
    expect(thrown).toBeUndefined();
    expect(order).toContain('promote');
  });

  it('unplanned -force-unproven, recorded cause, live present: no image warning', async () => {
    const { order, warns } = await runFailover({
      primaryReachable: false,
      recordedMissing: true,
      forceUnproven: true,
    });
    expect(order).toContain('promote');
    expect(warns.filter((w) => /app image/.test(w))).toEqual([]);
  });

  it('an unreadable registry under -force-unproven warns that it may have no image', async () => {
    const { order, warns } = await runFailover({
      primaryReachable: false,
      image: UNREADABLE,
      forceUnproven: true,
    });
    expect(order).toContain('promote');
    const imageWarns = warns.filter((w) => /app image/.test(w));
    expect(imageWarns).toHaveLength(1);
    expect(imageWarns[0].split('\n')).toEqual([
      'the promoted standby may have no app image; if it has none it serves nothing until',
      '  vibecarbon deploy e4',
      'builds it there',
    ]);
  });

  it('a journal resume skips the check and proceeds after the promote (R6)', async () => {
    const { order, assertStandbyImage } = await runFailover({
      primaryReachable: false,
      image: MISSING,
      journal: true,
      recordedMissing: true,
    });
    expect(assertStandbyImage).not.toHaveBeenCalled();
    expect(order).not.toContain('exit(1)');
    expect(order).not.toContain('promote');
    expect(order).toContain('saveConfig');
  });
});
