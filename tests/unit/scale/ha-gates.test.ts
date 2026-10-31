/**
 * scale's HA gates (HA-correctness final review I4, with C2's restore gate).
 *
 * scale used to ignore the failover journal and the retirement state: it
 * could resize a node mid-promote, or boot a stale ex-primary a failover
 * retired before any deploy rebuilt it. Now:
 *   - a journal refuses every HA scale (assertNoFailoverInFlight, action scale);
 *   - a target the persisted roles call retired refuses (compose-ha: the chosen
 *     servers; k8s-ha: both clusters, since a k8s-ha scale applies to both).
 * restore gets the same journal refusal, ahead of its prompts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertScaleNotRetired } from '../../../src/scale.js';

const ROOT = join(__dirname, '../../..');

/** A compose-HA pair a failover swapped, not yet reconverged: 10.0.0.1 is retired. */
const swapped = {
  deployMode: 'compose-ha',
  deployedAt: '2026-10-01T00:00:00.000Z',
  lastFailover: '2026-10-05T00:00:00.000Z',
  servers: [
    { name: 'myapp-prod-primary', role: 'standby', ip: '10.0.0.1' },
    { name: 'myapp-prod-standby', role: 'primary', ip: '10.0.0.2' },
  ],
};

describe('assertScaleNotRetired', () => {
  it('refuses a retired target and names the deploy that rebuilds it', () => {
    expect(() =>
      assertScaleNotRetired({
        environment: 'prod',
        envConfig: swapped,
        targetIps: ['10.0.0.2', '10.0.0.1'],
      }),
    ).toThrow(
      /Refusing to scale "prod": a failover retired 10\.0\.0\.1 .*run vibecarbon deploy prod first, then scale/,
    );
  });

  it('allows scaling the promoted primary alone', () => {
    expect(() =>
      assertScaleNotRetired({ environment: 'prod', envConfig: swapped, targetIps: ['10.0.0.2'] }),
    ).not.toThrow();
  });

  it('allows everything once a deploy reconverged the pair', () => {
    expect(() =>
      assertScaleNotRetired({
        environment: 'prod',
        envConfig: { ...swapped, deployedAt: '2026-10-06T00:00:00.000Z' },
        targetIps: ['10.0.0.1', '10.0.0.2'],
      }),
    ).not.toThrow();
  });

  it('k8s-ha: the retired cluster is ha.standby after a swap', () => {
    expect(() =>
      assertScaleNotRetired({
        environment: 'prod',
        envConfig: {
          deployMode: 'kubernetes',
          deployedAt: '2026-10-01T00:00:00.000Z',
          lastFailover: '2026-10-05T00:00:00.000Z',
          ha: {
            enabled: true,
            primary: { masterIp: '10.1.0.1' },
            standby: { masterIp: '10.2.0.1' },
          },
        },
        targetIps: ['10.1.0.1', '10.2.0.1'],
      }),
    ).toThrow(/a failover retired 10\.2\.0\.1/);
  });
});

describe('census: scale and restore refuse on a journal before their prompts', () => {
  const body = (file: string, from: string) => {
    const text = readFileSync(join(ROOT, file), 'utf-8');
    return text.slice(text.indexOf(from));
  };

  it('scale run() gates before dispatching to a strategy', () => {
    const run = body('src/scale.js', 'export async function run(args)');
    const gate = run.indexOf(
      "assertNoFailoverInFlight({ environment, envConfig, action: 'scale' })",
    );
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(run.indexOf('await SCALE_STRATEGIES[tier]'));
  });

  it('compose scale checks the chosen servers against the retired sides', () => {
    const fn = body('src/scale.js', 'async function scaleCompose(');
    expect(fn.slice(0, fn.indexOf('// Select new server type'))).toMatch(/assertScaleNotRetired\(/);
  });

  it('restore run() gates before the backup prompt and the prod confirmation', () => {
    const run = body('src/restore.js', 'export async function run(args)');
    const gate = run.indexOf("action: 'restore'");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(run.indexOf('pickInteractiveSource('));
    expect(gate).toBeLessThan(run.indexOf('confirmProdOrExit('));
  });
});
