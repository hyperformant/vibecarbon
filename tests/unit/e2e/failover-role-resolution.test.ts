/**
 * Post-failover role resolution — the CLASS census.
 *
 * `failoverComposeHA` persists a compose-HA failover by flipping the `role`
 * FIELD on each `servers[]` entry (src/lib/deploy/compose/ha.js: "swap
 * primary/standby roles so subsequent commands reflect reality"). It
 * deliberately leaves the ARRAY ORDER and the server NAMES alone — the droplet
 * named `<project>-<env>-primary` keeps that name forever, because the name is
 * a Pulumi resource identity, not a role.
 *
 * Every reader that answers "which node is the primary?" therefore has to
 * consult `role`. Two of them did not, and both silently returned the OLD
 * primary after a failover:
 *
 *   - tests/e2e/checks/replication.ts  resolveHaDbIps
 *   - tests/e2e/utils/ssh.ts           getServerIps
 *   - src/failover.js                  identifyServers
 *
 * The consequence (2026-08-10 and 2026-08-11 d2/compose-ha runs): verify-failover
 * pointed its DNS gate and every SSH-gated check at the decommissioned old
 * primary. Worse, it had been PASSING for the wrong reason — until 6affb594
 * made "stop the old primary" actually stop it, the old primary kept serving,
 * so the checks passed against a node the failover was supposed to retire, and
 * replication_failover_continuity "found" its marker on the very node the
 * marker had been written to.
 *
 * These tests pin the property on every member of the class: given a config in
 * the exact shape failoverComposeHA persists, the promoted node is the primary.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identifyServers } from '../../../src/failover.js';
import { resolveHaDbIps } from '../../e2e/checks/replication.js';
import { getServerIps } from '../../e2e/utils/ssh.js';

/** The old primary (nyc3) — demoted by the failover, services stopped. */
const OLD_PRIMARY = '159.203.64.163';
/** The promoted standby (sfo3) — now serving, now the write target. */
const PROMOTED = '146.190.161.189';

/**
 * A compose-HA environment exactly as `failoverComposeHA` leaves it: `role`
 * flipped in place, array order and names untouched, `region`/`secondaryRegion`
 * swapped, `ha.failoverRegion` pointed back at the old primary's region.
 */
function postFailoverComposeHaEnv() {
  return {
    domain: 'd2.do.appcarbon.dev',
    region: 'sfo3',
    secondaryRegion: 'nyc3',
    lastFailover: '2026-08-11T18:37:31.000Z',
    ha: { enabled: true, failoverRegion: 'nyc3' },
    servers: [
      { name: 'testapp-d2-primary', ip: OLD_PRIMARY, role: 'standby', region: 'nyc3' },
      { name: 'testapp-d2-standby', ip: PROMOTED, role: 'primary', region: 'sfo3' },
    ],
  };
}

/** The same environment BEFORE any failover — roles in their deployed order. */
function preFailoverComposeHaEnv() {
  return {
    domain: 'd2.do.appcarbon.dev',
    region: 'nyc3',
    secondaryRegion: 'sfo3',
    ha: { enabled: true, failoverRegion: 'sfo3' },
    servers: [
      { name: 'testapp-d2-primary', ip: OLD_PRIMARY, role: 'primary', region: 'nyc3' },
      { name: 'testapp-d2-standby', ip: PROMOTED, role: 'standby', region: 'sfo3' },
    ],
  };
}

describe('post-failover role resolution (compose-HA)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'failover-roles-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (env: unknown) =>
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ environments: { d2: env } }),
      'utf-8',
    );

  describe('resolveHaDbIps', () => {
    it('returns the PROMOTED node as primary after a failover', () => {
      write(postFailoverComposeHaEnv());
      expect(resolveHaDbIps(dir, 'd2')).toEqual({
        primaryIp: PROMOTED,
        standbyIp: OLD_PRIMARY,
      });
    });

    it('returns the deployed primary before any failover', () => {
      write(preFailoverComposeHaEnv());
      expect(resolveHaDbIps(dir, 'd2')).toEqual({
        primaryIp: OLD_PRIMARY,
        standbyIp: PROMOTED,
      });
    });
  });

  describe('getServerIps', () => {
    it('lists the PROMOTED node first after a failover (serverIps[0] is the master)', () => {
      write(postFailoverComposeHaEnv());
      expect(getServerIps(dir, 'd2')[0]).toBe(PROMOTED);
    });

    it('still lists both nodes after a failover', () => {
      write(postFailoverComposeHaEnv());
      expect(getServerIps(dir, 'd2').sort()).toEqual([PROMOTED, OLD_PRIMARY].sort());
    });

    it('lists the deployed primary first before any failover', () => {
      write(preFailoverComposeHaEnv());
      expect(getServerIps(dir, 'd2')[0]).toBe(OLD_PRIMARY);
    });

    it('leaves k8s node ordering (master/supabase/worker) untouched — no primary role there', () => {
      write({
        region: 'nbg1',
        servers: [
          { name: 'master', ip: '10.0.0.1', role: 'master' },
          { name: 'supabase', ip: '10.0.0.2', role: 'supabase' },
          { name: 'worker-1', ip: '10.0.0.3', role: 'worker' },
        ],
      });
      expect(getServerIps(dir, 'd2')).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    });
  });

  describe('identifyServers', () => {
    it('returns the PROMOTED node as primary after a failover', () => {
      const servers = identifyServers('d2', postFailoverComposeHaEnv(), {});
      expect(servers?.primary.ip).toBe(PROMOTED);
      expect(servers?.standby.ip).toBe(OLD_PRIMARY);
    });

    it('returns the deployed primary before any failover', () => {
      const servers = identifyServers('d2', preFailoverComposeHaEnv(), {});
      expect(servers?.primary.ip).toBe(OLD_PRIMARY);
      expect(servers?.standby.ip).toBe(PROMOTED);
    });

    it('still prefers the nested ha.primary/ha.standby block (k8s-HA swaps it wholesale)', () => {
      const servers = identifyServers(
        'e4',
        {
          region: 'nbg1',
          secondaryRegion: 'hel1',
          ha: {
            enabled: true,
            primary: { masterIp: PROMOTED, region: 'hel1' },
            standby: { masterIp: OLD_PRIMARY, region: 'nbg1' },
          },
          servers: [
            { name: 'primary', ip: OLD_PRIMARY },
            { name: 'standby', ip: PROMOTED },
          ],
        },
        {},
      );
      expect(servers?.primary.ip).toBe(PROMOTED);
    });
  });

  describe('the class agrees', () => {
    it('all three resolvers name the same primary after a failover', () => {
      const env = postFailoverComposeHaEnv();
      write(env);
      const fromRepl = resolveHaDbIps(dir, 'd2').primaryIp;
      const fromSsh = getServerIps(dir, 'd2')[0];
      const fromCli = identifyServers('d2', env, {})?.primary.ip;
      expect(new Set([fromRepl, fromSsh, fromCli])).toEqual(new Set([PROMOTED]));
    });
  });
});

/**
 * CLI command call sites — the same class, one layer up.
 *
 * `resolveEnvContext({ serverIp })` is the shared "which server does this
 * command talk to?" seam (src/lib/cli/env-context.js). Its own docs spell the
 * hazard out: 'primary' picks the CURRENT primary by role because "a prior
 * failover may have swapped roles while preserving array order, so servers[0]
 * is not reliably the primary". 'first' is servers[0] — the RETIRED node after
 * a failover.
 *
 * backup.js asked for 'first', which would have archived a stopped, demoted
 * database. This is a source-level census rather than a behavioral test so a
 * NEW command cannot join the family with the wrong selector unnoticed.
 */
describe('resolveEnvContext serverIp selectors (CLI call-site census)', () => {
  const srcDir = join(import.meta.dirname, '../../../src');

  /**
   * Every `serverIp:` key in a file that calls resolveEnvContext.
   *
   * Captures the RAW right-hand side rather than matching the two known
   * selectors — matching only `'first'|'primary'` would let any other spelling
   * (double quotes, a variable, a ternary) slip through the census unseen,
   * which is exactly the kind of silent escape this class keeps producing.
   */
  const callSites = (): Array<{ file: string; raw: string }> => {
    const out: Array<{ file: string; raw: string }> = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        if (p.endsWith(join('cli', 'env-context.js'))) continue; // the seam itself
        const src = readFileSync(p, 'utf-8');
        if (!src.includes('resolveEnvContext')) continue;
        // Anchored to line-start property position: `serverIp:` also appears
        // in prose inside restore.js's explanatory comment, and a census that
        // trips over its own documentation is a census nobody keeps.
        for (const m of src.matchAll(/^\s*serverIp:\s*([^,\n}]+)/gm)) {
          out.push({ file: p, raw: m[1].trim() });
        }
      }
    };
    walk(srcDir);
    return out;
  };

  it('finds the known call sites (census is actually looking at something)', () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(sites.some((s) => s.file.endsWith('backup.js'))).toBe(true);
    expect(sites.some((s) => s.file.endsWith('restore.js'))).toBe(true);
  });

  it('every serverIp selector is one of the two the seam defines (no novel spellings)', () => {
    const unknown = callSites()
      .filter((s) => s.raw !== "'first'" && s.raw !== "'primary'")
      .map((s) => `${s.file}: ${s.raw}`);
    expect(unknown).toEqual([]);
  });

  it("no command resolves its target server as 'first' — post-failover that is the retired node", () => {
    const offenders = callSites()
      .filter((s) => s.raw === "'first'")
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});
