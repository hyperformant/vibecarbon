/**
 * Census: no server-side `vc-compose run` of a service that holds a static
 * ipv4_address in any compose overlay, except inside the shared stopped-only
 * branch (TRAEFIK_VOLUME_SH).
 *
 * The class (2026-11-04, DigitalOcean compose-ha rig): a one-off `run`
 * container joins the same network as the running service and asks for the
 * same pinned address: "Address already in use". tls-restore ran
 * `run --rm ... traefik` beside a running Traefik (pinned .10 by the
 * observability overlay), so the saved certificate was never restored on a
 * warm deploy or a promoted failover node. The pinned services are derived
 * from the overlays, never hard-coded.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRAEFIK_VOLUME_SH } from '../../../src/lib/deploy/compose/tls-restore.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** Services whose compose definition carries an `ipv4_address` (comments skipped). */
function pinnedServices(yml: string): string[] {
  const pinned = new Set<string>();
  let inServices = false;
  let service: string | null = null;
  for (const raw of yml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      service = null;
      continue;
    }
    if (!inServices) continue;
    const m = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (m) service = m[1];
    else if (service && /^\s+ipv4_address:/.test(line)) pinned.add(service);
  }
  return [...pinned];
}

/** `vc-compose run` / `${VC_COMPOSE} run` calls of a pinned service in `source`. */
function offenders(source: string, pinned: string[]): string[] {
  const found: string[] = [];
  for (const line of source.split('\n')) {
    const m = line.match(/(?:vc-compose|\$\{VC_COMPOSE\}) run\b(.*)$/);
    if (!m) continue;
    const words = m[1].split(/\s+/);
    if (pinned.some((s) => words.includes(s))) found.push(line.trim());
  }
  return found;
}

const overlays = [
  ...walk(join(ROOT, 'services'), (f) => /docker-compose[^/]*\.ya?ml$/.test(f)),
  ...walk(join(ROOT, 'carbon'), (f) => /docker-compose[^/]*\.ya?ml$/.test(f)),
];
const PINNED = [...new Set(overlays.flatMap((f) => pinnedServices(readFileSync(f, 'utf8'))))];

const FRAGMENT_FILE = 'src/lib/deploy/compose/tls-restore.js';
const sources = [
  ...walk(join(ROOT, 'src'), (f) => /\.(js|sh)$/.test(f)),
  ...walk(join(ROOT, 'carbon/backup'), (f) => f.endsWith('.sh')),
];

describe('pinned services are never run beside themselves', () => {
  it('derives the pinned services from the overlays', () => {
    expect(overlays.length).toBeGreaterThan(0);
    expect(PINNED).toContain('traefik');
  });

  it('no vc-compose run of a pinned service outside the stopped-only branch', () => {
    const bad: string[] = [];
    for (const f of sources) {
      let text = readFileSync(f, 'utf8');
      // The one allowed spelling: the shared fragment's own definition.
      if (relative(ROOT, f) === FRAGMENT_FILE) {
        text = text.replace(/export const TRAEFIK_VOLUME_SH =[\s\S]*?;\n/, '');
      }
      for (const o of offenders(text, PINNED)) bad.push(`${relative(ROOT, f)}: ${o}`);
    }
    expect(bad).toEqual([]);
  });

  it('the detector bites a planted offender and ignores an unpinned service', () => {
    expect(
      offenders('x ${VC_COMPOSE} run --rm --no-deps -T --entrypoint sh traefik -c y', PINNED),
    ).toHaveLength(1);
    expect(offenders('sh vc-compose run --rm traefik sh', PINNED)).toHaveLength(1);
    expect(offenders('sh vc-compose run --rm --no-deps app-migrate', PINNED)).toEqual([]);
  });

  it('the shared fragment is the only place the run branch is spelled', () => {
    expect(offenders(TRAEFIK_VOLUME_SH, PINNED)).toHaveLength(1);
  });
});
