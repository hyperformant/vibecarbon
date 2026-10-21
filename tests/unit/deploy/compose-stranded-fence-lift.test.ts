/**
 * A compose scale killed mid-cutover (SIGINT exits 130, no rollback) leaves the
 * old server write-fenced with its writers stopped. The fence's durable marker
 * (written before the writers stop, scale-cutover.js) is what deploy's entry
 * lift reads, so single-server compose recovers the way the HA tiers do.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { liftStrandedFenceAtEntry } = await import('../../../src/lib/deploy/orchestrator.js');

let dir: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const MARKER = { node: 'myapp-prod', ip: '1.1.1.1', at: '2026-10-21T00:00:00.000Z' };

function seed(env: Record<string, unknown>) {
  dir = mkdtempSync(join(tmpdir(), 'vc-scale-fence-'));
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    JSON.stringify({ projectName: 'myapp', environments: { prod: env } }),
  );
  vi.spyOn(process, 'cwd').mockReturnValue(dir as string);
}
const readEnv = () =>
  JSON.parse(readFileSync(join(dir as string, '.vibecarbon.json'), 'utf-8')).environments.prod;

/** psql on the fenced server: reads `on` until the reset lands. */
function fencedDb() {
  const sql: string[] = [];
  let fenced = true;
  const exec = async (q: string) => {
    sql.push(q);
    if (q.startsWith('ALTER SYSTEM RESET')) fenced = false;
    if (q.includes('current_setting')) return fenced ? 'on' : 'off';
    return '';
  };
  return { sql, exec };
}

describe('deploy lifts a fence a killed compose scale left (single-server compose)', () => {
  it('lifts it on the recorded server before bring-up and clears the marker, leaving no empty ha', async () => {
    const env = { deployMode: 'compose', servers: [{ ip: '1.1.1.1' }], ha: { writeFence: MARKER } };
    seed(env);
    const db = fencedDb();
    const lines: string[] = [];
    await liftStrandedFenceAtEntry({
      tier: 'compose',
      environment: 'prod',
      envConfig: env,
      projectName: 'myapp',
      deps: { psqlFor: async () => db.exec, log: (l: string) => lines.push(l) },
    });
    expect(db.sql).toContain('ALTER SYSTEM RESET default_transaction_read_only');
    expect(lines.join('\n')).toMatch(/lifted the write fence .* \(1\.1\.1\.1\)/);
    // The marker was the only `ha` key: none left, so status does not read HA.
    expect(readEnv().ha).toBeUndefined();
  });

  it('no marker: nothing to lift, no psql', async () => {
    const psqlFor = vi.fn();
    await liftStrandedFenceAtEntry({
      tier: 'compose',
      environment: 'prod',
      envConfig: { deployMode: 'compose', servers: [{ ip: '1.1.1.1' }] },
      projectName: 'myapp',
      deps: { psqlFor },
    });
    expect(psqlFor).not.toHaveBeenCalled();
  });

  it('a lift it cannot prove warns and lets the deploy go on (the post-bring-up probe checks again)', async () => {
    const warnings: string[] = [];
    await liftStrandedFenceAtEntry({
      tier: 'compose',
      environment: 'prod',
      envConfig: {
        deployMode: 'compose',
        servers: [{ ip: '1.1.1.1' }],
        ha: { writeFence: MARKER },
      },
      projectName: 'myapp',
      deps: {
        psqlFor: async () => async () => 'on',
        // The real lift's 15 s read-back deadline, already failed.
        lift: async () => {
          throw new Error('the primary (1.1.1.1) is still write-fenced and could not be lifted');
        },
        warn: (l: string) => warnings.push(l),
      },
    });
    expect(warnings[0]).toMatch(
      /still write-fenced .*deploy checks the primary again after bring-up/,
    );
  });
});
