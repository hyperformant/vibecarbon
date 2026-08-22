/**
 * H-1 regression guard: SSH host-key verification must be pinned per-env.
 *
 * No ssh/scp code path in the deploy/backup/restore/scale surface may bypass
 * host-key verification with `UserKnownHostsFile=/dev/null` +
 * `StrictHostKeyChecking=no`. Every path pins against a per-env known_hosts
 * file (`.vibecarbon/known_hosts_<env>`) with accept-new/yes.
 *
 * (`GlobalKnownHostsFile=/dev/null` IS allowed — that only ignores the
 * system-wide known_hosts, it does not disable verification.)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

// SSH-bearing files remediated in this change.
const OWNED_SSH_FILES = [
  'src/lib/host-keys.js',
  'src/lib/ssh.js',
  'src/lib/deploy/compose/index.js',
  'src/lib/deploy/image.js',
  'src/lib/deploy/remote-build.js',
  'src/lib/deploy/k8s/k3s.js',
  'src/lib/deploy/utils.js',
  'src/lib/deploy/k8s/ha/index.js',
];

/**
 * Strip comments so prose describing the OLD behavior ("we no longer use
 * /dev/null + no") doesn't trip the guard — we only care about live code.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
      // strip inline line-comment tail
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

describe('H-1: no ssh/scp path disables host-key verification', () => {
  it.each(OWNED_SSH_FILES)('%s never uses the /dev/null + no bypass in code', (rel) => {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf-8'));
    expect(code).not.toContain('UserKnownHostsFile=/dev/null');
    expect(code).not.toContain('StrictHostKeyChecking=no');
  });

  it.each(OWNED_SSH_FILES)('%s references per-env known_hosts pinning', (rel) => {
    const code = readFileSync(join(ROOT, rel), 'utf-8');
    // Each file either derives the per-env known_hosts path or references it
    // by env, and pins host keys — either with a literal accept-new option or
    // by building its ssh options via the shared host-keys.js builders (the
    // single source of truth, which carries accept-new).
    expect(/knownHosts|known_hosts|UserKnownHostsFile=\$/.test(code)).toBe(true);
    expect(
      code.includes('StrictHostKeyChecking=accept-new') || /buildHostKeyOpts\w*\(/.test(code),
    ).toBe(true);
  });
});
