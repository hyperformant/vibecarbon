import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  hostReporterInstaller,
  hostReporterScript,
  withHostReporter,
} from '../../../src/lib/host-reporter.js';

const shOk = (input: string) => spawnSync('sh', ['-n'], { input }).status;

describe('host reporter installer', () => {
  const installer = hostReporterInstaller();
  it('names both units and starts the service without blocking', () => {
    expect(installer).toContain('vibecarbon-host-reporter.service');
    expect(installer).toContain('vibecarbon-host-reporter.path');
    expect(installer).toContain('systemctl start --no-block vibecarbon-host-reporter.service');
  });
  it('has no brace placeholders for renderScript to substitute', () => {
    expect(installer).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });
  it('parses as sh', () => {
    expect(shOk(installer)).toBe(0);
  });
});

describe('host reporter bounds', () => {
  it('gives the service unit a start timeout, so a hung run fails and retries', () => {
    expect(hostReporterInstaller()).toMatch(/^TimeoutStartSec=120$/m);
    expect(hostReporterInstaller()).toMatch(/^Restart=on-failure$/m);
  });
  it('bounds both kubectl calls with --request-timeout=30s', () => {
    const calls = hostReporterScript()
      .split('\n')
      .filter((l) => /\bkubectl\b/.test(l) && !l.trimStart().startsWith('#'));
    expect(calls).toHaveLength(2);
    for (const l of calls) expect(l).toContain('--request-timeout=30s');
  });
});

describe('hostReporterScript without its heredoc markers', () => {
  it('throws instead of returning garbage', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (orig) => ({
      ...(await orig<typeof import('node:fs')>()),
      readFileSync: () => 'if true; then\n  echo no heredoc here\nfi\n',
    }));
    try {
      const mod = await import('../../../src/lib/host-reporter.js');
      expect(() => mod.hostReporterScript()).toThrow(/heredoc/);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('host reporter script', () => {
  const script = hostReporterScript();
  it('is the reporter body', () => {
    expect(script.startsWith('#!/bin/sh')).toBe(true);
    for (const s of [
      '--print',
      'auth whoami',
      'vibecarbon.dev/host-state',
      '/run/vibecarbon-host',
    ]) {
      expect(script).toContain(s);
    }
  });
  it('parses as sh', () => {
    expect(shOk(script)).toBe(0);
  });
});

describe('withHostReporter', () => {
  it('runs the installer in a failure-proof subshell, then the script', () => {
    const out = withHostReporter('echo hi');
    expect(out.endsWith('echo hi\n') || out.endsWith('echo hi')).toBe(true);
    expect(out).toMatch(/^\(\n[\s\S]*\n\) >\/dev\/null 2>&1 \|\| true\n/);
    expect(shOk(out)).toBe(0);
  });
});

describe('host reporter installer as a non-root user', () => {
  // The installer must be inert off a server: no file writes, no systemctl, no
  // polkit prompt. This runs it with a recording fake systemctl on PATH, as
  // whatever user runs the suite, so it is skipped as root, where it would
  // really install.
  const targets = [
    '/usr/local/lib/vibecarbon/host-reporter.sh',
    '/etc/systemd/system/vibecarbon-host-reporter.service',
    '/etc/systemd/system/vibecarbon-host-reporter.path',
  ];
  it.skipIf(process.getuid?.() === 0)('does nothing and exits 0', () => {
    const before = targets.map((t) => existsSync(t));
    const dir = mkdtempSync(join(tmpdir(), 'vc-installer-'));
    try {
      const log = join(dir, 'calls');
      writeFileSync(join(dir, 'systemctl'), `#!/bin/sh\necho "$@" >> ${log}\n`);
      chmodSync(join(dir, 'systemctl'), 0o755);
      const r = spawnSync('sh', ['-s'], {
        input: hostReporterInstaller(),
        encoding: 'utf-8',
        env: { PATH: `${dir}:/usr/bin:/bin` },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(log) ? readFileSync(log, 'utf-8') : '').toBe('');
      expect(targets.map((t) => existsSync(t))).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('guards with an if-block, not an exit, so a cloud-init include keeps running', () => {
    expect(hostReporterInstaller()).toMatch(/^if \[ "\$\(id -u\)" = 0 \]; then$/m);
    expect(hostReporterInstaller().trimEnd().endsWith('fi')).toBe(true);
  });
});
