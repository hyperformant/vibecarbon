/**
 * The interrupted-fence marker (HA-correctness Task 3, fix round 2).
 *
 * A planned failover interrupted between its database write fence and its
 * journal (SIGINT exits 130, an ssh drop) would leave a primary that never
 * failed over silently read-only. The fence is recorded before it is applied
 * (envConfig.ha.writeFence), and failover, deploy and status act on it:
 *   - marker, no journal: failover rerun and deploy lift it, one line each;
 *   - journal present: left to the journal flow; deploy refuses a fenced
 *     primary and names vibecarbon failover;
 *   - status shows a "database write-fenced" row.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withSshContract } from '../../_shared/ssh-contract.js';

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(async () => ''),
}));

const {
  assertRolePrimaryWritable,
  clearWriteFenceMarker,
  liftStrandedWriteFence,
  readWriteFence,
  writeWriteFenceMarker,
} = await import('../../../src/lib/deploy/write-fence.js');
const { swapComposeHaRoles } = await import('../../../src/lib/deploy/compose/ha.js');
const { swapHaRoles } = await import('../../../src/failover.js');
const { writeFenceRow, checkReplication } = await import('../../../src/status.js');

const PRIMARY = { name: 'myapp-prod-primary', ip: '10.0.0.1' };
const JOURNAL = { target: 'standby', systemIdentifier: '7412345678901234567' };
const MARKER = { node: PRIMARY.name, ip: PRIMARY.ip, at: '2026-10-20T00:00:00.000Z' };

const recorder = (liftOk = true) => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      unfence: async () => {
        calls.push('unfence');
        return liftOk;
      },
      clearMarker: () => {
        calls.push('clearMarker');
      },
    },
  };
};

describe('marker persistence', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const seed = (env: Record<string, unknown>) => {
    dir = mkdtempSync(join(tmpdir(), 'vc-fence-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'myapp', environments: { prod: env } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  };
  const readEnv = () =>
    JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).environments.prod;

  it('writes { node, ip, at } through the config save, keeping the rest of ha; clear removes only it', () => {
    seed({ ha: { enabled: true, systemIdentifier: 'x' } });
    writeWriteFenceMarker({ environment: 'prod' }, { node: PRIMARY.name, ip: PRIMARY.ip });
    expect(readEnv().ha).toEqual({
      enabled: true,
      systemIdentifier: 'x',
      writeFence: { node: PRIMARY.name, ip: PRIMARY.ip, at: expect.any(String) },
    });
    clearWriteFenceMarker({ environment: 'prod' });
    expect(readEnv().ha).toEqual({ enabled: true, systemIdentifier: 'x' });
  });

  it('the compose role-swap save of a completed failover clears the marker with the journal', () => {
    seed({
      deployMode: 'compose-ha',
      servers: [
        { name: 'myapp-prod-primary', role: 'primary', ip: '10.0.0.1', region: 'nbg1' },
        { name: 'myapp-prod-standby', role: 'standby', ip: '10.0.0.2', region: 'ash' },
      ],
      ha: { enabled: true, failoverInFlight: JOURNAL, writeFence: MARKER },
    });
    swapComposeHaRoles('prod');
    expect(readEnv().ha.writeFence).toBeUndefined();
    expect(readEnv().ha.failoverInFlight).toBeUndefined();
  });

  it('the k8s role-swap save clears it too', () => {
    seed({
      region: 'nbg1',
      secondaryRegion: 'ash',
      ha: {
        enabled: true,
        primary: { masterIp: '10.0.0.1', region: 'nbg1' },
        standby: { masterIp: '10.0.0.9', region: 'ash' },
        failoverInFlight: JOURNAL,
        writeFence: MARKER,
      },
    });
    swapHaRoles('prod');
    expect(readEnv().ha.writeFence).toBeUndefined();
  });
});

describe('liftStrandedWriteFence (failover rerun and deploy entry)', () => {
  it('no marker: nothing to do, no ssh', async () => {
    const r = recorder();
    const exec = vi.fn();
    await expect(
      liftStrandedWriteFence({
        environment: 'prod',
        envConfig: { ha: {} },
        rolePrimary: PRIMARY,
        exec,
        log: () => {},
        deps: r.deps,
      }),
    ).resolves.toBe('none');
    expect(r.calls).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('SIGINT-equivalent (marker, no journal): lifts it on the role primary, clears the marker, one line', async () => {
    const r = recorder();
    const log = vi.fn();
    await expect(
      liftStrandedWriteFence({
        environment: 'prod',
        envConfig: { ha: { writeFence: MARKER } },
        rolePrimary: PRIMARY,
        exec: vi.fn(),
        log,
        deps: r.deps,
      }),
    ).resolves.toBe('lifted');
    expect(r.calls).toEqual(['unfence', 'clearMarker']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/lifted the write fence an interrupted failover left/);
    expect(log.mock.calls[0][0]).not.toMatch(/—/);
  });

  it('journal present: left to the journal flow (the promote may have started)', async () => {
    const r = recorder();
    await expect(
      liftStrandedWriteFence({
        environment: 'prod',
        envConfig: { ha: { writeFence: MARKER, failoverInFlight: JOURNAL } },
        rolePrimary: PRIMARY,
        exec: vi.fn(),
        log: () => {},
        deps: r.deps,
      }),
    ).resolves.toBe('journal');
    expect(r.calls).toEqual([]);
  });

  it('a marker on a node that is no longer the primary is stale: cleared, never lifted', async () => {
    const r = recorder();
    await expect(
      liftStrandedWriteFence({
        environment: 'prod',
        envConfig: { ha: { writeFence: MARKER } },
        rolePrimary: { name: 'myapp-prod-standby', ip: '10.0.0.2' },
        exec: vi.fn(),
        log: () => {},
        deps: r.deps,
      }),
    ).resolves.toBe('stale');
    expect(r.calls).toEqual(['clearMarker']);
  });

  it('a lift that cannot be proven throws one line with the manual fix and keeps the marker', async () => {
    const r = recorder(false);
    await expect(
      liftStrandedWriteFence({
        environment: 'prod',
        envConfig: { ha: { writeFence: MARKER } },
        rolePrimary: PRIMARY,
        exec: vi.fn(),
        log: () => {},
        deps: r.deps,
      }),
    ).rejects.toThrow(/still write-fenced .* could not be lifted; .*ALTER SYSTEM RESET/);
    expect(r.calls).toEqual(['unfence']);
  });
});

describe('assertRolePrimaryWritable (deploy, after bring-up)', () => {
  const run = (state: 'on' | 'off' | null, envConfig: Record<string, unknown>, liftOk = true) => {
    const r = recorder(liftOk);
    const warn = vi.fn();
    const p = assertRolePrimaryWritable({
      environment: 'prod',
      envConfig,
      exec: vi.fn(),
      warn,
      deps: { ...r.deps, read: async () => state },
    });
    return { p, r, warn };
  };

  it('a writable primary passes untouched', async () => {
    const { p, r } = run('off', { ha: {} });
    await expect(p).resolves.toBe('writable');
    expect(r.calls).toEqual([]);
  });

  it('an unreadable setting is reported unknown, never lifted', async () => {
    const { p, r } = run(null, { ha: {} });
    await expect(p).resolves.toBe('unknown');
    expect(r.calls).toEqual([]);
  });

  it('fenced with no journal (SIGINT-equivalent): lifts, clears the marker, warns', async () => {
    const { p, r, warn } = run('on', { ha: { writeFence: MARKER } });
    await expect(p).resolves.toBe('lifted');
    expect(r.calls).toEqual(['unfence', 'clearMarker']);
    expect(warn.mock.calls[0][0]).toMatch(/write-fenced with no failover in flight; lifted it/);
  });

  it('fenced with a journal: refuses and names vibecarbon failover', async () => {
    const { p, r } = run('on', { ha: { writeFence: MARKER, failoverInFlight: JOURNAL } });
    await expect(p).rejects.toThrow(
      /write-fenced by a failover still in flight; rerun `vibecarbon failover prod` to finish it, or run `vibecarbon failover prod -abort`/,
    );
    expect(r.calls).toEqual([]);
  });

  it('a lift that fails refuses the deploy with the manual fix', async () => {
    const { p } = run('on', { ha: {} }, false);
    await expect(p).rejects.toThrow(/could not be lifted; .*rerun vibecarbon deploy/);
  });

  it('readWriteFence parses on/off and nothing else', async () => {
    await expect(readWriteFence(async () => 'on\n')).resolves.toBe('on');
    await expect(readWriteFence(async () => 'off')).resolves.toBe('off');
    await expect(readWriteFence(async () => '')).resolves.toBeNull();
    await expect(
      readWriteFence(async () => {
        throw new Error('ssh');
      }),
    ).resolves.toBeNull();
  });
});

describe('deploy wires both checks (census)', () => {
  it('orchestrator lifts a stranded marker at entry and probes the role primary after bring-up', () => {
    const src = readFileSync(join(__dirname, '../../../src/lib/deploy/orchestrator.js'), 'utf-8');
    const entry = src.indexOf('await liftStrandedFenceAtEntry({');
    // A journaled scale cutover is refused before the lift ever reads the marker.
    expect(
      src.indexOf("assertNoScaleCutoverInFlight({ environment, envConfig, action: 'deploy' })"),
    ).toBeGreaterThan(-1);
    expect(
      src.indexOf("assertNoScaleCutoverInFlight({ environment, envConfig, action: 'deploy' })"),
    ).toBeLessThan(entry);
    const roleSwap = src.indexOf(
      'assertNoComposeHaRoleSwap({ projectName: projectConfig.projectName',
    );
    const plan = src.indexOf("runPlan(planDeploy('compose-ha'");
    const probe = src.indexOf('await assertRolePrimaryWritable(');
    expect(entry, 'deploy never lifts a stranded write fence').toBeGreaterThan(roleSwap);
    expect(entry).toBeLessThan(plan);
    expect(probe, 'deploy never probes the role primary').toBeGreaterThan(plan);
    expect(probe).toBeLessThan(src.indexOf('const finalConfig = {'));
  });
});

describe('status shows a write-fenced primary', () => {
  it('a journaled scale cutover names the env in its resume command', () => {
    expect(
      writeFenceRow(
        { ha: { writeFence: { ip: '1.1.1.1', source: 'scale', cutover: { newIp: '9.9.9.9' } } } },
        null,
        'prod',
      ),
    ).toMatch(
      /a compose scale stopped mid-cutover; rerun vibecarbon scale prod to finish or roll it back/,
    );
  });

  it('the row appears for a marker, or a primary that reads read-only, and names the fix', () => {
    expect(writeFenceRow({ ha: {} }, { writeFenced: 'off' })).toBeNull();
    expect(writeFenceRow({ ha: {} }, null)).toBeNull();
    expect(writeFenceRow({ ha: { writeFence: MARKER } }, null)).toMatch(
      /^database write-fenced: .*an interrupted failover or scale left it; vibecarbon deploy lifts it/,
    );
    expect(writeFenceRow({ ha: {} }, { writeFenced: 'on' })).toMatch(/database write-fenced/);
    expect(writeFenceRow({ ha: { writeFence: MARKER, failoverInFlight: JOURNAL } }, null)).toMatch(
      /a failover is in flight; vibecarbon failover finishes it/,
    );
  });

  it('checkReplication reads the primary with SHOW (no quoted SQL) into writeFenced', async () => {
    const sshKubectl = vi.fn(async (_ip: string, _k: string, argv: string[]) =>
      argv[argv.length - 1] === 'SHOW default_transaction_read_only' ? 'on' : '',
    );
    const r = await checkReplication(
      'prod',
      {
        deployMode: 'kubernetes',
        ha: { enabled: true },
        servers: [{ name: 'p', role: 'primary', ip: '10.0.0.1' }],
      },
      'myapp',
      {
        sshKubectl,
        getPostgresPod: vi.fn(async () => 'db-0'),
        // Never reached on k8s, but held to ssh.js's argv contract all the same.
        sshRun: withSshContract(vi.fn()),
        getSSHKeyPath: () => __filename,
        timeoutMs: 5000,
      },
    );
    expect(r?.writeFenced).toBe('on');
  });
});
