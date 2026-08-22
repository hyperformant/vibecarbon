import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const fixturePath = join(__dirname, '../../fixtures/supabase-chart-workloads.json');

describe('supabase chart workload snapshot', () => {
  it('exists and matches the pinned chart version', async () => {
    const snapshot = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    const k3s = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const pin = k3s.match(/SUPABASE_HELM_CHART_VERSION = '([^']+)'/)?.[1];
    expect(snapshot.chartVersion).toBe(pin);
    // The app-tier Deployments the spec's zero-list must cover. If the chart
    // pin bump adds/removes one, regenerate the snapshot:
    //   node scripts/gen-chart-workloads-snapshot.mjs
    expect(snapshot.deployments.length).toBeGreaterThanOrEqual(8);
    expect(snapshot.statefulsets).toContain('db');
    expect(snapshot.deployments).not.toContain('db');
  });
});

const overlayPath = join(__dirname, '../../../carbon/k8s/values/supabase.standby.values.yaml');

describe('standby zero overlay', () => {
  const snapshot = () => JSON.parse(readFileSync(fixturePath, 'utf-8'));
  const overlay = () => readFileSync(overlayPath, 'utf-8');

  it('zeroes every Deployment the pinned chart renders (none escape)', () => {
    for (const comp of snapshot().deployments) {
      // exact scalar block, 2-space component indent under `deployment:`
      expect(overlay()).toMatch(
        new RegExp(`^ {2}${comp}:\\n(?:    #.*\\n)*    replicaCount: 0$`, 'm'),
      );
    }
  });

  it('never touches the db StatefulSet or repl-gateway', () => {
    expect(overlay()).not.toMatch(/^ {2}db:/m);
    expect(overlay()).not.toContain('repl-gateway');
  });

  it('contains only scalar keys — no lists, no placeholders', () => {
    expect(overlay()).not.toMatch(/^\s*- /m); // helm replaces lists wholesale
    expect(overlay()).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  // Scope a top-level block the same way standby-config.js does: from the
  // `key:` line to the next non-indented, non-comment line.
  const topBlock = (text: string, key: string): string => {
    const lines = text.split('\n');
    const start = lines.indexOf(`${key}:`);
    if (start === -1) return '';
    const block: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i]) && !lines[i].startsWith('#')) break;
      block.push(lines[i]);
    }
    return block.join('\n');
  };

  it('does not zero components the chart never renders (dead weight)', () => {
    const deployBlock = topBlock(overlay(), 'deployment');
    const comps = [...deployBlock.matchAll(/^ {2}([a-z]+):$/gm)].map((m) => m[1]);
    expect(comps.length).toBeGreaterThan(0);
    for (const comp of comps) expect(snapshot().deployments).toContain(comp);
  });

  it('disables persistence for every chart PVC not bound by the db StatefulSet', () => {
    // db + pgsodium are consumed by the db StatefulSet (replicas 1) and bind
    // immediately. Every OTHER chart PVC belongs to a zeroed Deployment:
    // WaitForFirstConsumer + zero consumers = Pending forever = helm --wait
    // blocked for its full 15m (RCA 2026-07-17 e4 rig).
    const exempt = new Set(['db', 'pgsodium']);
    const persistenceBlock = topBlock(overlay(), 'persistence');
    for (const pvc of snapshot().pvcs.filter((p: string) => !exempt.has(p))) {
      expect(persistenceBlock).toMatch(
        new RegExp(`^ {2}${pvc}:\\n(?:    #.*\\n)*    enabled: false$`, 'm'),
      );
    }
    // and nothing exempt is touched — the db's PVCs must keep persistence
    for (const pvc of exempt) {
      expect(persistenceBlock).not.toMatch(new RegExp(`^ {2}${pvc}:$`, 'm'));
    }
  });

  it('fixture records the chart PVC set (regen on pin bump)', () => {
    expect(Array.isArray(snapshot().pvcs)).toBe(true);
    expect(snapshot().pvcs).toContain('db');
    expect(snapshot().pvcs).toContain('storage');
  });
});
