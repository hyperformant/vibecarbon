import { describe, expect, it } from 'vitest';
import { sanitizeError, sanitizeText } from '../../../src/lib/telemetry/sanitize.js';

describe('sanitizeText', () => {
  const home = '/home/alice';

  it('replaces the home directory and username with ~', () => {
    expect(sanitizeText('ENOENT: /home/alice/proj/.env.local missing', home)).toBe(
      'ENOENT: ~/proj/.env.local missing',
    );
  });

  it('redacts the bare username after the home directory is gone', () => {
    expect(sanitizeText('user alice not found in cluster', home)).toBe(
      'user [user] not found in cluster',
    );
  });

  it('redacts IPv4 and IPv6 addresses, including compressed IPv6 forms', () => {
    expect(sanitizeText('connect ETIMEDOUT 65.108.12.34:6443', home)).toBe(
      'connect ETIMEDOUT [ip]:6443',
    );
    expect(sanitizeText('listen on 2a01:4f9:c012:7c2::1 failed', home)).toBe(
      'listen on [ip] failed',
    );
    expect(sanitizeText('connect to ::1 refused', home)).toBe('connect to [ip] refused');
    expect(sanitizeText('bind fe80::1 failed', home)).toBe('bind [ip] failed');
    expect(sanitizeText('route 2001:db8:: unreachable', home)).toBe('route [ip] unreachable');
  });

  it('redacts long hex/base64 runs and token= / key=-shaped substrings', () => {
    expect(sanitizeText('auth failed for token=hcloud_9aB3xY7kQ2mN8pL4', home)).toBe(
      'auth failed for token=[redacted]',
    );
    expect(sanitizeText('bad sig 3f8a2b6e1c4d4e5f9a7b8c9d0e1f2a3b4c5d6e7f', home)).toBe(
      'bad sig [redacted]',
    );
    expect(sanitizeText('S3_SECRET_KEY=AbCdEfGh12345678IjKlMnOp', home)).toBe(
      'S3_SECRET_KEY=[redacted]',
    );
  });

  it('redacts Bearer tokens and Authorization values regardless of digit content', () => {
    expect(sanitizeText('failed: Bearer abcdefghijklmnopqrstuvwxyz', home)).toBe(
      'failed: Bearer [redacted]',
    );
    expect(sanitizeText('Authorization: abcdefghijklmnopqrstuvwxyz', home)).toBe(
      'Authorization: [redacted]',
    );
  });

  it('leaves ordinary text alone', () => {
    expect(sanitizeText('deploy failed: k3s not ready after 300s', home)).toBe(
      'deploy failed: k3s not ready after 300s',
    );
  });
});

describe('sanitizeError', () => {
  const opts = { homeDir: '/home/alice', packageRoot: '/home/alice/.nvm/lib/vibecarbon' };

  const makeError = () => {
    const err = new Error('boom at /home/alice/proj with 10.0.0.5');
    err.name = 'DeployError';
    err.stack = [
      'DeployError: boom at /home/alice/proj with 10.0.0.5',
      '    at deployK8s (/home/alice/.nvm/lib/vibecarbon/src/deploy.js:120:5)',
      '    at retry (/home/alice/.nvm/lib/vibecarbon/src/lib/retry.js:10:3)',
      '    at userland (/home/alice/proj/node_modules/other/index.js:1:1)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    return err;
  };

  it('produces sanitized message and package-relative, package-only frames', () => {
    const out = sanitizeError(makeError(), opts);
    expect(out.error_name).toBe('DeployError');
    expect(out.message).toBe('boom at ~/proj with [ip]');
    expect(out.stack).toBe('at deployK8s (src/deploy.js:120:5)\nat retry (src/lib/retry.js:10:3)');
    expect(out.stack).not.toContain('alice');
    expect(out.stack).not.toContain('node_modules');
  });

  it('caps message at 500 chars and stack at 20 frames', () => {
    const err = makeError();
    err.message = 'x'.repeat(600);
    err.stack = `DeployError: x\n${Array.from(
      { length: 30 },
      (_, i) => `    at f${i} (/home/alice/.nvm/lib/vibecarbon/src/f.js:${i}:1)`,
    ).join('\n')}`;
    const out = sanitizeError(err, opts);
    expect(out.message.length).toBe(500);
    expect(out.stack.split('\n').length).toBe(20);
  });

  it('fingerprint is stable across differing line numbers but distinct per shape', () => {
    const a = sanitizeError(makeError(), opts);
    const err2 = makeError();
    err2.stack = err2.stack?.replace('120:5', '121:9'); // moved a line
    const b = sanitizeError(err2, opts);
    expect(a.fingerprint).toBe(b.fingerprint);
    const err3 = makeError();
    err3.name = 'OtherError';
    err3.stack = err3.stack?.replace('DeployError', 'OtherError');
    const c2 = sanitizeError(err3, opts);
    expect(c2.fingerprint).not.toBe(a.fingerprint);
  });

  it('never throws — even on an error with no stack', () => {
    const bare = new Error('plain');
    bare.stack = undefined;
    const out = sanitizeError(bare, opts);
    expect(out.error_name).toBe('Error');
    expect(out.stack).toBe('(no stack)');
    expect(out.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps in-package frames when packageRoot itself lives under node_modules (npm/pnpm installs)', () => {
    const npmOpts = {
      homeDir: '/home/alice',
      packageRoot: '/home/alice/project/node_modules/vibecarbon',
    };
    const err = new Error('boom');
    err.name = 'DeployError';
    err.stack = [
      'DeployError: boom',
      '    at run (/home/alice/project/node_modules/vibecarbon/src/cli.js:10:2)',
      '    at dep (/home/alice/project/node_modules/vibecarbon/node_modules/dep/index.js:5:1)',
    ].join('\n');
    const out = sanitizeError(err, npmOpts);
    expect(out.stack).toBe('at run (src/cli.js:10:2)');
    expect(out.stack).not.toContain('node_modules');
  });
});
