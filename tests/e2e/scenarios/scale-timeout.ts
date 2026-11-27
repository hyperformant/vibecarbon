import type { Provider } from './types.js';

/**
 * The scale step's budget: a guard against a hung `vibecarbon scale`, not a
 * performance gate. 35 min covers compose-ha's two serial halves, about
 * 12-15 min each through a remote build, an image pull and a compose up
 * (k8s e2e fanout5, 2026-05-01, timed out at the old 25 min).
 */
export const SCALE_STEP_TIMEOUT_MS = 2_100_000;

/**
 * Providers whose in-place resize can outlast that budget on its own.
 *
 * Vultr: a resize keeps the server running while Vultr moves it to a host
 * with room, then reboots it once. Its provider waits until the API reports
 * the new plan (terraform-provider-vultr waitForPlanUpgrade, which allows
 * 60 min). In perf run 45922250720 (2026-11-27), k8s resized its master and
 * worker in 14 s but its db in 10.7 min. k8s-ha's primary servers took 10.7
 * to 14.1 min. Its standby, resized after the primary, was still resizing
 * 20.3 min in when the 35 min budget killed the step. That is two stacks
 * back to back at up to 25 min each, plus the pod waits.
 */
const SCALE_STEP_TIMEOUT_BY_PROVIDER: Partial<Record<Provider, number>> = {
  vultr: 3_600_000,
};

/** The scale step's budget on `provider`. */
export function scaleStepTimeoutMs(provider: Provider): number {
  return SCALE_STEP_TIMEOUT_BY_PROVIDER[provider] ?? SCALE_STEP_TIMEOUT_MS;
}
