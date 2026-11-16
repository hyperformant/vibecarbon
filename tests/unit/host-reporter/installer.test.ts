import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
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
