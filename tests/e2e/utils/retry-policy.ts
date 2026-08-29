/**
 * The retry-on-flake decision, extracted pure so it is unit-testable.
 *
 * Policy (see runner.ts's runScenario wrapper, the only caller):
 *   - Retries are OPT-IN (E2E_RETRY_FLAKES=1): they double worst-case
 *     matrix wall-clock, so quiet-by-default.
 *   - Only an `infra`-category failure retries — never 'unknown' (state
 *     left behind is unknown) or 'regression' (re-running won't fix code).
 *   - A keep flag BLOCKS the retry: the kept rig still owns the env prefix
 *     (server names, DNS records, Pulumi stacks) the retry would redeploy
 *     into — a guaranteed collision, not a second chance. Discovered live
 *     2026-08-28 (e4 retry armed together with --keep-on-fail); keep wins,
 *     and the caller says so loudly.
 */

export type FlakeRetryDecision = 'retry' | 'no-retry' | 'blocked-by-keep';

export function decideFlakeRetry(opts: {
  status: string;
  failureCategory?: string;
  env?: NodeJS.ProcessEnv;
}): FlakeRetryDecision {
  const env = opts.env ?? process.env;
  const retryWarranted =
    env.E2E_RETRY_FLAKES === '1' && opts.status !== 'pass' && opts.failureCategory === 'infra';
  if (!retryWarranted) return 'no-retry';
  if (env.VC_KEEP_ON_FAILURE === '1' || env.VC_KEEP_ALWAYS === '1') return 'blocked-by-keep';
  return 'retry';
}
