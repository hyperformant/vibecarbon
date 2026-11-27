import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  APT_DAILY_UNITS_WAIT_SECONDS,
  APT_LOCK_TIMEOUT_SECONDS,
  aptGet,
  aptWaitForDailyUnits,
  UNATTENDED_UPGRADE,
} from '../../../src/lib/deploy/apt.js';
import {
  INSPECT_SCRIPT,
  inspectAll,
  inspectTarget,
  parseInspectOutput,
} from '../../../src/lib/update/inspect.js';
import { readRepoFile } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const FIXTURE = readRepoFile('tests/fixtures/update/inspect-compose.txt');

const target = (name: string) => ({
  name,
  ip: `10.0.0.${name.length}`,
  side: 'primary' as const,
  role: 'server' as const,
  kind: 'compose' as const,
});

describe('parseInspectOutput', () => {
  it('reads a real compose run: ubuntu names, boot id, changed docker packages only', () => {
    const s = parseInspectOutput(FIXTURE, 'compose');
    expect(s.host.rebootRequired).toBe(false);
    expect(s.bootId).toBe('2189d752-96e6-4e90-97fd-6ccf5f576e00');
    expect(s.ubuntu).toEqual([
      'apt',
      'libapt-pkg7.0',
      'libc-bin',
      'libc-gconv-modules-extra',
      'libc6',
      'libpcre2-8-0',
      'perl-base',
    ]);
    expect(s.docker?.packages).toEqual([
      {
        name: 'docker-ce-cli',
        from: '5:29.9.0-1~ubuntu.26.04~resolute',
        to: '5:29.9.3-1~ubuntu.26.04~resolute',
      },
    ]);
  });

  it('gives docker null when the section shows no candidate', () => {
    const bare = FIXTURE.slice(0, FIXTURE.indexOf('@@docker'));
    expect(parseInspectOutput(`${bare}@@docker\n`, 'compose').docker).toBeNull();
    expect(
      parseInspectOutput(
        `${bare}@@docker\ndocker-ce:\n  Installed: (none)\n  Candidate: (none)\n`,
        'compose',
      ).docker,
    ).toBeNull();
  });

  it('k8s output has no docker section', () => {
    const k8s = FIXTURE.slice(0, FIXTURE.indexOf('@@docker'));
    expect(parseInspectOutput(k8s, 'k8s').docker).toBeNull();
  });

  it('throws on a missing section', () => {
    const noBoot = FIXTURE.replace('@@boot-id', '@@x');
    expect(() => parseInspectOutput(noBoot, 'compose')).toThrow('inspect output missing @@boot-id');
  });

  it('compose: says whether the restart reporter is installed', () => {
    expect(parseInspectOutput(FIXTURE, 'compose').reporter).toBe(true);
    const missing = FIXTURE.replace('@@reporter\ninstalled\n', '@@reporter\nmissing\n');
    expect(parseInspectOutput(missing, 'compose').reporter).toBe(false);
    const noSection = FIXTURE.replace('@@reporter\ninstalled\n', '');
    expect(() => parseInspectOutput(noSection, 'compose')).toThrow(
      'inspect output missing @@reporter',
    );
  });

  it('k8s: the reporter is read from the node annotation, not the server', () => {
    const k8s = FIXTURE.slice(0, FIXTURE.indexOf('@@reporter'));
    expect(parseInspectOutput(k8s, 'k8s').reporter).toBeNull();
  });
});

describe('names and versions from the server are checked before they are used', () => {
  const ESC = '\u001b';

  it('drops an Ubuntu package name that is not a package name', () => {
    const text = FIXTURE.replace(
      'apt libapt-pkg7.0',
      `apt linux-image-6.8${ESC}[2J ${ESC}]52;c;ZXZpbA==${ESC}\\ libapt-pkg7.0`,
    );
    expect(parseInspectOutput(text, 'compose').ubuntu).toEqual([
      'apt',
      'libapt-pkg7.0',
      'libc-bin',
      'libc-gconv-modules-extra',
      'libc6',
      'libpcre2-8-0',
      'perl-base',
    ]);
  });

  it('drops a Docker package whose name or version does not read as one', () => {
    const entry = (name: string, from: string, to: string) =>
      `${name}:\n  Installed: ${from}\n  Candidate: ${to}\n`;
    const bare = FIXTURE.slice(0, FIXTURE.indexOf('@@docker'));
    const text = `${bare}@@docker\n${[
      entry('docker-ce', '5:29.9.0-1~ubuntu.26.04~resolute', '5:29.9.3-1~ubuntu.26.04~resolute'),
      entry(`containerd.io${ESC}[31m`, '1.7.1-1', '1.7.2-1'),
      entry('docker-ce-cli', '5:29.9.0-1', `5:29.9.3-1${ESC}]8;;http://x${ESC}\\`),
      entry('docker-buildx-plugin', `0.1${ESC}[2K`, '0.2'),
      entry('Docker-Compose-Plugin', '2.1', '2.2'),
    ].join('')}`;
    expect(parseInspectOutput(text, 'compose').docker?.packages).toEqual([
      {
        name: 'docker-ce',
        from: '5:29.9.0-1~ubuntu.26.04~resolute',
        to: '5:29.9.3-1~ubuntu.26.04~resolute',
      },
    ]);
  });
});

describe('a k8s node is updated only at the address of the server it is', () => {
  const node = (name: string, ip: string) => ({
    name,
    ip,
    side: 'primary' as const,
    role: 'worker' as const,
    kind: 'k8s' as const,
    masterIp: '10.0.0.1',
    nodeName: name,
  });
  const k8sOutput = (host: string) =>
    FIXTURE.slice(0, FIXTURE.indexOf('@@reporter')).replace(
      '"host":"a9333c194b47"',
      `"host":"${host}"`,
    );

  it('skips a node whose server says it is another host, naming both', async () => {
    const sshRun = vi.fn(async (ip: string) =>
      k8sOutput(ip === '10.0.0.2' ? 'prod-worker-1' : 'prod-db'),
    );
    const r = await inspectAll(
      [node('prod-worker-1', '10.0.0.2'), node('prod-worker-2', '10.0.0.3')],
      {
        sshRun,
        envName: 'prod',
      },
    );
    expect(r.inspected.map((i) => i.target.name)).toEqual(['prod-worker-1']);
    expect(r.skipped).toEqual([
      {
        name: 'prod-worker-2',
        ip: '10.0.0.3',
        reason: 'the server at 10.0.0.3 says it is prod-db, not prod-worker-2',
      },
    ]);
  });

  it('k3s names a node after its hostname in lower case, so the case does not count', async () => {
    const sshRun = vi.fn(async () => k8sOutput('Prod-Worker-1'));
    const r = await inspectAll([node('prod-worker-1', '10.0.0.2')], { sshRun, envName: 'prod' });
    expect(r.skipped).toEqual([]);
    expect(r.inspected).toHaveLength(1);
  });

  it('compose servers come from the saved config and are not checked by name', async () => {
    const sshRun = vi.fn(async () => FIXTURE);
    const r = await inspectAll([target('master')], { sshRun, envName: 'prod' });
    expect(r.inspected).toHaveLength(1);
  });
});

describe('a failed apt check is never read as nothing pending', () => {
  const ubuntuHead = FIXTURE.slice(0, FIXTURE.indexOf('@@ubuntu'));
  const withUbuntu = (body: string) => `${ubuntuHead}@@ubuntu\n${body}`;

  it.each([
    ['@@error apt-get update exited 100', 'could not check for updates: apt-get update exited 100'],
    [
      '@@error unattended-upgrade not installed',
      'could not check for updates: unattended-upgrade not installed',
    ],
    [
      '@@error unattended-upgrade exited 1',
      'could not check for updates: unattended-upgrade exited 1',
    ],
  ])('throws on %s', (marker, message) => {
    expect(() => parseInspectOutput(withUbuntu(`${marker}\n`), 'compose')).toThrow(message);
  });

  it('throws on a docker apt-get update failure in the docker section', () => {
    const text = FIXTURE.replace(
      '@@docker\n',
      '@@docker\n@@error docker apt-get update exited 100\n',
    );
    expect(() => parseInspectOutput(text, 'compose')).toThrow(
      'could not check for updates: docker apt-get update exited 100',
    );
  });

  it('inspectAll lists such a server as skipped with that reason', async () => {
    const sshRun = vi.fn(async (ip: string) =>
      ip === '10.0.0.3' ? withUbuntu('@@error apt-get update exited 100\n@@boot-id\nx\n') : FIXTURE,
    );
    const r = await inspectAll([target('a'), target('bad')], { sshRun, envName: 'prod' });
    expect(r.inspected.map((i) => i.target.name)).toEqual(['a']);
    expect(r.skipped).toEqual([
      {
        name: 'bad',
        ip: '10.0.0.3',
        reason: 'could not check for updates: apt-get update exited 100',
      },
    ]);
  });

  it('the script prints the markers and reads no stdin outside the reporter heredoc', () => {
    const script = INSPECT_SCRIPT('compose');
    expect(script).toContain('@@error apt-get update exited');
    expect(script).toContain('@@error unattended-upgrade not installed');
    expect(script).toContain('@@error unattended-upgrade exited');
    expect(script).toContain('@@error docker apt-get update exited');
    const outside = script.replace(
      /<<'VC_INSPECT_REPORTER_EOF'[\s\S]*?\nVC_INSPECT_REPORTER_EOF\n/,
      '',
    );
    const offenders = outside
      .split('\n')
      // An @@error line names apt in its text: `{ printf ... "@@error ..."; exit 0; }` reads nothing.
      .filter(
        (l) =>
          /apt-get|apt-cache|unattended-upgrade|systemd-run/.test(l) &&
          !/^\s*\{ printf '%s\\n' "@@error /.test(l),
      )
      .filter((l) => !l.includes('</dev/null'));
    expect(offenders).toEqual([]);
  });
});

describe('INSPECT_SCRIPT', () => {
  it('plans with unattended-upgrade in one transaction, the mode the install uses', () => {
    for (const kind of ['compose', 'k8s'] as const) {
      expect(INSPECT_SCRIPT(kind)).toContain(
        'unattended-upgrade --no-minimal-upgrade-steps --dry-run --verbose',
      );
    }
  });

  it('is valid sh, and only compose asks about docker', () => {
    const dir = createTempDir('vc-inspect-');
    for (const kind of ['compose', 'k8s'] as const) {
      const f = join(dir, `${kind}.sh`);
      writeFileSync(f, INSPECT_SCRIPT(kind));
      // -n parses only; nothing runs.
      expect(spawnSync('sh', ['-n', f]).status).toBe(0);
    }

    expect(INSPECT_SCRIPT('compose')).toContain('@@docker');
    expect(INSPECT_SCRIPT('k8s')).not.toContain('@@docker');
    expect(INSPECT_SCRIPT('k8s')).toContain('--print');
  });

  // The ssh bound is the daily units' wait, one apt lock wait and 120 s: after
  // a failed apt step the script stops, so a second step never waits again.
  it.each(['compose', 'k8s'] as const)(
    '%s: every @@error ends the script at once, with exit 0 so the error is read',
    (kind) => {
      const lines = INSPECT_SCRIPT(kind)
        .split('\n')
        .filter((l) => l.includes('@@error'));
      expect(lines.length).toBe(kind === 'compose' ? 4 : 3);
      // printf, not echo: dash's echo would turn a backslash in $why into a
      // newline or a control character.
      for (const line of lines)
        expect(line).toMatch(/\{ printf '%s\\n' "@@error [^"]*"; exit 0; \}/);
    },
  );

  it('compose checks for the reporter path unit; k8s does not', () => {
    expect(INSPECT_SCRIPT('compose')).toContain('@@reporter');
    expect(INSPECT_SCRIPT('compose')).toContain(
      'if [ -f /etc/systemd/system/vibecarbon-host-reporter.path ]; then echo installed; else echo missing; fi',
    );
    expect(INSPECT_SCRIPT('k8s')).not.toContain('@@reporter');
  });
});

/** Where a tool really lives, for a link next to the stubs. */
function realTool(name: string): string {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf-8' }).stdout.trim();
  if (!found.startsWith('/')) throw new Error(`${name} not found`);
  return found;
}

/**
 * Runs the script's own lines from the daily units' wait through the Ubuntu
 * check, in their order, under stubs: PATH holds only the stubs and links to
 * sed, tr, tail and cut, so no real systemd-run, apt-get or unattended-upgrade
 * can run. Cut out: the PATH line, and the host's own reporter and boot id
 * between @@host and @@ubuntu. Each stub logs its argv; unattended-upgrade
 * prints `out` exactly and exits `rc`.
 */
function runUbuntuCheck(dryRun: { out: string; rc: number }) {
  const dir = createTempDir('vc-inspect-run-');
  const log = join(dir, 'calls.log');
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub('timeout', 'shift\nexec "$@"');
  stub('systemd-run', 'echo "Running as unit: run-u7.service"');
  stub('apt-get', 'exit 0');
  stub(
    'unattended-upgrade',
    `printf '%s' '${dryRun.out.replaceAll("'", "'\\''")}'\nexit ${dryRun.rc}`,
  );
  for (const tool of ['sed', 'tr', 'tail', 'cut']) symlinkSync(realTool(tool), join(dir, tool));

  const lines = INSPECT_SCRIPT('k8s').split('\n');
  expect(lines[0]).toMatch(/^PATH=/);
  const host = lines.indexOf('echo @@host');
  const ubuntu = lines.indexOf('echo @@ubuntu');
  const end = lines.indexOf('fi', ubuntu);
  expect([host, ubuntu, end].every((i) => i > 0)).toBe(true);
  const fragment = [...lines.slice(1, host), ...lines.slice(ubuntu, end + 1)].join('\n');
  expect(fragment).not.toContain('PATH=');

  const r = spawnSync('/bin/sh', ['-c', fragment], {
    env: { PATH: dir },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : [];
  return { status: r.status, stdout: r.stdout, calls };
}

describe('the check waits for the daily apt job first', () => {
  it.each(['compose', 'k8s'] as const)(
    '%s: one wait, before the restart state and every apt command',
    (kind) => {
      const script = INSPECT_SCRIPT(kind);
      const wait = script.indexOf(aptWaitForDailyUnits());
      expect(script.split(aptWaitForDailyUnits())).toHaveLength(2);
      expect(wait).toBeGreaterThan(-1);
      for (const later of [
        'echo @@host',
        aptGet('update -qq'),
        `${UNATTENDED_UPGRADE} --dry-run`,
        ...(kind === 'compose' ? ['apt-get -c '] : []),
      ]) {
        expect(script.indexOf(later), later).toBeGreaterThan(wait);
      }
    },
  );

  it('the wait runs before apt, and none of its output reaches the read', () => {
    const r = runUbuntuCheck({ out: 'Packages that will be upgraded: libc6 openssl\n', rc: 0 });
    const wait =
      'systemd-run --quiet --wait --property=After=apt-daily.service --property=After=apt-daily-upgrade.service true';
    expect(r.calls).toEqual([
      `timeout 300 ${wait}`,
      wait,
      aptGet('update -qq'),
      `${UNATTENDED_UPGRADE} --dry-run --verbose`,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('@@ubuntu\nlibc6 openssl\n');
  });
});

describe('a failed dry run says why', () => {
  const ubuntuHead = FIXTURE.slice(0, FIXTURE.indexOf('@@ubuntu'));
  const reasonOf = (stdout: string) => {
    try {
      parseInspectOutput(`${ubuntuHead}${stdout}`, 'k8s');
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('parsed as a passed check');
  };

  it('the @@error names the last line of output that has text', async () => {
    const r = runUbuntuCheck({
      out: 'Starting unattended upgrades script\nLock could not be acquired (another package manager running?)\n\n  \n',
      rc: 1,
    });
    expect(r.stdout).toBe(
      '@@ubuntu\n@@error unattended-upgrade exited 1: Lock could not be acquired (another package manager running?)\n',
    );
    const reason =
      'could not check for updates: unattended-upgrade exited 1: Lock could not be acquired (another package manager running?)';
    expect(reasonOf(r.stdout)).toBe(reason);
    // The same reason reaches the skipped list update prints.
    const sshRun = vi.fn(async () => `${ubuntuHead}${r.stdout}`);
    const res = await inspectAll([target('db')], { sshRun, envName: 'prod' });
    expect(res.skipped).toEqual([{ name: 'db', ip: '10.0.0.2', reason }]);
  });

  it('a last line of nothing but control characters is passed over', () => {
    const r = runUbuntuCheck({ out: 'dpkg was interrupted\n\u001b\u0007\r\n', rc: 1 });
    expect(r.stdout).toBe('@@ubuntu\n@@error unattended-upgrade exited 1: dpkg was interrupted\n');
  });

  it.each([
    ['no output', ''],
    ['blank lines', '\n  \n\t\n'],
    ['nothing but control characters', '\r\n\u001b\u0007\n\u0001'],
  ])('%s: the line reads as it did before', (_name, out) => {
    const r = runUbuntuCheck({ out, rc: 1 });
    expect(r.stdout).toBe('@@ubuntu\n@@error unattended-upgrade exited 1\n');
    expect(reasonOf(r.stdout)).toBe('could not check for updates: unattended-upgrade exited 1');
  });

  it('keeps printable ASCII only, without leading blanks, at most 200 characters', () => {
    const long = 'a'.repeat(250);
    const r = runUbuntuCheck({
      out: `first\n   \u001b]52;c;ZXZpbA==\u0007\u001b[2Jcafé\t${long}\n`,
      rc: 100,
    });
    const why = `]52;c;ZXZpbA==[2Jcaf${long}`.slice(0, 200);
    expect(r.stdout).toBe(`@@ubuntu\n@@error unattended-upgrade exited 100: ${why}\n`);
    const reason = reasonOf(r.stdout);
    expect(reason).toBe(`could not check for updates: unattended-upgrade exited 100: ${why}`);
    expect([...reason].every((ch) => ch >= ' ' && ch <= '~')).toBe(true);
  });

  it('a backslash in the output stays a backslash: printf, never echo', () => {
    // dash's echo would end the line at \c, break it at \n and turn \0033
    // into an escape.
    const line = String.raw`E: open C:\new\cache \0033[2J \c done`;
    const r = runUbuntuCheck({ out: `${line}\n`, rc: 1 });
    expect(r.stdout).toBe(`@@ubuntu\n@@error unattended-upgrade exited 1: ${line}\n`);
  });
});

describe('inspectTarget and inspectAll', () => {
  it('sends the script on stdin with a bound past both waits and no transport retry', async () => {
    const sshRun = vi.fn().mockResolvedValue(FIXTURE);
    await inspectTarget(target('master'), { sshRun, envName: 'prod' });
    // The script waits up to APT_DAILY_UNITS_WAIT_SECONDS for the daily apt
    // units, then apt up to APT_LOCK_TIMEOUT_SECONDS for the lock: the ssh bound
    // is 120 s past both, so a daily job that runs longer reads as a failed apt
    // check, never as an ssh timeout. 720 s: 300 + 300 + 120.
    expect(APT_DAILY_UNITS_WAIT_SECONDS).toBe(300);
    expect(APT_LOCK_TIMEOUT_SECONDS).toBe(300);
    expect(sshRun).toHaveBeenCalledWith('10.0.0.6', expect.any(String), ['sh', '-s'], {
      input: INSPECT_SCRIPT('compose'),
      timeout: 720_000,
      transportRetry: false,
    });
  });

  it('a target that throws is skipped; the others are inspected', async () => {
    const sshRun = vi.fn(async (ip: string) => {
      if (ip === '10.0.0.3') throw Object.assign(new Error('boom'), { timedOut: true });
      return FIXTURE;
    });
    const r = await inspectAll([target('a'), target('bad'), target('three')], {
      sshRun,
      envName: 'prod',
    });
    expect(r.inspected.map((i) => i.target.name)).toEqual(['a', 'three']);
    expect(r.skipped).toEqual([{ name: 'bad', ip: '10.0.0.3', reason: 'ssh timeout' }]);
  });
});
