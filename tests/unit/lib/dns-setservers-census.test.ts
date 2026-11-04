/**
 * setServers census: a multi-server `setServers([...])` hands c-ares one
 * resolver that only moves to the next server on a timeout/SERVFAIL/REFUSED.
 * An NXDOMAIN or stale answer from the first server is final, so the second is
 * never asked. The rule: outside public-dns-lookup.js (which builds one
 * Resolver per server), no src file may call setServers with more than one
 * server. This walks src/, so a new call site is covered the day it lands.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../src');
const ALLOWED = 'lib/deploy/public-dns-lookup.js';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  );
}

describe('setServers census', () => {
  it('no src file outside public-dns-lookup.js pins more than one server', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel === ALLOWED) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.setServers\(\s*\[([^\]]*)\]/g)) {
        const servers = m[1].split(',').filter((s) => s.trim());
        if (servers.length > 1) offenders.push(`${rel}: setServers([${m[1].trim()}])`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
