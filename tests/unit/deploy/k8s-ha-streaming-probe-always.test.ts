/**
 * setupReplication asks the primary whether the standby already streams before
 * every reseed, on every deploy, cold ones included. Nothing may skip it.
 *
 * A reseed wipes the standby's PGDATA. The probe is what keeps a healthy,
 * streaming replica from being wiped on a redeploy, so a skip needs proof that
 * the standby cannot be streaming, and the deploy has none it can trust:
 *   - "this run minted the k3s token" was tried (63b9dd9) and is false proof.
 *     resolveStackK3sToken mints whenever the stack's token read fails
 *     ('errored') or comes back without one ('empty'): a state-bucket blip or
 *     stale outputs on a LIVE stack. And a minted token replaces nothing:
 *     every server ignores its user data (serverResourceOptions and
 *     workerResourceOptions, src/lib/iac/create-timeout.js), so the live
 *     standby and its database stay exactly as they were.
 * The probe costs 5.2 s on a cold deploy; a wrongly wiped replica costs a
 * reseed and, until it finishes, the pair's only replica.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('the k8s-ha streaming probe always runs', () => {
  it('setupReplication assigns the probe result unconditionally, before the reseed', () => {
    const src = readFileSync(join(SRC, 'lib/deploy/k8s/ha/index.js'), 'utf-8');
    const body = src.slice(src.indexOf('export async function setupReplication('));
    const probe = body.indexOf(
      "const probe = await perfAsync('deploy.ha.replication.streamingProbe', () =>",
    );
    expect(probe).toBeGreaterThan(-1);
    expect(body.indexOf('deploy.ha.replication.reseed.selfHeal')).toBeGreaterThan(probe);
    // No branch in front of it: the line before the probe's comment block is
    // not an `if (` and nothing in setupReplication reads a skip option.
    expect(body.slice(0, probe)).not.toMatch(/\bif \(options\.standby\w*/);
  });

  it('no deploy code carries a "fresh cluster" skip signal', () => {
    const offenders = walk(SRC).filter((f) =>
      /\b(freshCluster|standbyFresh)\b/.test(readFileSync(f, 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });
});
