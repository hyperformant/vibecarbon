/**
 * restore-tls / snapshot-tls for compose and compose-ha deploys. Before
 * Traefik starts, the last validated snapshot from the backups bucket goes
 * into Traefik's acme.json, but only when the server's own acme.json holds no
 * apex certificate. Once the domain serves a trusted certificate, the deploy
 * saves a fresh snapshot. Neither ever fails the deploy, and no key material
 * reaches operator output or argv.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoKeyLeak, forbiddenStrings } from './_no-key-leak.ts';
import { acmeJson } from './_tls-fixtures.ts';

const H = vi.hoisted(() => ({
  ssh: vi.fn(),
  read: vi.fn(),
}));

vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, sshRun: H.ssh };
});

vi.mock('../../../src/lib/deploy/tls-snapshot.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, readTlsSnapshot: H.read };
});

const p = await import('@clack/prompts');
const { RECONCILE_FLAGS_SED } = await import('../../../src/lib/deploy/bundle.js');
const { restoreComposeTls, snapshotComposeTlsNow } = await import(
  '../../../src/lib/deploy/compose/tls-restore.js'
);
const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { restoreTlsStep, snapshotTlsStep } = await import('../../../src/lib/deploy/plan/steps.js');

// Fixtures register with the staging CA (the _tls-fixtures default).
const VALID = acmeJson({});
const SHORT = acmeJson({ days: 3 });
const SELF_SIGNED = acmeJson({ selfSigned: true });
const KEY_B64 = JSON.parse(VALID).letsencrypt.Certificates[0].key as string;

type Call = { ip: string; argv: string[]; opts: Record<string, unknown> };

const statusError = (status: number, message = 'Command failed') =>
  Object.assign(new Error(message), { status });

/** A fake sshRun: the live check answers `live`; the write answers `write`. */
function fakeSsh({ live = 'absent' as string | Error, write = '' as string | Error } = {}) {
  const calls: Call[] = [];
  const ssh = vi.fn(async (ip: string, _key: string, argv: string[], opts = {}) => {
    calls.push({ ip, argv, opts: opts as Record<string, unknown> });
    const script = argv[2] ?? '';
    const answer = script.includes('echo present') ? live : write;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { ssh, calls };
}

const S3 = {
  bucket: 'myapp-backups',
  accessKey: 'AK',
  secretKey: 'SK',
  region: 'fsn1',
  endpoint: 'https://fsn1.example',
};

const args = (over: Record<string, unknown> = {}) => ({
  ip: '10.0.0.1',
  sshKeyPath: '/k',
  projectName: 'myapp',
  domain: 'app.example.com',
  envName: 'production',
  ca: 'staging' as const,
  s3Config: S3,
  ...over,
});

const APEX_RE_ARG = `'"main": ?"app\\.example\\.com"'`;

describe('restoreComposeTls: the live certificate wins', () => {
  it('apex present in the volume: no read, no write, live certificate present', async () => {
    const { ssh, calls } = fakeSsh({ live: 'present' });
    const read = vi.fn();
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read } });
    expect(r).toEqual({ restored: false, reason: 'live certificate present' });
    expect(read).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    const script = calls[0].argv[2];
    expect(calls[0].argv.slice(0, 2)).toEqual(['bash', '-c']);
    expect(script).toContain('cd /opt/myapp');
    expect(script).toContain(`FLAGS=$(sed -n '${RECONCILE_FLAGS_SED}' reconcile.sh | tail -1)`);
    expect(script).toContain(
      'docker compose $FLAGS run --rm --no-deps -T --entrypoint sh traefik -c',
    );
    expect(script).toContain('grep -Eq "$1" /letsencrypt/acme.json');
    expect(script).toContain(APEX_RE_ARG);
  });

  it('a failed live check is never read as absent: nothing is read or written', async () => {
    const { ssh, calls } = fakeSsh({ live: statusError(1) });
    const read = vi.fn();
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read } });
    expect(r).toEqual({ restored: false, reason: 'could not check the live certificate' });
    expect(read).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('unexpected check output is not absent either', async () => {
    const { ssh } = fakeSsh({ live: 'Pulling traefik' });
    const read = vi.fn();
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read } });
    expect(r.restored).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('a server whose reconcile.sh has no -f set refuses instead of guessing', async () => {
    const { ssh } = fakeSsh({ live: statusError(20) });
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read: vi.fn() } });
    expect(r).toEqual({
      restored: false,
      reason: 'reconcile.sh on the server has no compose files',
    });
  });
});

describe('restoreComposeTls: a valid snapshot fills an empty acme.json', () => {
  it('reads the env snapshot key, streams it on stdin into the volume, restored', async () => {
    const { ssh, calls } = fakeSsh();
    const read = vi.fn(async () => ({ text: VALID }));
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read } });
    expect(r).toEqual({ restored: true, reason: 'restored from the last snapshot' });
    expect(read).toHaveBeenCalledWith(S3, 'backups/myapp/production/tls/staging/compose-acme.json');
    expect(calls).toHaveLength(2);
    const write = calls[1];
    expect(write.ip).toBe('10.0.0.1');
    expect(write.argv.slice(0, 2)).toEqual(['bash', '-c']);
    // The key travels on stdin only: never on argv.
    expect(write.opts.input).toBe(VALID);
    for (const bad of forbiddenStrings(VALID)) {
      expect(write.argv.join(' ').includes(bad)).toBe(false);
    }
    const script = write.argv[2];
    expect(script).toContain('umask 077');
    expect(script).toContain(`FLAGS=$(sed -n '${RECONCILE_FLAGS_SED}' reconcile.sh | tail -1)`);
    expect(script).toContain(
      'docker compose $FLAGS run --rm --no-deps -T --entrypoint sh traefik -c',
    );
    expect(script).toContain('cat > "$t"');
    expect(script).toContain('chmod 600 "$t"; mv -f "$t" "$f"');
    expect(script).toContain('f=/letsencrypt/acme.json');
    expect(script).toContain('trap "rm -f $t" EXIT');
    // The byte count guards against a truncated stream.
    expect(script).toContain(`${APEX_RE_ARG} ${Buffer.byteLength(VALID)}`);
    // Checked again in the volume just before the replace.
    expect(script.indexOf('if grep -Eq "$1" "$f"')).toBeLessThan(script.indexOf('cat > "$t"'));
  });

  it('restarts a running traefik after the write, and only a running one', async () => {
    const { ssh, calls } = fakeSsh();
    await restoreComposeTls({ ...args(), deps: { ssh, read: async () => ({ text: VALID }) } });
    const script = calls[1].argv[2];
    expect(script).toContain(
      'if [ -n "$(docker compose $FLAGS ps -q traefik 2>/dev/null)" ]; then\n' +
        '  docker compose $FLAGS restart traefik',
    );
    expect(script.indexOf('restart traefik')).toBeGreaterThan(script.indexOf('mv -f'));
  });

  it('the script carries no apostrophe inside the container command', async () => {
    const { ssh, calls } = fakeSsh();
    await restoreComposeTls({ ...args(), deps: { ssh, read: async () => ({ text: VALID }) } });
    const script = calls[1].argv[2];
    const inner = script.split("traefik -c '")[1].split("' sh '")[0];
    expect(inner).not.toContain("'");
  });
});

describe('restoreComposeTls: nothing is written for a bad or missing snapshot', () => {
  const cases: Array<[string, Record<string, unknown>, () => unknown, RegExp]> = [
    ['absent', {}, async () => ({ text: null, reason: 'no snapshot' }), /^no snapshot$/],
    ['an S3 error', {}, async () => ({ text: null, reason: 'S3 AccessDenied' }), /AccessDenied/],
    ['near expiry', {}, async () => ({ text: SHORT }), /too soon/],
    ['self-signed', {}, async () => ({ text: SELF_SIGNED }), /self-signed/],
    ['from the other CA', { ca: 'prod' }, async () => ({ text: VALID }), /different CA/],
    [
      'for another domain',
      { domain: 'other.example.com' },
      async () => ({ text: VALID }),
      /no certificate for other\.example\.com/,
    ],
  ];
  it.each(cases)('snapshot %s: restored false with the reason', async (_n, over, readImpl, re) => {
    const { ssh, calls } = fakeSsh();
    const r = await restoreComposeTls({ ...args(over), deps: { ssh, read: vi.fn(readImpl) } });
    expect(r.restored).toBe(false);
    expect(r.reason).toMatch(re);
    expect(calls).toHaveLength(1); // the live check only
  });

  it.each([
    ['null s3Config', { s3Config: null }, 'no backup bucket'],
    ['no bucket', { s3Config: { ...S3, bucket: undefined } }, 'no backup bucket'],
    ['no credentials', { s3Config: { ...S3, secretKey: '' } }, 'no backup credentials'],
    ['no recorded CA', { ca: null }, 'no recorded CA'],
    ['no domain', { domain: null }, 'no valid domain'],
    ['a domain with shell characters', { domain: "a'b.com" }, 'no valid domain'],
    ['no server address', { ip: null }, 'no server address'],
  ])('%s: skipped before any ssh or read', async (_n, over, reason) => {
    const { ssh } = fakeSsh();
    const read = vi.fn();
    const r = await restoreComposeTls({ ...args(over), deps: { ssh, read } });
    expect(r).toEqual({ restored: false, reason });
    expect(ssh).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('restoreComposeTls: a failed write is reported by exit status only', () => {
  const read = async () => ({ text: VALID });
  it.each([
    [3, false, 'a certificate appeared on the server, kept'],
    [4, false, 'the snapshot arrived incomplete, nothing written'],
    [5, true, 'restored, traefik did not restart'],
    [1, false, 'could not write acme.json (exit 1)'],
  ])('exit %i: restored %s', async (status, restored, reason) => {
    const { ssh } = fakeSsh({ write: statusError(status, `stderr carrying ${KEY_B64}`) });
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read } });
    expect(r).toEqual({ restored, reason });
  });

  it('never throws, even when a dependency does', async () => {
    const { ssh } = fakeSsh();
    const r = await restoreComposeTls({
      ...args(),
      deps: { ssh, read: async () => Promise.reject(new Error(KEY_B64)) },
    });
    expect(r).toEqual({ restored: false, reason: 'restore errored' });
  });
});

describe('snapshotComposeTlsNow', () => {
  it('runs backup/tls-snapshot.sh from the project dir', async () => {
    const ssh = vi.fn(async () => '');
    await snapshotComposeTlsNow({
      ip: '10.0.0.1',
      sshKeyPath: '/k',
      projectName: 'myapp',
      deps: { ssh },
    });
    expect(ssh).toHaveBeenCalledWith(
      '10.0.0.1',
      '/k',
      ['bash', '-c', 'cd /opt/myapp && bash backup/tls-snapshot.sh'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('a failure throws a fixed message with the exit status, never the output', async () => {
    const ssh = vi.fn(async () => Promise.reject(statusError(1, `wal-g said ${KEY_B64}`)));
    await expect(
      snapshotComposeTlsNow({
        ip: '10.0.0.1',
        sshKeyPath: '/k',
        projectName: 'myapp',
        deps: { ssh },
      }),
    ).rejects.toThrow(/^tls-snapshot\.sh exited 1$/);
  });
});

describe('restore-tls / snapshot-tls steps', () => {
  it('restore-tls runs only with a domain', () => {
    const step = restoreTlsStep();
    expect(step.effect).toBe('restoreTlsSnapshot');
    expect(step.when({ domain: 'app.example.com' })).toBe(true);
    expect(step.when({ domain: null })).toBe(false);
  });

  it('snapshot-tls runs only once TLS is trusted', () => {
    const step = snapshotTlsStep();
    expect(step.effect).toBe('snapshotTls');
    expect(step.when({ tlsState: { state: 'trusted' } })).toBe(true);
    expect(step.when({ tlsState: { state: 'pending' } })).toBe(false);
    expect(step.when({})).toBe(false);
  });
});

describe('effects: one shared effect per step for both compose tiers', () => {
  const savedCa = process.env.ACME_CA_SERVER;
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.ACME_CA_SERVER = 'https://acme-staging-v02.api.letsencrypt.org/directory';
    H.ssh.mockReset();
    H.read.mockReset();
    info = vi.spyOn(p.log, 'info').mockImplementation(() => {});
    warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    if (savedCa === undefined) delete process.env.ACME_CA_SERVER;
    else process.env.ACME_CA_SERVER = savedCa;
  });

  const ctx = (over: Record<string, unknown> = {}) => ({
    domain: 'app.example.com',
    sshKeyPath: '/k',
    environment: 'production',
    projectConfig: { projectName: 'myapp' },
    s3Config: {
      accessKey: 'AK',
      secretKey: 'SK',
      region: 'fsn1',
      endpoint: 'https://e',
      bucket: 'state',
    },
    backupS3Config: { bucket: 'myapp-backups' },
    ...over,
  });

  it('compose-ha ctx: restores onto the primary from the backup bucket, CA from ACME_CA_SERVER', async () => {
    const { ssh, calls } = fakeSsh();
    H.ssh.mockImplementation(ssh);
    H.read.mockResolvedValue({ text: VALID });
    await EFFECTS.restoreTlsSnapshot(ctx({ primary: { ip: '10.0.0.9' } }));
    expect(calls.map((c) => c.ip)).toEqual(['10.0.0.9', '10.0.0.9']);
    expect(H.read).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'myapp-backups', accessKey: 'AK', secretKey: 'SK' }),
      'backups/myapp/production/tls/staging/compose-acme.json',
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/restored/i);
  });

  it('single compose ctx without a backup bucket: one info line naming the reason', async () => {
    await EFFECTS.restoreTlsSnapshot(ctx({ serverIp: '10.0.0.1', backupS3Config: null }));
    expect(H.ssh).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('no backup bucket');
  });

  it('no key material reaches any operator sink during a full restore', async () => {
    const { ssh } = fakeSsh();
    H.ssh.mockImplementation(ssh);
    H.read.mockResolvedValue({ text: VALID });
    const { captured } = await expectNoKeyLeak(VALID, () =>
      EFFECTS.restoreTlsSnapshot(ctx({ serverIp: '10.0.0.1' })),
    );
    expect(captured.some((l) => /restored/i.test(l))).toBe(true);
  });

  it('no key material reaches any operator sink when the write fails loudly', async () => {
    const { ssh } = fakeSsh({ write: statusError(1, `Command failed\n${KEY_B64}`) });
    H.ssh.mockImplementation(ssh);
    H.read.mockResolvedValue({ text: VALID });
    const { captured } = await expectNoKeyLeak(VALID, () =>
      EFFECTS.restoreTlsSnapshot(ctx({ serverIp: '10.0.0.1' })),
    );
    expect(captured.some((l) => l.includes('could not write acme.json'))).toBe(true);
  });

  it('snapshotTls runs the script on the primary and warns without failing on error', async () => {
    H.ssh.mockRejectedValue(statusError(1));
    await expect(
      EFFECTS.snapshotTls(ctx({ primary: { ip: '10.0.0.9' } })),
    ).resolves.toBeUndefined();
    expect(H.ssh.mock.calls[0][0]).toBe('10.0.0.9');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('tls-snapshot.sh exited 1');
  });

  it('snapshotTls is silent on success', async () => {
    H.ssh.mockResolvedValue('');
    await EFFECTS.snapshotTls(ctx({ serverIp: '10.0.0.1' }));
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
