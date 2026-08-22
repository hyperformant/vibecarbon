import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Census: no bare `docker compose <verb>` invocation may name a service
 * that only exists in an overlay file (2026-08-09 round-A d2 RCA).
 *
 * The class: remote invocations built as `cd <dir> && docker compose
 * restart <services>` resolve service names against docker-compose.yml
 * ONLY — the `-f` overlay chain is baked into reconcile.sh/systemd at
 * deploy time and is NOT in scope for ad-hoc SSH commands. A service
 * defined only in an overlay (supavisor lives in docker-compose.prod.yml)
 * makes the WHOLE command exit 1 in ~2s having touched nothing. That is
 * how the failover app-tier restart never once executed: 3/3 failovers
 * "restarted" six services in two seconds, two verify passes rode on
 * PostgREST self-recovery, and the third failed verify-failover.
 *
 * The overlay-only set is DERIVED from the compose files, so a service
 * moving between base and overlay redraws the banned set automatically.
 * Fix pattern for flagged sites: address CONTAINERS by name
 * (`docker restart ${PROJECT_NAME}-<svc>` — container_name is stamped on
 * every service) or route through the baked reconcile flags.
 */

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

function composeServiceNames(file: string): Set<string> {
  const src = readFileSync(join(REPO, 'carbon', file), 'utf-8');
  // Top-level `services:` block keys — two-space-indented `name:` lines
  // until the next top-level key. Compose files here keep that shape
  // (volumes:/networks: are separate top-level blocks).
  const servicesBlock = src.split(/^services:\s*$/m)[1]?.split(/^[a-z]/m)[0] ?? '';
  const names = new Set<string>();
  for (const match of servicesBlock.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)) {
    names.add(match[1]);
  }
  return names;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('bare docker-compose invocations never name overlay-only services', () => {
  const base = composeServiceNames('docker-compose.yml');
  const prod = composeServiceNames('docker-compose.prod.yml');
  const overlayOnly = [...prod].filter((svc) => !base.has(svc));

  it('sanity: the derivation sees real services on both sides', () => {
    // Mutation-check anchors: db/app are base; supavisor is the overlay-only
    // member that caused the failover bug. If parsing breaks, these fail
    // before the sweep can vacuously pass.
    expect(base.has('db')).toBe(true);
    expect(base.has('app')).toBe(true);
    expect(overlayOnly).toContain('supavisor');
  });

  it('src/lib/deploy has no bare compose verb naming an overlay-only service', () => {
    const files = walk(join(REPO, 'src/lib/deploy'));
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        // Code only — prose ABOUT the failure shape (RCA comments) is not
        // an invocation.
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        // Bare = no -f and no baked-flags variable in the same invocation.
        if (!line.includes('docker compose')) continue;
        if (/-f\s|FLAGS|composeFlags/.test(line)) continue;
        const invocation = line.split('docker compose')[1] ?? '';
        for (const svc of overlayOnly) {
          if (new RegExp(`\\b${svc}\\b`).test(invocation)) {
            offenders.push(`${relative(REPO, file)}: ${line.trim()}`);
          }
        }
      }
    }
    expect(
      offenders,
      'Bare `docker compose` resolves names against docker-compose.yml only — an overlay-only ' +
        'service makes the whole command fail instantly. Address containers by name ' +
        '(docker restart ${PROJECT_NAME}-<svc>) or use the baked reconcile flags.',
    ).toEqual([]);
  });
});
