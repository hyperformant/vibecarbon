/**
 * configurePrimaryForReplication extraction (spec 2026-07-16). File-content
 * guards (the phases are exercised on real infra by the k8s-ha e2e; these
 * pin the structure): the export exists, setupReplication delegates to it,
 * and the primaryConfigured flag short-circuits it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/ha/index.js'), 'utf-8');

describe('configurePrimaryForReplication', () => {
  it('is exported and owns the primary-side perf slices', () => {
    expect(src).toMatch(/export async function configurePrimaryForReplication/);
    // the seven phases live INSIDE the extracted function (appear after its
    // declaration and before setupReplication's declaration)
    const fnStart = src.indexOf('export async function configurePrimaryForReplication');
    const setupStart = src.indexOf('export async function setupReplication');
    const body = src.slice(fnStart, setupStart);
    for (const slice of [
      'deploy.ha.replication.primaryInit',
      'deploy.ha.replication.dbHostPort',
      'deploy.ha.replication.hba',
      'deploy.ha.replication.primaryRestart',
      'deploy.ha.replication.rolloutRestart',
      'deploy.ha.replication.rolloutStatus',
      'deploy.ha.replication.reloadPostgrest',
    ]) {
      expect(body).toContain(slice);
    }
  });

  it('setupReplication delegates and honors primaryConfigured', () => {
    const setupBody = src.slice(src.indexOf('export async function setupReplication'));
    expect(setupBody).toMatch(/primaryConfigured/);
    expect(setupBody).toMatch(/configurePrimaryForReplication\(/);
  });
});

describe('fan-out chaining + streaming fast-path', () => {
  const effects = readFileSync(
    join(__dirname, '../../../src/lib/deploy/effects/k8s-ha.js'),
    'utf-8',
  );

  it('earlyPrep chains transport → primary completion → primary config, opportunistically', () => {
    const prep = effects.slice(effects.indexOf('const earlyPrep'));
    expect(prep).toMatch(/prepareReplicationTransport\([\s\S]+?configurePrimaryForReplication\(/);
    expect(effects).toMatch(/ctx\.primaryReplicationConfigured/);
  });

  it('setupReplication receives the flag', () => {
    expect(effects).toMatch(/primaryConfigured:\s*ctx\.primaryReplicationConfigured === true/);
  });

  it('setupReplication probes streaming unconditionally before the reseed block', () => {
    const idx = src.indexOf('export async function setupReplication');
    const body = src.slice(idx);
    const probeIdx = body.indexOf('deploy.ha.replication.streamingProbe');
    const reseedIdx = body.indexOf('deploy.ha.replication.reseed.resolvePvc');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(reseedIdx).toBeGreaterThan(probeIdx); // probe comes first
  });
});
