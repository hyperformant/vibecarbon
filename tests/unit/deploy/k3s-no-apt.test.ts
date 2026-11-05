/**
 * k3s nodes boot without apt. Each of these scripts used to spend 27-60 s on
 * `apt-get update` plus an install of tools nothing consumes: curl ships on
 * the images, jq has no user on a node, and k3s image delivery goes through
 * `k3s ctr`, never docker. This walks the whole directory, so a new init
 * script (or an old one growing the lines back) is covered without a list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = join(fileURLToPath(new URL('../../..', import.meta.url)), 'carbon/cloud-init/k3s');
const scripts = readdirSync(DIR)
  .filter((f) => f.endsWith('.sh'))
  .map((f) => ({ name: f, lines: readFileSync(join(DIR, f), 'utf8').split('\n') }));
const inits = scripts.filter((s) => s.name.endsWith('-init.sh'));

/** Lines that execute: comments dropped. */
const code = (lines: string[]) => lines.filter((l) => !l.trim().startsWith('#'));

describe('k3s cloud-init scripts', () => {
  it('walk finds all six init scripts, so the assertions below are not vacuous', () => {
    expect(inits.map((s) => s.name).sort()).toEqual([
      'db-init.sh',
      'do-db-init.sh',
      'do-master-init.sh',
      'do-worker-init.sh',
      'master-init.sh',
      'worker-init.sh',
    ]);
  });

  it.each(scripts.map((s) => [s.name, s] as const))('%s never runs apt', (_n, s) => {
    expect(code(s.lines).filter((l) => /\bapt(-get)?\b/.test(l))).toEqual([]);
  });

  it.each(inits.map((s) => [s.name, s] as const))('%s writes no apt phase mark', (_n, s) => {
    expect(code(s.lines).filter((l) => /^\s*_m a\b/.test(l))).toEqual([]);
  });

  it.each(inits.map((s) => [s.name, s] as const))('%s keeps the network phase mark', (_n, s) => {
    expect(code(s.lines).filter((l) => /^\s*_m n\b/.test(l))).toHaveLength(1);
  });

  it.each(scripts.map((s) => [s.name, s] as const))('%s runs no jq or docker command', (_n, s) => {
    const bare = /(^|[\s;|&(`])(jq|docker)\s/;
    expect(code(s.lines).filter((l) => bare.test(l))).toEqual([]);
  });

  it('every Hetzner script with a dhcpcd trigger asks at the first retry', () => {
    const hetzner = inits.filter((s) => !s.name.startsWith('do-'));
    const triggers = hetzner.flatMap((s) =>
      code(s.lines)
        .filter((l) => l.includes('DHCP_TRIGGERED" = "false"'))
        .map((l) => ({ file: s.name, line: l.trim() })),
    );
    expect(triggers.map((t) => t.file).sort()).toEqual([
      'db-init.sh',
      'master-init.sh',
      'worker-init.sh',
    ]);
    for (const t of triggers) expect(t.line).toContain('$RETRY_COUNT -ge 1 ]');
  });

  it('no comment still describes a 30 s wait before dhcpcd', () => {
    for (const s of inits.filter((x) => !x.name.startsWith('do-'))) {
      const stale = s.lines.filter((l) => /no lease after 30s|After 30s with no 10\.0/.test(l));
      expect(stale, s.name).toEqual([]);
    }
  });
});
