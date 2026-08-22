import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildWalSwitchProbe,
  buildWalSwitchRemoteCommand,
  FORBIDDEN_ROLE_PREFIXES,
  parseWalSwitchOutput,
  resolveBackupS3Target,
  resolveObjectStorageCreds,
  runBackupEvidenceChecks,
  WALG_BASEBACKUP_SUBDIR,
  WALG_WAL_SUBDIR,
  walgPrefixFor,
  walSegmentKeyPrefix,
} from '../../e2e/checks/backup-evidence.js';

/**
 * The backup-evidence check asserts the one thing nothing else in the repo can
 * see: that a WAL object actually LANDS in S3. Its moving parts are (a) a shell
 * probe whose quoting must survive two different exec seams, (b) a parser that
 * must never read garbled output as a pass, and (c) a verdict matrix that must
 * fail loudly rather than skip when the environment says backups are ON.
 *
 * All three are exercised here with the SSH and S3 seams injected — no cluster,
 * no bucket, no credentials.
 */

describe('wal-g prefix derivation', () => {
  it('builds the single canonical prefix with no role segment', () => {
    expect(walgPrefixFor('myapp-e3')).toBe('backups/myapp-e3/walg/');
  });

  it('builds the WAL segment key under wal_005/', () => {
    expect(walSegmentKeyPrefix('myapp-e3', '000000010000000000000003')).toBe(
      'backups/myapp-e3/walg/wal_005/000000010000000000000003',
    );
  });

  it('pins the wal-g v3 subdirectory names the restore path depends on', () => {
    expect(WALG_WAL_SUBDIR).toBe('wal_005/');
    expect(WALG_BASEBACKUP_SUBDIR).toBe('basebackups_005/');
  });

  it('treats both role namespaces as forbidden', () => {
    expect([...FORBIDDEN_ROLE_PREFIXES]).toEqual(['primary/', 'standby/']);
  });
});

describe('buildWalSwitchProbe', () => {
  const probe = buildWalSwitchProbe();

  // The probe is embedded as ONE single-quoted word in `bash -c '<probe>'` on
  // both the compose and k8s exec paths. A stray apostrophe would split the
  // command and the step would fail with an inscrutable shell error.
  it('contains no single quote in any branch', () => {
    expect(probe).not.toContain("'");
  });

  it('skips when no backup target is configured (empty or s3:/// form)', () => {
    expect(probe).toContain('s3:///*');
    expect(probe).toContain('WAL_SWITCH=skip:no-backup-target');
  });

  it('refuses to provoke a standby and reports it as a failure, not a skip', () => {
    // The caller only ever runs this against a node it has already resolved as
    // the PRIMARY, so a standby answer is the #218 stale-role rot.
    expect(probe).toContain('WAL_SWITCH=fail:standby-role');
    expect(probe).toContain('WAL_SWITCH=fail:in-recovery');
  });

  it('forces an XID before switching so an idle cluster cannot no-op the switch', () => {
    const txidIdx = probe.indexOf('txid_current()');
    const switchIdx = probe.indexOf('pg_switch_wal()');
    expect(txidIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(txidIdx);
  });

  it('keeps newlines when trimming psql output so the segment is separable', () => {
    // `tr -d "[:space:]"` would fold the txid and the walfile name onto one
    // line and `tail -1` would then return both concatenated.
    expect(probe).toContain('tr -d "[:blank:]"');
    expect(probe).not.toContain(
      'SELECT pg_walfile_name(pg_switch_wal())" 2>/dev/null | tr -d "[:space:]"',
    );
  });

  it('always exits 0 so the verdict is decided in TypeScript, not in shell', () => {
    expect(probe.trimEnd().endsWith('exit 0')).toBe(true);
  });
});

describe('buildWalSwitchRemoteCommand', () => {
  it('uses the compose exec seam from the project directory', () => {
    const cmd = buildWalSwitchRemoteCommand('myapp', true);
    expect(cmd.startsWith('cd /opt/myapp && docker compose exec -T db bash -c ')).toBe(true);
  });

  it('uses the supabase-db pod with an explicit KUBECONFIG on k8s', () => {
    const cmd = buildWalSwitchRemoteCommand('myapp', false);
    expect(cmd).toContain('KUBECONFIG=/etc/rancher/k3s/k3s.yaml');
    expect(cmd).toContain('kubectl -n vibecarbon exec supabase-supabase-db-0 -- bash -c ');
  });

  it('wraps the probe in exactly one single-quoted word on both seams', () => {
    for (const isCompose of [true, false]) {
      const cmd = buildWalSwitchRemoteCommand('myapp', isCompose);
      expect((cmd.match(/'/g) ?? []).length).toBe(2);
    }
  });
});

describe('parseWalSwitchOutput', () => {
  it('parses a successful switch with its segment name', () => {
    const parsed = parseWalSwitchOutput(
      [
        'WAL_SWITCH=switched',
        'WAL_SWITCH_PREFIX=s3://myapp-backups/backups/myapp/walg',
        'WAL_SWITCH_SEGMENT=000000010000000000000007',
      ].join('\n'),
    );
    expect(parsed.status).toBe('switched');
    expect(parsed.segment).toBe('000000010000000000000007');
    expect(parsed.prefix).toBe('s3://myapp-backups/backups/myapp/walg');
  });

  it.each([
    'skip:no-backup-target',
    'fail:standby-role',
    'fail:in-recovery',
    'fail:switch-returned-nothing',
  ])('parses the %s verdict', (status) => {
    expect(parseWalSwitchOutput(`WAL_SWITCH=${status}`).status).toBe(status);
  });

  it('reports garbled output as unparsed rather than reading it as a pass', () => {
    expect(parseWalSwitchOutput('bash: psql: command not found').status).toBe('unparsed');
    expect(parseWalSwitchOutput('').status).toBe('unparsed');
    expect(parseWalSwitchOutput('WAL_SWITCH=something-new').status).toBe('unparsed');
  });

  it('tolerates surrounding noise from the container runtime', () => {
    const parsed = parseWalSwitchOutput(
      [
        'Defaulted container "postgres" out of: postgres, walg',
        'WAL_SWITCH=switched',
        'WAL_SWITCH_SEGMENT=00000001000000000000000A',
        '',
      ].join('\n'),
    );
    expect(parsed.status).toBe('switched');
    expect(parsed.segment).toBe('00000001000000000000000A');
  });
});

describe('resolveBackupS3Target', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-backup-evidence-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (config: unknown) =>
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(config));

  it('reads bucket/region/endpoint out of the environment block', () => {
    write({
      environments: {
        e3: {
          backupS3: {
            bucket: 'myapp-backups',
            region: 'nbg1',
            endpoint: 'https://nbg1.your-objectstorage.com',
          },
        },
      },
    });
    expect(resolveBackupS3Target(dir, 'e3')).toEqual({
      bucket: 'myapp-backups',
      region: 'nbg1',
      endpoint: 'https://nbg1.your-objectstorage.com',
    });
  });

  it('reads a DigitalOcean Spaces target with no provider-specific branch', () => {
    write({
      environments: {
        d3: {
          backupS3: {
            bucket: 'myapp-backups',
            region: 'nyc3',
            endpoint: 'https://nyc3.digitaloceanspaces.com',
          },
        },
      },
    });
    expect(resolveBackupS3Target(dir, 'd3')?.region).toBe('nyc3');
  });

  it('returns null when the env records no backup bucket', () => {
    write({ environments: { e3: {} } });
    expect(resolveBackupS3Target(dir, 'e3')).toBeNull();
  });

  it('returns null for a missing or unreadable config rather than throwing', () => {
    expect(resolveBackupS3Target(dir, 'e3')).toBeNull();
    writeFileSync(join(dir, '.vibecarbon.json'), 'not json');
    expect(resolveBackupS3Target(dir, 'e3')).toBeNull();
  });
});

describe('resolveObjectStorageCreds', () => {
  it('reads Hetzner keys through the provider static', () => {
    const creds = resolveObjectStorageCreds('hetzner', {
      HETZNER_ACCESS_KEY: 'ak',
      HETZNER_SECRET_KEY: 'sk',
    });
    expect(creds).toEqual({ accessKey: 'ak', secretKey: 'sk' });
  });

  it('reads DigitalOcean Spaces keys through the same code path', () => {
    const creds = resolveObjectStorageCreds('digitalocean', {
      DIGITALOCEAN_ACCESS_KEY: 'dk',
      DIGITALOCEAN_SECRET_KEY: 'ds',
    });
    expect(creds).toEqual({ accessKey: 'dk', secretKey: 'ds' });
  });

  it('names exactly what is missing, per provider', () => {
    expect(resolveObjectStorageCreds('hetzner', { HETZNER_ACCESS_KEY: 'ak' })).toEqual({
      missing: ['HETZNER_SECRET_KEY'],
    });
    expect(resolveObjectStorageCreds('digitalocean', {})).toEqual({
      missing: ['DIGITALOCEAN_ACCESS_KEY', 'DIGITALOCEAN_SECRET_KEY'],
    });
  });
});

describe('runBackupEvidenceChecks', () => {
  let dir: string;
  const SEGMENT = '000000010000000000000009';
  const PROJECT = 'myapp';

  const probeOutput = [
    'WAL_SWITCH=switched',
    'WAL_SWITCH_PREFIX=s3://myapp-backups/backups/myapp/walg',
    `WAL_SWITCH_SEGMENT=${SEGMENT}`,
  ].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-backup-evidence-run-'));
    mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        environments: { e3: { backupS3: { bucket: 'myapp-backups', region: 'nbg1' } } },
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const baseOpts = {
    masterIp: '10.0.0.1',
    sshKeyPath: '/tmp/key',
    projectDir: '',
    projectName: PROJECT,
    envPrefix: 'e3',
    isCompose: false,
    provider: 'hetzner',
    phase: 'verify-deploy',
    budgetMs: 60,
    intervalMs: 1,
  };
  const opts = (over: Record<string, unknown>) => ({ ...baseOpts, projectDir: dir, ...over });

  const byName = (results: Awaited<ReturnType<typeof runBackupEvidenceChecks>>, name: string) => {
    const r = results.find((x) => x.checkName === name);
    if (!r) throw new Error(`no check named ${name}`);
    return r;
  };

  it('PASSES when the closed segment appears under the canonical prefix', async () => {
    const seen: string[] = [];
    const results = await runBackupEvidenceChecks(
      opts({
        execRemote: () => probeOutput,
        probePrefix: async (prefix: string) => {
          seen.push(prefix);
          return prefix === walSegmentKeyPrefix(PROJECT, SEGMENT);
        },
      }),
    );
    expect(byName(results, 'backup_walg_wal_archived').status).toBe('pass');
    expect(byName(results, 'backup_walg_canonical_prefix').status).toBe('pass');
    // It probed for the exact segment, not a vague "anything under walg/".
    expect(seen).toContain('backups/myapp/walg/wal_005/000000010000000000000009');
  });

  // The load-bearing mutation test: WAL is silently dropped (wal-archive.sh
  // exits 0 by design) and nothing lands. The guard MUST go red.
  it('FAILS when the segment never lands — the silent-archive-failure case', async () => {
    const results = await runBackupEvidenceChecks(
      opts({ execRemote: () => probeOutput, probePrefix: async () => false }),
    );
    const wal = byName(results, 'backup_walg_wal_archived');
    expect(wal.status).toBe('fail');
    expect(wal.errorMessage).toContain(SEGMENT);
    expect(wal.errorMessage).toMatch(/dropping WAL/i);
  });

  it('keeps polling through transient S3 errors before giving a verdict', async () => {
    let calls = 0;
    const results = await runBackupEvidenceChecks(
      opts({
        budgetMs: 5_000,
        intervalMs: 1,
        execRemote: () => probeOutput,
        probePrefix: async (prefix: string) => {
          calls += 1;
          // Hetzner read-after-write staleness (#223) on the first two reads.
          if (calls <= 2) throw new Error('NoSuchBucket: status code: 404');
          return prefix === walSegmentKeyPrefix(PROJECT, SEGMENT);
        },
      }),
    );
    expect(byName(results, 'backup_walg_wal_archived').status).toBe('pass');
    expect(calls).toBeGreaterThan(2);
  });

  it('FAILS when objects exist under a role-namespaced prefix', async () => {
    const results = await runBackupEvidenceChecks(
      opts({
        execRemote: () => probeOutput,
        probePrefix: async (prefix: string) =>
          prefix === walSegmentKeyPrefix(PROJECT, SEGMENT) ||
          prefix === 'backups/myapp/walg/standby/',
      }),
    );
    expect(byName(results, 'backup_walg_wal_archived').status).toBe('pass');
    const canonical = byName(results, 'backup_walg_canonical_prefix');
    expect(canonical.status).toBe('fail');
    expect(canonical.errorMessage).toContain('backups/myapp/walg/standby/');
  });

  it('FAILS when the node we resolved as primary still carries the standby role', async () => {
    const results = await runBackupEvidenceChecks(
      opts({ execRemote: () => 'WAL_SWITCH=fail:standby-role', probePrefix: async () => true }),
    );
    const wal = byName(results, 'backup_walg_wal_archived');
    expect(wal.status).toBe('fail');
    expect(wal.errorMessage).toContain('#218');
  });

  it('FAILS on garbled probe output rather than passing vacuously', async () => {
    const results = await runBackupEvidenceChecks(
      opts({ execRemote: () => 'bash: psql: not found', probePrefix: async () => true }),
    );
    expect(byName(results, 'backup_walg_wal_archived').status).toBe('fail');
  });

  it('FAILS when the SSH exec itself throws', async () => {
    const results = await runBackupEvidenceChecks(
      opts({
        execRemote: () => {
          throw new Error('ssh: connect to host 10.0.0.1 port 22: Connection refused');
        },
        probePrefix: async () => true,
      }),
    );
    expect(byName(results, 'backup_walg_wal_archived').status).toBe('fail');
  });

  it('SKIPS (status "skip", never pass) when the deploy configured no backup target at all', async () => {
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ environments: { e3: {} } }));
    const results = await runBackupEvidenceChecks(
      opts({ execRemote: () => probeOutput, probePrefix: async () => true }),
    );
    for (const r of results) {
      expect(r.status).toBe('skip');
      expect(r.details?.skipped).toBeTruthy();
    }
  });

  it('SKIPS (status "skip", never pass) when the container reports backups are switched off', async () => {
    const results = await runBackupEvidenceChecks(
      opts({ execRemote: () => 'WAL_SWITCH=skip:no-backup-target', probePrefix: async () => true }),
    );
    for (const r of results) expect(r.status).toBe('skip');
  });

  // Non-vacuity guard: the env RECORDS a bucket, so missing runner credentials
  // must not quietly turn the whole check into a skip.
  it('FAILS (never skips) when the env records a bucket but credentials are absent', async () => {
    const saved = { ak: process.env.HETZNER_ACCESS_KEY, sk: process.env.HETZNER_SECRET_KEY };
    // `delete` (not = '') so the keys are genuinely absent — an empty string
    // would take the same branch for the wrong reason.
    delete process.env.HETZNER_ACCESS_KEY;
    delete process.env.HETZNER_SECRET_KEY;
    try {
      // No probePrefix seam here on purpose — this exercises the real
      // credential-resolution path the runner takes.
      const results = await runBackupEvidenceChecks(opts({ execRemote: () => probeOutput }));
      const wal = byName(results, 'backup_walg_wal_archived');
      expect(wal.status).toBe('fail');
      expect(wal.errorMessage).toContain('HETZNER_ACCESS_KEY');
    } finally {
      if (saved.ak) process.env.HETZNER_ACCESS_KEY = saved.ak;
      if (saved.sk) process.env.HETZNER_SECRET_KEY = saved.sk;
    }
  });

  it('self-skips (status "skip", never pass) when the scenario exposes no SSH handle', async () => {
    const results = await runBackupEvidenceChecks(opts({ masterIp: undefined }));
    for (const r of results) {
      expect(r.status).toBe('skip');
      // Names WHICH handle is missing. The old combined "no serverIp/sshKeyPath"
      // could not distinguish an absent node IP from an absent key file, and a
      // fix aimed at one half shipped, ran on live infra and changed nothing
      // with no way to tell from the output which half was still wrong
      // (k8s verify-deploy, 2026-08-21).
      expect(r.details?.skipped).toBe('no serverIp (sshKeyPath present)');
    }
  });

  it('names the OTHER handle when the key is the missing one', async () => {
    // The half the old wording hid.
    const results = await runBackupEvidenceChecks(opts({ sshKeyPath: undefined }));
    for (const r of results) {
      expect(r.status).toBe('skip');
      expect(r.details?.skipped).toBe('no sshKeyPath (serverIp present)');
    }
  });
});
