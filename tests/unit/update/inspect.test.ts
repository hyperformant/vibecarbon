import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APT_LOCK_TIMEOUT_SECONDS } from '../../../src/lib/deploy/apt.js';
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
      // An @@error line names apt in its text: `{ echo "..."; exit 0; }` reads nothing.
      .filter((l) => /apt-get|apt-cache|unattended-upgrade/.test(l) && !/^\s*(\{ )?echo /.test(l))
      .filter((l) => !l.includes('</dev/null'));
    expect(offenders).toEqual([]);
  });
});

describe('INSPECT_SCRIPT', () => {
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

  // The ssh bound is one apt lock wait plus 120 s: after a failed apt step the
  // script stops, so a second step never waits for the lock again.
  it.each(['compose', 'k8s'] as const)(
    '%s: every @@error ends the script at once, with exit 0 so the error is read',
    (kind) => {
      const lines = INSPECT_SCRIPT(kind)
        .split('\n')
        .filter((l) => l.includes('@@error'));
      expect(lines.length).toBe(kind === 'compose' ? 4 : 3);
      for (const line of lines) expect(line).toMatch(/echo "@@error [^"]*"; exit 0\b/);
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

describe('inspectTarget and inspectAll', () => {
  it('sends the script on stdin with a bound past apt lock wait and no transport retry', async () => {
    const sshRun = vi.fn().mockResolvedValue(FIXTURE);
    await inspectTarget(target('master'), { sshRun, envName: 'prod' });
    // apt waits up to APT_LOCK_TIMEOUT_SECONDS for the lock: the ssh bound is
    // 120 s past it, so a busy daily job reads as a failed apt check.
    expect(APT_LOCK_TIMEOUT_SECONDS).toBe(300);
    expect(sshRun).toHaveBeenCalledWith('10.0.0.6', expect.any(String), ['sh', '-s'], {
      input: INSPECT_SCRIPT('compose'),
      timeout: (APT_LOCK_TIMEOUT_SECONDS + 120) * 1000,
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
