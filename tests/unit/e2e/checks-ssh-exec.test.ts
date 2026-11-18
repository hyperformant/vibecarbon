/**
 * How five e2e checks reach a server over ssh, seen from the process they
 * spawn.
 *
 * replication.ts, pilot-light.ts, grafana-ready.ts, config-canary.ts and
 * backup-evidence.ts each run one fixed command as root over ssh and read
 * what it printed. This pins, per check, the exact argv (the options, the
 * key, the host, the command as one word), the time limit, and what the check
 * makes of a clean exit and of a failed one. It reaches each wrapper through
 * the check's own entry point with `execFileSync` replaced, so it does not
 * care where the wrapper lives.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync,
}));

const { runBackupEvidenceChecks } = await import('../../e2e/checks/backup-evidence.js');
const { CONFIG_CANARY_SECRET, OAUTH_CANARY_CLIENT_ID, runConfigCanaryChecks } = await import(
  '../../e2e/checks/config-canary.js'
);
const { waitForGrafanaReady } = await import('../../e2e/checks/grafana-ready.js');
const { assertPilotLightStandby } = await import('../../e2e/checks/pilot-light.js');
const { runRemote } = await import('../../e2e/checks/replication.js');
const { resetSshReachability } = await import('../../e2e/utils/ssh-reachability.js');

const IP = '203.0.113.10';
const KEY = '/keys/id_ed25519';

/** The argv every one of the five builds: 10 s connect, no prompts, the key, root. */
const argvFor = (remote: string) => [
  '-o',
  'ConnectTimeout=10',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'LogLevel=ERROR',
  '-o',
  'BatchMode=yes',
  '-i',
  KEY,
  `root@${IP}`,
  remote,
];
const optsFor = (timeout: number) => ({ encoding: 'utf-8', timeout, stdio: 'pipe' });

/** What execFileSync throws when ssh, or the command behind it, exits non-zero. */
function exitError(status: number | null, stdout: string, stderr: string): Error {
  return Object.assign(new Error('Command failed: ssh ...'), {
    status,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  resetSshReachability();
});

describe('replication.ts runRemote', () => {
  const target = {
    ip: IP,
    sshKeyPath: KEY,
    mode: 'compose' as const,
    projectName: 'p',
    label: 'primary',
  };

  it('runs the command as one word, 30 s limit, and returns trimmed stdout', async () => {
    execFileSync.mockReturnValue('  streaming\n');
    expect(await runRemote(target, 'psql -c "select 1"')).toEqual({
      ok: true,
      output: 'streaming',
    });
    expect(execFileSync.mock.calls).toEqual([
      ['ssh', argvFor('psql -c "select 1"'), optsFor(30_000)],
    ]);
  });

  it('a remote exit is reported once, with trimmed stdout and stderr, and is not retried', async () => {
    execFileSync.mockImplementation(() => {
      throw exitError(2, ' partial \n', ' psql: FATAL \n');
    });
    expect(await runRemote(target, 'psql')).toEqual({
      ok: false,
      output: 'partial',
      error: '[psql] psql: FATAL',
      failureKind: 'remote',
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('a failure with no stderr falls back to the error message', async () => {
    execFileSync.mockImplementation(() => {
      throw exitError(2, '', '');
    });
    expect((await runRemote(target, 'psql')).error).toBe('[psql] Command failed: ssh ...');
  });

  it('an auth failure (exit 255, not transient) is ssh-transport after one attempt', async () => {
    execFileSync.mockImplementation(() => {
      throw exitError(255, '', 'Permission denied (publickey).');
    });
    expect(await runRemote(target, 'psql')).toMatchObject({
      ok: false,
      error: '[ssh-transport, 1 attempts] Permission denied (publickey).',
      failureKind: 'ssh-transport',
    });
  });
});

describe('pilot-light.ts assertPilotLightStandby', () => {
  it('reads each of its four listings as one kubectl command, 30 s limit', async () => {
    execFileSync.mockReturnValue('{"items":[]}\n');
    await assertPilotLightStandby(IP, { sshKeyPath: KEY });
    expect(execFileSync).toHaveBeenCalledTimes(4);
    for (const [bin, argv, opts] of execFileSync.mock.calls) {
      expect(bin).toBe('ssh');
      expect(argv.slice(0, -1)).toEqual(argvFor('').slice(0, -1));
      expect(argv.at(-1)).toMatch(
        /^KUBECONFIG=\/etc\/rancher\/k3s\/k3s\.yaml kubectl get .* -o json$/,
      );
      expect(opts).toEqual(optsFor(30_000));
    }
  });

  it('a kubectl exit fails every check with its stderr and is not retried', async () => {
    execFileSync.mockImplementation(() => {
      throw exitError(1, '', ' error: the server is unavailable \n');
    });
    const results = await assertPilotLightStandby(IP, { sshKeyPath: KEY });
    expect(results.map((r) => r.status)).toEqual(['fail', 'fail', 'fail', 'fail']);
    for (const r of results) {
      expect(r.errorMessage).toContain('[kubectl] error: the server is unavailable');
    }
    expect(execFileSync).toHaveBeenCalledTimes(4);
  });

  it('an auth failure is named ssh-transport with its one attempt', async () => {
    execFileSync.mockImplementation(() => {
      throw exitError(255, '', 'Permission denied (publickey).');
    });
    const [first] = await assertPilotLightStandby(IP, { sshKeyPath: KEY });
    expect(first.errorMessage).toContain(
      '[ssh-transport, 1 attempts] Permission denied (publickey).',
    );
  });
});

describe('grafana-ready.ts waitForGrafanaReady', () => {
  it('waits with the allowance plus 60 s as its limit and passes on a clean exit', async () => {
    execFileSync.mockReturnValue('deployment "grafana" successfully rolled out\n');
    const result = await waitForGrafanaReady(IP, KEY, { allowanceSeconds: 5 });
    expect(result.status).toBe('pass');
    expect(execFileSync.mock.calls).toEqual([
      [
        'ssh',
        argvFor(
          'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n vibecarbon-observability rollout status deployment/grafana --timeout=5s',
        ),
        optsFor(65_000),
      ],
    ]);
  });

  it('on a failed wait, reports stdout then stderr, and reads the pods with a 30 s limit', async () => {
    execFileSync
      .mockImplementationOnce(() => {
        throw exitError(1, ' Waiting for rollout \n', ' error: timed out \n');
      })
      .mockReturnValueOnce(' grafana-1  0/1  Running \n');
    const result = await waitForGrafanaReady(IP, KEY, { allowanceSeconds: 5 });
    expect(result.status).toBe('fail');
    expect(result.errorMessage).toContain('Waiting for rollout\nerror: timed out');
    expect(result.details).toMatchObject({ pods: 'grafana-1  0/1  Running' });
    expect(execFileSync.mock.calls[1][2]).toEqual(optsFor(30_000));
  });

  it('a failure that printed nothing reports the error message', async () => {
    execFileSync.mockImplementation(() => {
      throw exitError(null, '', '');
    });
    const result = await waitForGrafanaReady(IP, KEY, { allowanceSeconds: 5 });
    expect(result.errorMessage).toContain('Command failed: ssh ...');
    expect(result.details).toMatchObject({ pods: 'Command failed: ssh ...' });
  });
});

describe('config-canary.ts runConfigCanaryChecks', () => {
  it('reads each value with a 30 s limit and compares it trimmed', async () => {
    execFileSync
      .mockReturnValueOnce(`${CONFIG_CANARY_SECRET}\n`)
      .mockReturnValueOnce(`  ${OAUTH_CANARY_CLIENT_ID}\n`);
    const results = await runConfigCanaryChecks(IP, KEY, 'proj', true);
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass']);
    expect(execFileSync.mock.calls).toEqual([
      [
        'ssh',
        argvFor('docker exec proj-app printenv STRIPE_SECRET_KEY 2>/dev/null || true'),
        optsFor(30_000),
      ],
      [
        'ssh',
        argvFor('docker exec proj-app printenv GOOGLE_CLIENT_ID 2>/dev/null || true'),
        optsFor(30_000),
      ],
    ]);
  });

  it('lets the ssh error through as thrown: a connect timeout ends the poll at once', async () => {
    execFileSync.mockImplementation(() => {
      throw new Error(`ssh: connect to host ${IP} port 22: Connection timed out`);
    });
    const results = await runConfigCanaryChecks(IP, KEY, 'proj', true);
    expect(results.map((r) => r.status)).toEqual(['fail', 'fail']);
    expect(results[0].details).toMatchObject({ sshUnreachable: true });
    // One attempt for the first value; the second is not tried on a dead host.
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('backup-evidence.ts runBackupEvidenceChecks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'checks-ssh-exec-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        environments: {
          prod: { backupS3: { bucket: 'b', region: 'nbg1', endpoint: 'https://x' } },
        },
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = () =>
    runBackupEvidenceChecks({
      masterIp: IP,
      sshKeyPath: KEY,
      projectDir: dir,
      projectName: 'proj',
      envPrefix: 'prod',
      isCompose: true,
      phase: 'verify-deploy',
    });

  it('runs the probe with a 60 s limit and reads its output trimmed', async () => {
    execFileSync.mockReturnValue('\n  WAL_SWITCH=skip:no-backup-target\n\n');
    const results = await run();
    expect(results.map((r) => r.status)).toEqual(['skip', 'skip']);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = execFileSync.mock.calls[0];
    expect(bin).toBe('ssh');
    expect(argv.slice(0, -1)).toEqual(argvFor('').slice(0, -1));
    expect(argv.at(-1)).toContain('docker compose exec -T db');
    expect(opts).toEqual(optsFor(60_000));
  });

  it('lets the ssh error through as thrown, so the failure names exit and stderr', async () => {
    execFileSync.mockImplementation(() => {
      throw exitError(255, '', 'ssh: connect to host port 22: Connection refused');
    });
    const [archived, prefix] = await run();
    expect(archived.status).toBe('fail');
    expect(archived.errorMessage).toContain(
      'exit 255: ssh: connect to host port 22: Connection refused',
    );
    expect(prefix.status).toBe('skip');
  });
});
