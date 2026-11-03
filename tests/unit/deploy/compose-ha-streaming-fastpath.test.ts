/**
 * Compose-HA replication fast path (HA-correctness Task 8, M1).
 *
 * `configureStandbyReplication` wipes the standby's PGDATA and re-seeds it, so
 * a deploy must not run it against a standby that already streams from the
 * current primary (the k8s tier has always probed first). The probe is the
 * shared one: pg_stat_replication on the primary.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SYSID = '7412345678901234567';
/** The lineage read's answer (readComposeDbLineage): ready, then the row. */
const lineage = (row: string) => `ready=1\nlineage=${row}\n`;

const h = vi.hoisted(() => ({
  state: '' as string | false,
  /** Each node's lineage answer, by ip. */
  lineage: {} as Record<string, string>,
  commands: [] as string[],
  reseed: vi.fn(async () => true),
  primary: vi.fn(async () => {}),
}));

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const quiet = () => {};
  return {
    ...actual,
    log: { info: quiet, warn: quiet, success: quiet, message: quiet, error: quiet, step: quiet },
  };
});

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = async (ip: string, _k: string, command: unknown) => {
    h.commands.push(String(command));
    if (String(command).includes('pg_control_system')) return h.lineage[ip] ?? '';
    return String(command).includes('pg_stat_replication') ? h.state : '';
  };
  return { ...actual, sshRun: vi.fn(rec), sshRunAsync: vi.fn(rec), sshRunChecked: vi.fn(rec) };
});

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    configurePrimaryReplication: h.primary,
    configureStandbyReplication: h.reseed,
  };
});

vi.mock('../../../src/lib/deploy/replication.js', async (orig) => {
  const actual = (await orig()) as Record<string, (o: object) => unknown>;
  return {
    ...actual,
    probeStreaming: (opts: object) =>
      actual.probeStreaming({ ...opts, attempts: 1, sleep: async () => {} }),
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

const ctx = () =>
  ({
    projectConfig: { projectName: 'myapp' },
    environment: 'prod',
    primary: { ip: '203.0.113.10', stack: 'primary' },
    standby: { ip: '203.0.113.20', stack: 'standby' },
    sshKeyPath: '/tmp/never-used-key',
    onProgress: () => {},
  }) as Record<string, unknown>;

const run = () =>
  (
    COMPOSE_HA_EFFECTS as Record<string, (c: Record<string, unknown>) => Promise<void>>
  ).haConfigureReplication(ctx());

describe('compose-HA deploy: reseed only a standby that is not streaming', () => {
  beforeEach(() => {
    h.commands.length = 0;
    h.reseed.mockClear();
    h.primary.mockClear();
    // A fresh standby (its own initdb) and the primary on timeline 2.
    h.lineage = {
      '203.0.113.20': lineage('f|7000000000000000001|00000001'),
      '203.0.113.10': lineage(`f|${SYSID}|00000002`),
    };
  });

  it('a streaming standby is left alone', async () => {
    h.state = 'streaming';
    await run();
    expect(h.primary).toHaveBeenCalledTimes(1);
    expect(h.reseed).not.toHaveBeenCalled();
  });

  it('a standby that is not streaming is reseeded once', async () => {
    h.state = '';
    await run();
    expect(h.reseed).toHaveBeenCalledTimes(1);
  });

  it('a catching-up standby is reseeded too: only streaming counts', async () => {
    h.state = 'catchup';
    await run();
    expect(h.reseed).toHaveBeenCalledTimes(1);
  });

  it('an unreadable primary reads as not streaming', async () => {
    h.state = false;
    await run();
    expect(h.reseed).toHaveBeenCalledTimes(1);
  });
});

describe('compose-HA deploy: the lineage check before the reseed (final review I1)', () => {
  let dir: string;
  const RECORD = { ip: '203.0.113.20', systemIdentifier: SYSID, timeline: 3, at: 't' };
  const seed = (ha: Record<string, unknown>) => {
    dir = mkdtempSync(join(tmpdir(), 'vc-lineage-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'myapp', environments: { prod: { ha } } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  };
  const haOnDisk = () =>
    JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).environments.prod.ha;
  beforeEach(() => {
    h.commands.length = 0;
    h.reseed.mockClear();
    h.reseed.mockImplementation(async () => true);
    h.state = '';
    // The aborted failover's promote landed: the standby runs timeline 3 of
    // the primary's database, which is still on timeline 2.
    h.lineage = {
      '203.0.113.20': lineage(`f|${SYSID}|00000003`),
      '203.0.113.10': lineage(`f|${SYSID}|00000002`),
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('abort then deploy: the copy the abort recorded is reseeded, and the record is cleared', async () => {
    seed({ enabled: true, discardableStandby: RECORD });
    await run();
    expect(h.reseed).toHaveBeenCalledTimes(1);
    expect(haOnDisk()).toEqual({ enabled: true });
  });

  it('an unrecorded promotion still refuses, before the reseed', async () => {
    seed({ enabled: true });
    await expect(run()).rejects.toThrow(
      /standby 203\.0\.113\.20 looks promoted outside vibecarbon[\s\S]*timeline 3[\s\S]*timeline 2[\s\S]*Nothing was staged or stopped/,
    );
    expect(h.reseed).not.toHaveBeenCalled();
  });

  it('a record for a different lineage does not unlock', async () => {
    seed({
      enabled: true,
      discardableStandby: { ...RECORD, systemIdentifier: '7000000000000000009' },
    });
    await expect(run()).rejects.toThrow(/looks promoted outside vibecarbon/);
    expect(h.reseed).not.toHaveBeenCalled();
    expect(haOnDisk().discardableStandby).toBeTruthy();
  });

  it('a failed reseed keeps the record for the rerun', async () => {
    seed({ enabled: true, discardableStandby: RECORD });
    h.reseed.mockImplementation(async () => false);
    await run();
    expect(haOnDisk().discardableStandby).toEqual(RECORD);
  });

  it('a standby whose lineage cannot be read is not reseeded blind', async () => {
    seed({ enabled: true, discardableStandby: RECORD });
    h.lineage['203.0.113.20'] = 'ready=0\nlineage=\n';
    await expect(run()).rejects.toThrow(/did not accept connections within 60s/);
    expect(h.reseed).not.toHaveBeenCalled();
  });

  it('the read waits (bounded) for the db, then reads in its container, one sh -c token', async () => {
    seed({ enabled: true, discardableStandby: RECORD });
    await run();
    const reads = h.commands.filter((c) => c.includes('pg_control_system'));
    expect(reads).toHaveLength(2);
    for (const cmd of reads) {
      expect(cmd).toMatch(/^cd \/opt\/myapp && docker compose exec -T db sh -c '/);
      expect(cmd).toContain('while [ "$vc_i" -lt 60 ]');
      expect(cmd).toContain('pg_isready -q -h 127.0.0.1 -U postgres');
    }
  });
});
