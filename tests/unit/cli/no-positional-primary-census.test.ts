/**
 * Census of the "servers[0] means the primary" class (backup/restore integrity H4).
 *
 * A failover swaps `role` in place and leaves servers[] order alone, so after
 * one, index 0 is the RETIRED node. Backup, destroy, status, restore and the
 * compose scale each read servers[0] as "the primary" and acted on that node.
 * Fixing each site would leave the next one open, so this walks all of src/
 * and fails on any positional index-0 read of a servers list that is not on
 * the reason-tagged allowlist. Everything else asks resolvePrimary.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/**
 * The ways to pick "the primary" out of a servers list by hand:
 *   - `servers[0]`, `servers?.[0]`, `envConfig.servers?.[0]`
 *   - `servers.at(0)`
 *   - `servers.find(...)` whose predicate tests role === 'primary' or
 *     name === 'primary' | 'master' (also `resizableServers` and the like)
 */
const POSITIONAL_PRIMARY_RE = /\bservers\s*\??\.?\s*\[\s*0\s*\]/i;
const AT_ZERO_RE = /\bservers\s*\??\.at\(\s*0\s*\)/i;
const FIND_PRIMARY_RE =
  /servers\s*\??\.find\([^\n]*(role\s*===\s*('primary'|PRIMARY\b)|name\s*===\s*'(primary|master)')/i;
const PATTERNS = [POSITIONAL_PRIMARY_RE, AT_ZERO_RE, FIND_PRIMARY_RE];

/** Files allowed to pick a server by hand, each with why that is not "find the primary". */
const ALLOWED: Record<string, string> = {
  'src/lib/cli/resolve-primary.js':
    'the resolver itself: single-node modes (compose, kubernetes) have exactly one master, so index 0 is the only server by definition',
  'src/lib/deploy/compose/ha-role-swap.js':
    'role classifier: reads the persisted promoted/retired roles of a swapped pair, the data the resolver also reads',
  'src/lib/deploy/compose/ha.js':
    'role writer: swapComposeHaRoles reads the old roles in order to flip them, one separable step',
  'src/scale.js':
    'the resize menu offers primary and standby as labelled choices; it does not act on "the" primary',
  'src/restore.js': 'Task 7 converts: the compose-ha reseed block still reads the roles by hand',
  'src/lib/cloudflare-dns.js':
    'setupHA receives an explicit [primary, standby] list from the deploy effect that just provisioned them; it is a target list, not a lookup',
  'src/lib/digitalocean-dns.js':
    'setupHA receives an explicit [primary, standby] list from the deploy effect that just provisioned them; it is a target list, not a lookup',
  'src/lib/hetzner-dns.js':
    'setupHA receives an explicit [primary, standby] list from the deploy effect that just provisioned them; it is a target list, not a lookup',
  'src/lib/linode-dns.js':
    'setupHA receives an explicit [primary, standby] list from the deploy effect that just provisioned them; it is a target list, not a lookup',
  'src/lib/scaleway-dns.js':
    'setupHA receives an explicit [primary, standby] list from the deploy effect that just provisioned them; it is a target list, not a lookup',
  'src/lib/vultr-dns.js':
    'setupHA receives an explicit [primary, standby] list from the deploy effect that just provisioned them; it is a target list, not a lookup',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

function hits(file: string): number[] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .flatMap((line, i) =>
      !isComment(line) && PATTERNS.some((re) => re.test(line)) ? [i + 1] : [],
    );
}

describe('no positional servers[0] primary under src/', () => {
  const files = walk(join(ROOT, 'src'));

  it('walks a real tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every servers[0] read is on the allowlist', () => {
    const offenders = files.flatMap((f) => {
      const rel = relative(ROOT, f);
      return ALLOWED[rel] ? [] : hits(f).map((n) => `${rel}:${n}`);
    });
    expect(offenders, 'ask resolvePrimary(envConfig) instead of servers[0]').toEqual([]);
  });

  it('the allowlist does not rot: every entry exists and still reads servers[0]', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(existsSync(join(ROOT, rel)), `${rel} exists`).toBe(true);
      expect(hits(join(ROOT, rel)).length, `${rel} still needs its entry`).toBeGreaterThan(0);
    }
  });
});
