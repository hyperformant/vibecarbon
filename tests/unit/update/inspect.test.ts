import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APT_LOCK_TIMEOUT_SECONDS } from '../../../src/lib/deploy/apt.js';
import {
  INSPECT_SCRIPT,
  inspectAll,
  inspectTarget,
  parseInspectOutput,
} from '../../../src/lib/update/inspect.js';

const FIXTURE = readFileSync(
  join(import.meta.dirname, '../../fixtures/update/inspect-compose.txt'),
  'utf-8',
);

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
      .filter((l) => /apt-get|apt-cache|unattended-upgrade/.test(l) && !/^\s*echo /.test(l))
      .filter((l) => !l.includes('</dev/null'));
    expect(offenders).toEqual([]);
  });
});

describe('INSPECT_SCRIPT', () => {
  it('is valid sh, and only compose asks about docker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-inspect-'));
    try {
      for (const kind of ['compose', 'k8s'] as const) {
        const f = join(dir, `${kind}.sh`);
        writeFileSync(f, INSPECT_SCRIPT(kind));
        // -n parses only; nothing runs.
        expect(spawnSync('sh', ['-n', f]).status).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(INSPECT_SCRIPT('compose')).toContain('@@docker');
    expect(INSPECT_SCRIPT('k8s')).not.toContain('@@docker');
    expect(INSPECT_SCRIPT('k8s')).toContain('--print');
  });

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
