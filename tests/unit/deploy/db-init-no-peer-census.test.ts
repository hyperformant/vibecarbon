/**
 * Census: the db pod's first boot never dials a peer.
 *
 * Ruling B (cold-deploy speed, Task 6): the k8s-ha standby's `seed-standby`
 * init container waited its whole ~6 minute budget for a primary that was
 * never replication-ready in its window, then exited unseeded and ran initdb
 * (8 cold runs on 2026-10-20 at 345-359 s). The serial `setupReplication`
 * reseed seeded the standby every time, so it is now the single owner of
 * standby seeding and no init container may reach the other cluster.
 *
 * The walg-restore init stays: it reads only this cluster's restore marker
 * and the backup bucket.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const BASE = join(ROOT, 'carbon/k8s/base');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const sts: Doc = load(readFileSync(join(BASE, 'db/statefulset.yaml'), 'utf-8'));
const initContainers: Doc[] = sts.spec.template.spec.initContainers ?? [];

describe('db init containers reach no peer', () => {
  it('the only init container is walg-restore', () => {
    expect(initContainers.map((c) => c.name)).toEqual(['walg-restore']);
  });

  it.each(['SEED_PRIMARY_', 'REPL_RELAY_', 'pg_basebackup'])(
    'no init container references %s',
    (needle) => {
      for (const c of initContainers) {
        expect(JSON.stringify(c), `init container ${c.name}`).not.toContain(needle);
      }
    },
  );

  it('no manifest under carbon/k8s/base references the seed ConfigMap', () => {
    const hits = walk(BASE).filter((f) =>
      readFileSync(f, 'utf-8').includes('vibecarbon-seed-standby'),
    );
    expect(hits).toEqual([]);
  });

  it('no deploy source renders or applies the seed ConfigMap', () => {
    const hits = walk(join(ROOT, 'src')).filter(
      (f) => f.endsWith('.js') && readFileSync(f, 'utf-8').includes('vibecarbon-seed-standby'),
    );
    expect(hits).toEqual([]);
  });
});
