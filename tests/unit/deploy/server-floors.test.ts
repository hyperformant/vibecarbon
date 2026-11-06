/**
 * A server under its Docker floor stops the deploy before anything lands on it.
 *
 * Docker 27.5.1 on a fresh Hetzner server once broke a deploy deep in image
 * delivery (86aeb04f). These pin the check that reads the versions: it rides
 * the database check's session rather than opening its own, it runs beside that
 * check so the cold deploy waits for nothing extra, and it refuses only a
 * version it read and knows is too old.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/perf.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/perf.js')>()),
  perfRecord: vi.fn(),
}));

import {
  assertDbMadeByThisStack,
  dbLedgerProbeCommand,
  parseDbLedgerProbe,
} from '../../../src/lib/deploy/compose/db-ledger-preflight.js';
import {
  assertServerFloors,
  judgeServerVersions,
  withServerVersions,
  // @ts-expect-error: untyped JS module
} from '../../../src/lib/deploy/compose/server-floors.js';
import { perfRecord } from '../../../src/lib/perf.js';

const run = promisify(execFile);
const IP = '203.0.113.7';
const KEY = '/home/me/.ssh/id_vc';
const versions = (engine: string, compose: string, ms = 41) =>
  `VC_ENGINE=${engine}\nVC_COMPOSE=${compose}\nVC_VERSIONS_MS=${ms}\n`;
const judge = (output: string, warn = vi.fn()) =>
  judgeServerVersions(IP, output, { sshKeyPath: KEY, warn });

describe('judgeServerVersions', () => {
  it('lets through the Docker that started all this: 27.5.1 meets the floor', () => {
    const warn = vi.fn();
    expect(() => judge(versions('27.5.1', '2.33.0'), warn)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('holds the exact floors, a v prefix included', () => {
    expect(() => judge(versions('25.0.0', '2.24.4'))).not.toThrow();
    expect(() => judge(versions('29.1.0', 'v5.7.0'))).not.toThrow();
  });

  it('refuses an Engine under its floor, saying what it found, what it needs and what to do', () => {
    const message = (() => {
      try {
        judge(versions('24.0.7', '2.29.7'));
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    expect(message).toContain(`Docker Engine 24.0.7 on ${IP} is too old.`);
    expect(message).toContain('Found:   Docker Engine 24.0.7');
    expect(message).toContain('Needed:  25.0.0 or newer');
    expect(message).toContain(`ssh -i ${KEY} root@${IP}`);
    expect(message).toMatch(/apt-get .*update && apt-get .*install -y/);
    expect(message).toContain('docker-ce');
    expect(message).toContain('docker-compose-plugin');
    expect(message).toContain('restarts');
    expect(message).toContain('deploy again');
  });

  it('refuses Compose under its floor', () => {
    expect(() => judge(versions('28.1.1', '2.24.3'))).toThrow(
      `Docker Compose 2.24.3 on ${IP} is too old.`,
    );
  });

  it.each([
    ['an empty read', '', ''],
    ['text that is not a version', 'dev', 'unknown'],
    ['a build with no number', 'master-dockerproject-2026', 'nightly'],
  ])('warns and carries on after %s', (_label, engine, compose) => {
    const warn = vi.fn();
    expect(() => judge(versions(engine, compose), warn)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain(`Could not read the Docker Engine version on ${IP}`);
    expect(warn.mock.calls[1][0]).toContain(`Could not read the Docker Compose version on ${IP}`);
  });

  it('warns and carries on when the output has no version lines at all', () => {
    const warn = vi.fn();
    expect(() => judge('', warn)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports what the read cost as a perf marker', () => {
    vi.mocked(perfRecord).mockClear();
    judgeServerVersions(IP, versions('27.5.1', '2.33.0', 57), {
      sshKeyPath: KEY,
      warn: vi.fn(),
      perfName: 'deploy.compose.serverFloors',
    });
    expect(perfRecord).toHaveBeenCalledWith('deploy.compose.serverFloors', 57);
  });
});

describe('the database check carries the read', () => {
  const ledgerOk = 'STATE=absent\nVOLUME=\n';

  it('opens no session of its own: one per server, the same as before', async () => {
    const sshRun = vi.fn(async () => `${versions('27.5.1', '2.33.0')}${ledgerOk}`);
    await assertDbMadeByThisStack(['1.1.1.1', '2.2.2.2'], KEY, 'acme', { sshRun });
    expect(sshRun).toHaveBeenCalledTimes(2);
    const script = (sshRun.mock.calls[0] as unknown[])[2] as string;
    expect(script).toContain('VC_ENGINE');
    expect(script).toContain('STATE=');
  });

  it('refuses an old server ahead of the database verdict, on the first server it reads', async () => {
    const preLedger = 'STATE=true\nIMAGE=acme-db:latest\nPRE_LEDGER=t\n';
    const sshRun = vi.fn(async () => `${versions('24.0.7', '2.29.7')}${preLedger}`);
    await expect(
      assertDbMadeByThisStack(['1.1.1.1', '2.2.2.2'], KEY, 'acme', { sshRun }),
    ).rejects.toThrow('Docker Engine 24.0.7 on 1.1.1.1 is too old.');
    expect(sshRun).toHaveBeenCalledTimes(1);
  });

  it('still gives the database verdict when the versions cannot be read', async () => {
    const warn = vi.fn();
    const sshRun = vi.fn(async () => 'STATE=true\nIMAGE=x\nPRE_LEDGER=t\n');
    await expect(
      assertDbMadeByThisStack(['1.1.1.1'], KEY, 'acme', { sshRun, warn }),
    ).rejects.toThrow('created by an older vibecarbon stack');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('names the perf marker the caller asked for', async () => {
    vi.mocked(perfRecord).mockClear();
    const sshRun = vi.fn(async () => `${versions('27.5.1', '2.33.0', 12)}${ledgerOk}`);
    await assertDbMadeByThisStack(['1.1.1.1'], KEY, 'acme', {
      sshRun,
      perfName: 'deploy.ha.compose.serverFloors',
    });
    expect(perfRecord).toHaveBeenCalledWith('deploy.ha.compose.serverFloors', 12);
  });
});

/**
 * The real script, with a stand-in `docker` on PATH. Each stand-in read waits
 * for the other to begin and fails if it never does, so the script finishes
 * clean only when the two truly overlap. That is the property the cold deploy
 * depends on, and a timing assertion could only approximate it.
 */
describe('the script on a server', () => {
  let dir: string;

  const fakeDocker = `#!/bin/sh
sees() { i=0; while [ $i -lt 150 ]; do [ -e "$HS/$1" ] && return 0; sleep 0.02; i=$((i+1)); done; return 1; }
case "$1 $2" in
  "version --format") : > "$HS/engine"; sees ledger && echo 27.5.1 ;;
  "compose version") echo 2.33.0 ;;
  "inspect -f") : > "$HS/ledger"; sees engine && exit 1; echo stale ;;
  "volume ls") ;;
esac
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vctest-server-floors-'));
    writeFileSync(join(dir, 'docker'), fakeDocker);
    chmodSync(join(dir, 'docker'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const inShell = (shell: string, script: string) =>
    run(shell, ['-c', script], {
      env: { PATH: `${dir}:${process.env.PATH}`, HS: dir },
      timeout: 10_000,
    });

  it.each(['sh', 'bash'])('reads the versions beside the database check in %s', async (shell) => {
    const { stdout } = await inShell(shell, dbLedgerProbeCommand('acme'));
    expect(stdout).toMatch(/^VC_ENGINE=27\.5\.1$/m);
    expect(stdout).toMatch(/^VC_COMPOSE=2\.33\.0$/m);
    expect(stdout).toMatch(/^VC_VERSIONS_MS=\d+$/m);
    expect(parseDbLedgerProbe(stdout, 'acme').verdict).toBe('absent');
  });

  it('never lets a read change the exit status of the script it rides on', async () => {
    const exits = (code: number) => withServerVersions(`touch "$HS/ledger"; exit ${code}`);
    await expect(inShell('sh', exits(3))).rejects.toMatchObject({ code: 3 });
    await expect(inShell('sh', exits(0))).resolves.toBeDefined();
  });

  it('leaves the ledger script exit 0 path inside its own shell, so the wait still runs', async () => {
    const { stdout } = await inShell(
      'sh',
      withServerVersions(`touch "$HS/ledger"; echo before; exit 0; echo after`),
    );
    expect(stdout).toContain('before');
    expect(stdout).not.toContain('after');
    expect(stdout).toMatch(/^VC_VERSIONS_MS=\d+$/m);
  });

  it('gives up on a daemon that does not answer, within its bound', async () => {
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nexec sleep 30\n');
    const script = withServerVersions('true').replaceAll('timeout 5 ', 'timeout 0.2 ');
    const { stdout } = await inShell('sh', script);
    expect(stdout).toMatch(/^VC_ENGINE=$/m);
    expect(stdout).toMatch(/^VC_COMPOSE=$/m);
  });
});

describe('assertServerFloors: the servers scale adds', () => {
  it('reads in one command and refuses a server under its floor', async () => {
    const runner = vi.fn(async () => versions('24.0.7', '2.29.7'));
    await expect(assertServerFloors(IP, KEY, { run: runner })).rejects.toThrow(
      `Docker Engine 24.0.7 on ${IP} is too old.`,
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('warns and carries on when the read itself fails', async () => {
    const warn = vi.fn();
    const runner = vi.fn(async () => {
      throw new Error('ssh: connect to host timed out');
    });
    await expect(assertServerFloors(IP, KEY, { run: runner, warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain(IP);
  });

  it('runs on the new server before scale copies anything to it', () => {
    const src = readFileSync('src/scale.js', 'utf8');
    const ready = src.indexOf("perfAsync('scale.cloudInitReady'");
    const check = src.indexOf('assertServerFloors(newIp');
    const pull = src.indexOf('Pull the OLD server');
    expect(ready).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(ready);
    expect(check).toBeLessThan(pull);
  });
});
