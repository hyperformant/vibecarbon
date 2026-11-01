/**
 * restore-tls / snapshot-tls for compose and compose-ha deploys. Before
 * Traefik starts, the last validated snapshot from the backups bucket goes
 * into Traefik's acme.json, but only when the server's own acme.json holds no
 * apex certificate. Once the domain serves a trusted certificate, the deploy
 * saves a fresh snapshot. Neither ever fails the deploy, and no key material
 * reaches operator output or argv.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoKeyLeak, forbiddenStrings } from './_no-key-leak.ts';
import { acmeJson, acmeJsonWithCas } from './_tls-fixtures.ts';

const H = vi.hoisted(() => ({
  ssh: vi.fn(),
  read: vi.fn(),
}));

vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  // The real argv contract (tests/_shared/ssh-contract.ts), then the test's fake.
  const { assertSshRunArgv } = await import('../../_shared/ssh-contract.js');
  return {
    ...actual,
    sshRun: (ip: string, key: string, argv: unknown, opts?: unknown) => {
      assertSshRunArgv(argv);
      return H.ssh(ip, key, argv, opts);
    },
  };
});

vi.mock('../../../src/lib/deploy/tls-snapshot.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, readTlsSnapshot: H.read };
});

const p = await import('@clack/prompts');
const { RECONCILE_FLAGS_SED } = await import('../../../src/lib/deploy/bundle.js');
const { restoreComposeTls, snapshotComposeTlsNow, tlsRestoreLine } = await import(
  '../../../src/lib/deploy/compose/tls-restore.js'
);
const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { restoreTlsStep, snapshotTlsStep } = await import('../../../src/lib/deploy/plan/steps.js');

// Fixtures register with the staging CA (the _tls-fixtures default).
const VALID = acmeJson({});
const SHORT = acmeJson({ days: 3 });
const SELF_SIGNED = acmeJson({ selfSigned: true });
const WRONG_SAN = acmeJson({ sanNames: ['other.example.com'] });
const BAD_SECOND = acmeJson({ extra: [{ main: '*.app.example.com', days: 3 }] });
const PROD = acmeJsonWithCas({
  registrationUri: 'https://acme-v02.api.letsencrypt.org/acme/acct/1',
});
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

const readValid = async () => ({ text: VALID });

const APEX_RE_ARG = `'"main": ?"app\\.example\\.com"'`;

describe('restoreComposeTls: the snapshot is asked for before the server is touched', () => {
  it('never touches the server when there is no snapshot', async () => {
    const ssh = vi.fn();
    const r = await restoreComposeTls({
      ...args(),
      deps: { read: async () => ({ text: null, reason: 'no snapshot' }), ssh },
    });
    expect(r).toEqual({ restored: false, reason: 'no snapshot' });
    expect(ssh).not.toHaveBeenCalled();
  });

  it('never touches the server for a refused snapshot', async () => {
    const ssh = vi.fn();
    const r = await restoreComposeTls({
      ...args(),
      deps: { read: async () => ({ text: SELF_SIGNED }), ssh },
    });
    expect(r.reason).toMatch(/^snapshot refused: /);
    expect(ssh).not.toHaveBeenCalled();
  });

  it('still leaves a live certificate alone when a snapshot exists', async () => {
    const { ssh, calls } = fakeSsh({ live: 'present' });
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read: readValid } });
    expect(r).toEqual({ restored: false, reason: 'live certificate present' });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv[2]).toContain('echo present'); // the check ran, the write did not
  });

  it('still restores onto a rebuilt server that has none', async () => {
    const { ssh, calls } = fakeSsh({ live: 'absent' });
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read: readValid } });
    expect(r).toEqual({ restored: true, reason: 'restored from the last snapshot' });
    expect(calls).toHaveLength(2);
    expect(calls[0].argv[2]).toContain('echo present'); // the live check precedes the write
  });
});

describe('restoreComposeTls: the live certificate wins', () => {
  it('apex present in the volume: a snapshot exists, but no write, live certificate present', async () => {
    const { ssh, calls } = fakeSsh({ live: 'present' });
    const read = vi.fn(async () => ({ text: VALID }));
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read } });
    expect(r).toEqual({ restored: false, reason: 'live certificate present' });
    expect(read).toHaveBeenCalledTimes(1);
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

  it('a failed live check is never read as absent: nothing is written', async () => {
    const { ssh, calls } = fakeSsh({ live: statusError(1) });
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read: readValid } });
    expect(r).toEqual({ restored: false, reason: 'could not check the live certificate' });
    expect(calls).toHaveLength(1); // the check only, no write
  });

  it('unexpected check output is not absent either', async () => {
    const { ssh, calls } = fakeSsh({ live: 'Pulling traefik' });
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read: readValid } });
    expect(r.restored).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a server whose reconcile.sh has no -f set refuses instead of guessing', async () => {
    const { ssh } = fakeSsh({ live: statusError(20) });
    const r = await restoreComposeTls({ ...args(), deps: { ssh, read: readValid } });
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
    // A dropped connection must not rerun the write (it would meet its own file).
    expect(write.opts.transportRetry).toBe(false);
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

describe('restoreComposeTls: stale extra entries are left out', () => {
  it('streams the filtered file and reports the count', async () => {
    const { ssh, calls } = fakeSsh();
    const r = await restoreComposeTls({
      ...args(),
      deps: { ssh, read: async () => ({ text: BAD_SECOND }) },
    });
    expect(r).toEqual({ restored: true, reason: 'restored from the last snapshot', dropped: 1 });
    const sent = String((calls[1].opts as { input: string }).input);
    expect(JSON.parse(sent).letsencrypt.Certificates).toHaveLength(1);
    expect(calls[1].argv[2]).toContain(` ${Buffer.byteLength(sent)}\n`);
    expect(tlsRestoreLine(r, 'app.example.com')).toMatch(/Left out 1 stale certificate entry/);
  });
  it('a never-snapshotted env reads as normal, not as a failure', () => {
    const line = tlsRestoreLine({ restored: false, reason: 'no snapshot' }, 'app.example.com');
    expect(line).toBe(
      'No saved TLS certificate yet; Traefik keeps the one on the server, or requests its own.',
    );
    expect(line).not.toMatch(/not restored/);
  });
  it('an apex that fails is still refused', async () => {
    const { ssh, calls } = fakeSsh();
    const r = await restoreComposeTls({
      ...args(),
      deps: {
        ssh,
        read: async () => ({ text: acmeJson({ days: 3, extra: [{ main: '*.app.example.com' }] }) }),
      },
    });
    expect(r.restored).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('restoreComposeTls: nothing is written for a bad or missing snapshot', () => {
  const cases: Array<[string, Record<string, unknown>, () => unknown, RegExp]> = [
    ['absent', {}, async () => ({ text: null, reason: 'no snapshot' }), /^no snapshot$/],
    ['an S3 error', {}, async () => ({ text: null, reason: 'S3 AccessDenied' }), /AccessDenied/],
    ['near expiry', {}, async () => ({ text: SHORT }), /too soon/],
    ['self-signed', {}, async () => ({ text: SELF_SIGNED }), /self-signed/],
    ['from the other CA', { ca: 'prod' }, async () => ({ text: VALID }), /different CA/],
    ['naming the domain only in its label', {}, async () => ({ text: WRONG_SAN }), /names do not/],
    [
      'from prod, not chained to a platform root',
      { ca: 'prod' },
      async () => ({ text: PROD.json }),
      /does not chain to a trusted root/,
    ],
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
    expect(calls).toHaveLength(0); // the server is never touched
  });

  it('a prod snapshot chained to a trust root is restored', async () => {
    const { ssh, calls } = fakeSsh();
    const r = await restoreComposeTls({
      ...args({ ca: 'prod' }),
      deps: { ssh, read: async () => ({ text: PROD.json }), trustRoots: PROD.cas },
    });
    expect(r).toEqual({ restored: true, reason: 'restored from the last snapshot' });
    expect(calls).toHaveLength(2);
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

/**
 * The rendered scripts run for real under bash/sh, with a fake `docker` on
 * PATH that executes the in-container command against a temp dir standing in
 * for the letsencrypt volume. Proves the scripts print no key material, on
 * success and on every failure exit.
 */
describe('rendered restore scripts, executed locally', () => {
  const SHIM = `#!/bin/bash
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[$i]}" in
    ps) echo fake-traefik-id; exit 0 ;;
    restart) exit "\${FAKE_RESTART_RC:-0}" ;;
    -c) inner="\${args[$((i + 1))]}"; rest=("\${args[@]:$((i + 2))}"); break ;;
  esac
done
inner="\${inner///letsencrypt/$LE_DIR}"
if [ -n "\${FAKE_TRUNCATE:-}" ]; then head -c 100 | sh -c "$inner" "\${rest[@]}"; exit $?; fi
exec sh -c "$inner" "\${rest[@]}"
`;
  const RECONCILE =
    "docker compose -f docker-compose.yml -f docker-compose.prod.yml $([ -f docker-compose.replication.yml ] && echo '-f docker-compose.replication.yml') up -d --remove-orphans\n";

  /** Render both scripts through restoreComposeTls, the way a deploy sends them. */
  async function renderScripts() {
    const { ssh, calls } = fakeSsh();
    await restoreComposeTls({ ...args(), deps: { ssh, read: async () => ({ text: VALID }) } });
    return { check: calls[0].argv[2], write: calls[1].argv[2] };
  }

  function rig() {
    const root = mkdtempSync(join(tmpdir(), 'vc-tls-restore-'));
    const bin = join(root, 'bin');
    const project = join(root, 'project');
    const le = join(root, 'le');
    for (const d of [bin, project, le]) spawnSync('mkdir', ['-p', d]);
    writeFileSync(join(bin, 'docker'), SHIM);
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(join(project, 'reconcile.sh'), RECONCILE);
    const run = (script: string, input: string, env: Record<string, string> = {}) => {
      const r = spawnSync('bash', ['-c', script.replace('cd /opt/myapp', `cd ${project}`)], {
        input,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LE_DIR: le, ...env },
      });
      const output = `${r.stdout}${r.stderr}`;
      for (const bad of forbiddenStrings(VALID)) {
        expect(output.includes(bad), 'key material in script output').toBe(false);
      }
      return { code: r.status, stdout: r.stdout };
    };
    return { root, le, run };
  }

  let r: ReturnType<typeof rig>;
  beforeEach(() => {
    r = rig();
  });
  afterEach(() => {
    rmSync(r.root, { recursive: true, force: true });
  });

  it('success: writes acme.json mode 600, leaves no temp copy, prints nothing', async () => {
    const { write } = await renderScripts();
    const res = r.run(write, VALID);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    const f = join(r.le, 'acme.json');
    expect(readFileSync(f, 'utf8')).toBe(VALID);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(spawnSync('ls', ['-A', r.le], { encoding: 'utf8' }).stdout.trim()).toBe('acme.json');
  });

  it('exit 3: an apex certificate already in the volume is kept', async () => {
    const { write } = await renderScripts();
    writeFileSync(join(r.le, 'acme.json'), '{"main": "app.example.com"}');
    expect(r.run(write, VALID).code).toBe(3);
    expect(readFileSync(join(r.le, 'acme.json'), 'utf8')).toBe('{"main": "app.example.com"}');
  });

  it('exit 4: a truncated stream writes nothing', async () => {
    const { write } = await renderScripts();
    writeFileSync(join(r.le, 'acme.json'), '{}');
    expect(r.run(write, VALID, { FAKE_TRUNCATE: '1' }).code).toBe(4);
    expect(readFileSync(join(r.le, 'acme.json'), 'utf8')).toBe('{}');
    expect(spawnSync('ls', ['-A', r.le], { encoding: 'utf8' }).stdout.trim()).toBe('acme.json');
  });

  it('exit 5: written, but the running traefik did not restart', async () => {
    const { write } = await renderScripts();
    expect(r.run(write, VALID, { FAKE_RESTART_RC: '1' }).code).toBe(5);
    expect(readFileSync(join(r.le, 'acme.json'), 'utf8')).toBe(VALID);
  });

  it('exit 20: a reconcile.sh with no -f set refuses', async () => {
    const { write } = await renderScripts();
    writeFileSync(join(r.root, 'project', 'reconcile.sh'), '#!/bin/sh\n');
    expect(r.run(write, VALID).code).toBe(20);
  });

  it('the live check prints only present or absent, never the file', async () => {
    const { check } = await renderScripts();
    expect(r.run(check, '').stdout.trim()).toBe('absent');
    writeFileSync(join(r.le, 'acme.json'), VALID);
    expect(r.run(check, '').stdout.trim()).toBe('present');
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

  it('warm redeploy with a live certificate: one neutral info line', async () => {
    const { ssh } = fakeSsh({ live: 'present' });
    H.ssh.mockImplementation(ssh);
    H.read.mockResolvedValue({ text: VALID });
    await EFFECTS.restoreTlsSnapshot(ctx({ serverIp: '10.0.0.1' }));
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe(
      'TLS certificate already on the server; nothing to restore.',
    );
  });

  it('never fails the deploy: a throw anywhere in the effect is one fixed info line', async () => {
    await expect(
      EFFECTS.restoreTlsSnapshot(ctx({ serverIp: '10.0.0.1', projectConfig: undefined })),
    ).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe(
      'TLS certificate not restored (restore errored). Traefik requests a new one.',
    );
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

describe('restoreComposeTls: bounded per piece, no restart (the failover path)', () => {
  afterEach(() => vi.useRealTimers());

  const timedOut = () => Object.assign(new Error('Command timed out'), { timedOut: true });
  /** An ssh that hangs until its own timeout, as the real one does. */
  const slowSsh = (slow: 'check' | 'write') =>
    vi.fn(async (_ip: string, _k: string, argv: string[], opts: { timeout?: number } = {}) => {
      const isCheck = (argv[2] ?? '').includes('echo present');
      if ((slow === 'check') !== isCheck) return isCheck ? 'absent' : '';
      return new Promise((_res, rej) => setTimeout(() => rej(timedOut()), opts.timeout));
    });

  it('passes the check and write bounds and the S3 client options through', async () => {
    const { ssh, calls } = fakeSsh();
    const read = vi.fn(async () => ({ text: VALID }));
    const s3ClientOptions = { maxAttempts: 1 };
    await restoreComposeTls({
      ...args(),
      checkTimeoutMs: 30_000,
      writeTimeoutMs: 60_000,
      s3ClientOptions,
      deps: { ssh, read },
    });
    expect(calls[0].opts.timeout).toBe(30_000);
    expect(calls[1].opts.timeout).toBe(60_000);
    expect(read).toHaveBeenCalledWith(S3, expect.any(String), { clientOptions: s3ClientOptions });
  });

  it('restart: false writes the file and leaves Traefik alone (the caller recreates it)', async () => {
    const { ssh, calls } = fakeSsh();
    const r = await restoreComposeTls({
      ...args(),
      restart: false,
      deps: { ssh, read: async () => ({ text: VALID }) },
    });
    expect(r).toEqual({ restored: true, reason: 'restored from the last snapshot' });
    expect(calls[1].argv[2]).not.toContain('restart traefik');
  });

  it('by default the running Traefik is restarted after the write', async () => {
    const { ssh, calls } = fakeSsh();
    await restoreComposeTls({ ...args(), deps: { ssh, read: async () => ({ text: VALID }) } });
    expect(calls[1].argv[2]).toContain('restart traefik');
  });

  it('a check that hangs past its bound: restore timed out', async () => {
    vi.useFakeTimers();
    const pending = restoreComposeTls({
      ...args(),
      checkTimeoutMs: 30_000,
      deps: { ssh: slowSsh('check'), read: readValid },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ restored: false, reason: 'restore timed out' });
  });

  it('a write that hangs past its bound: restore timed out', async () => {
    vi.useFakeTimers();
    const pending = restoreComposeTls({
      ...args(),
      writeTimeoutMs: 60_000,
      deps: { ssh: slowSsh('write'), read: async () => ({ text: VALID }) },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toEqual({ restored: false, reason: 'restore timed out' });
  });

  it('a snapshot read that timed out: restore timed out, nothing written', async () => {
    const { ssh, calls } = fakeSsh();
    const r = await restoreComposeTls({
      ...args(),
      deps: {
        ssh,
        read: async () => ({ text: null, reason: 'S3 TimeoutError', timedOut: true }),
      },
    });
    expect(r).toEqual({ restored: false, reason: 'restore timed out' });
    expect(calls).toHaveLength(0);
  });
});
