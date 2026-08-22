/**
 * The shared verify block must not run ssh-based checks with no handles.
 *
 * `serverIps` is populated by a step that, on the k8s tiers, has not run by
 * verify-deploy. Every ssh-based check then self-skipped with
 * "no serverIp/sshKeyPath" — and a self-skip is CORRECT for a check with no
 * way in, so nothing looked wrong. The bug was handing it no way in when the
 * handles were sitting in the project dir the whole time.
 *
 * Measured on the 2026-08-19 all-provider run:
 *   compose      27 passed /  4 skipped
 *   k8s          18 passed /  8 skipped   <- 4 extra, on every provider
 *
 * The extra four were the wal-g backup evidence pair (which did run later, at
 * verify-scale) and BOTH config canaries — `config_secret_propagation` and
 * `config_oauth_gotrue_propagation`, which never ran on k8s at any phase on
 * any provider. Those two exist specifically to cover a k8s-only gap (GoTrue
 * `valueFrom secretKeyRef`, silently missing until 2026-07-15), so the check
 * written for k8s was precisely the one k8s never got.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  fileURLToPath(new URL('../../e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
  'utf8',
);
// Comment-ONLY lines: a naive `//` stripper also eats the `//` inside URLs.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('verify block backfills ssh handles before the ssh-based checks', () => {
  const backfillAt = () => code.indexOf('serverIps = getServerIps(config.projectDir');
  const canaryAt = () => code.indexOf('runConfigCanaryChecks(');

  it('backfills serverIps when the step that sets it has not run', () => {
    expect(code).toMatch(/if \(serverIps\.length === 0\) \{\s*serverIps = getServerIps\(/);
  });

  it('backfills sshKeyPath the same way', () => {
    expect(code).toMatch(/if \(!sshKeyPath\) \{\s*sshKeyPath = getSshKeyPath\(/);
  });

  it('backfills BEFORE the config canary consumes the handles', () => {
    // Ordering is the whole point — a backfill after the consumer is a no-op.
    expect(backfillAt()).toBeGreaterThan(-1);
    expect(canaryAt()).toBeGreaterThan(-1);
    expect(backfillAt()).toBeLessThan(canaryAt());
  });

  it('backfills BEFORE sshCheckMasterIp is derived from serverIps[0]', () => {
    const derivedAt = code.indexOf('sshCheckMasterIp: string | undefined = serverIps[0]');
    expect(derivedAt).toBeGreaterThan(-1);
    expect(backfillAt()).toBeLessThan(derivedAt);
  });

  it('never overrides the failover re-point at the promoted node', () => {
    // THE hazard. verify-failover re-points sshCheckMasterIp at the PROMOTED
    // node; a backfill running after that would send every ssh check at the
    // decommissioned primary — a bug this repo already paid two nights for
    // (2026-08-10/-11). The backfill must precede the re-point, and the
    // re-point must still be there.
    const repointAt = code.indexOf('if (primaryIp) sshCheckMasterIp = primaryIp;');
    expect(repointAt, 'the failover re-point disappeared').toBeGreaterThan(-1);
    expect(backfillAt()).toBeLessThan(repointAt);
  });

  it('only backfills when empty — never re-reads over resolved handles', () => {
    // Guarded, so a lifecycle that already resolved its handles keeps them.
    const at = backfillAt();
    const before = code.slice(Math.max(0, at - 120), at);
    expect(before).toMatch(/if \(serverIps\.length === 0\) \{/);
  });
});
