import { describe, expect, it, vi } from 'vitest';
import {
  buildAuditArgv,
  runDependencyAudit,
  summarizeAuditJson,
} from '../../../src/lib/audit-advisories.js';

// npm v10+ and pnpm both emit the classic `metadata.vulnerabilities` shape
// from `audit --json`; that is the only part the summary reads.
const AUDIT_JSON = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 2, moderate: 1, high: 3, critical: 1, total: 7 },
  },
});

const CLEAN_JSON = JSON.stringify({
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});

describe('buildAuditArgv', () => {
  it('maps npm and pnpm to their audit --json commands', () => {
    expect(buildAuditArgv('npm')).toEqual(['npm', 'audit', '--json']);
    expect(buildAuditArgv('pnpm')).toEqual(['pnpm', 'audit', '--json']);
  });

  it('returns null for bun (no parseable audit surface pinned yet)', () => {
    expect(buildAuditArgv('bun')).toBeNull();
  });
});

describe('summarizeAuditJson', () => {
  it('extracts severity counts from metadata.vulnerabilities', () => {
    expect(summarizeAuditJson(AUDIT_JSON)).toEqual({
      info: 0,
      low: 2,
      moderate: 1,
      high: 3,
      critical: 1,
      total: 7,
    });
  });

  it('returns null on malformed JSON', () => {
    expect(summarizeAuditJson('npm ERR! network offline')).toBeNull();
  });

  it('returns null when the vulnerabilities block is absent', () => {
    expect(summarizeAuditJson('{"some":"other json"}')).toBeNull();
  });
});

describe('runDependencyAudit', () => {
  it('parses a clean audit (exit 0, stdout returned directly)', () => {
    const exec = vi.fn().mockReturnValue(CLEAN_JSON);
    const result = runDependencyAudit('npm', '/proj', { exec });
    expect(result.status).toBe('ok');
    expect(result.summary?.critical).toBe(0);
    expect(exec).toHaveBeenCalledWith(
      ['npm', 'audit', '--json'],
      expect.objectContaining({
        cwd: '/proj',
        silent: true,
        cleanEnv: true,
      }),
    );
  });

  it('recovers the report when audit exits non-zero because advisories exist', () => {
    // npm/pnpm audit exit 1 when vulnerabilities are FOUND — the normal
    // interesting case, not an execution failure. The JSON rides on
    // err.stdout (runCommand attaches it before throwing).
    const err = Object.assign(new Error('exit 1'), { stdout: AUDIT_JSON });
    const exec = vi.fn(() => {
      throw err;
    });
    const result = runDependencyAudit('pnpm', '/proj', { exec });
    expect(result.status).toBe('ok');
    expect(result.summary).toMatchObject({ critical: 1, high: 3 });
  });

  it('reports skipped when the command fails with no usable output (offline)', () => {
    const exec = vi.fn(() => {
      throw Object.assign(new Error('ENOTFOUND'), { stdout: '' });
    });
    expect(runDependencyAudit('npm', '/proj', { exec }).status).toBe('skipped');
  });

  it('reports unsupported for bun without executing anything', () => {
    const exec = vi.fn();
    expect(runDependencyAudit('bun', '/proj', { exec }).status).toBe('unsupported');
    expect(exec).not.toHaveBeenCalled();
  });
});
