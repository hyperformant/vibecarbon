/**
 * The backup CronJob's primary/standby guard must FAIL LOUD when it cannot
 * prove which one it is talking to.
 *
 * Latent false-green found during the 2026-08-16 backup RCA (run 31927810430):
 * the guard compared `$(psql ... pg_is_in_recovery())` inside a `[ ... ]`
 * test. When psql itself fails (database starting up, exec transport broken),
 * the substitution is EMPTY, `"" != "f"` is true, and the job logs "skipping
 * base backup" and exits 0 — a nightly backup that silently succeeds while
 * never backing anything up. The guard may only skip on a literal `t`
 * (genuine standby), proceed on a literal `f`, and must exit non-zero on
 * anything else, including a failed probe.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CRONJOB = join(ROOT, 'carbon', 'k8s', 'base', 'backup', 'cronjob.yaml');

describe('backup CronJob recovery guard', () => {
  const script = readFileSync(CRONJOB, 'utf-8');

  it('never maps a failed recovery probe to "skip and succeed"', () => {
    // The failure-shaped pattern: psql substituted directly into a test, where
    // an error collapses to the empty string and reads as "standby".
    expect(script).not.toMatch(/\[\s*"\$\(psql/);
  });

  it('a failed probe exits non-zero with its own message', () => {
    // The probe's exit status must be checked explicitly and be loud.
    expect(script).toMatch(/pg_is_in_recovery/);
    expect(script).toMatch(/recovery probe failed/i);
  });

  it('only a literal t skips, only a literal f proceeds, anything else fails', () => {
    // A case with an explicit catch-all that exits non-zero: unexpected
    // output (error text, empty, warnings) can never be read as "standby".
    expect(script).toMatch(/case\s+"\$REC"\s+in/);
    expect(script).toMatch(/\*\)[\s\S]{0,400}exit 1/);
  });
});
