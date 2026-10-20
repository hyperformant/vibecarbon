/**
 * Which lifecycle step proves the observability add-on (Grafana, Prometheus),
 * for which deploy mode.
 *
 * k8s-ha runs a PILOT-LIGHT standby: its deploy skips the observability apply
 * entirely (src/lib/deploy/k8s/k3s.js "[pilot-standby] skipping
 * observability"), and failover only promotes the database and scales the
 * app tier up (src/failover.js, acme-issuer-policy.js: "a pilot-standby never
 * installs observability"). So right after failover the promoted cluster has
 * no Grafana by design, and `/admin/grafana/*` falls through to the app's SPA
 * (200 text/html). Run 2026-10-20 (Hetzner k8s-ha) graded verify-failover red
 * on exactly that: grafana_route_protected "served 200 without a cookie",
 * grafana_health and prometheus_targets "200 but not JSON (text/html)".
 *
 * The redeploy that turns the promoted cluster into a full primary is
 * `reconverge-deploy`, so that is where k8s-ha proves observability came back.
 *
 * compose-ha is unaffected: its standby runs the full compose stack, add-ons
 * included (src/lib/deploy/effects/compose-ha.js starts BOTH servers with the
 * same haServiceOpts), so Grafana is already up when it is promoted.
 */

import type { VerificationResult } from './types.js';

/** Every check runObservabilityChecks reports, in its order. */
export const OBSERVABILITY_CHECK_NAMES = [
  'grafana_route_protected',
  'grafana_health',
  'prometheus_targets',
] as const;

export type ObservabilityStepPlan =
  | { kind: 'off' }
  | { kind: 'run' }
  | { kind: 'skip'; reason: string };

export const PILOT_LIGHT_OBSERVABILITY_SKIP_REASON =
  'k8s-ha pilot-light design: the standby never installs observability, so the ' +
  'cluster failover promoted has no Grafana or Prometheus yet. These checks run ' +
  'after reconverge-deploy, the redeploy that makes it a full primary.';

/**
 * What a verification step does with the observability checks.
 * `off` when the feature is not enabled; `skip` (with the reason recorded on
 * each check) for k8s-ha verify-failover; `run` everywhere else.
 */
export function observabilityPlanForStep(
  stepName: string,
  mode: string,
  features: readonly string[],
): ObservabilityStepPlan {
  if (!features.includes('observability')) return { kind: 'off' };
  if (stepName === 'verify-failover' && mode === 'k8s-ha') {
    return { kind: 'skip', reason: PILOT_LIGHT_OBSERVABILITY_SKIP_REASON };
  }
  return { kind: 'run' };
}

/** Whether `reconverge-deploy` must prove observability was restored. */
export function provesObservabilityAfterReconverge(
  mode: string,
  features: readonly string[],
): boolean {
  return mode === 'k8s-ha' && features.includes('observability');
}

/** One `skip` result per observability check, each carrying the reason. */
export function observabilitySkipResults(reason: string): VerificationResult[] {
  return OBSERVABILITY_CHECK_NAMES.map((checkName) => ({
    checkName,
    status: 'skip' as const,
    details: { skipped: true, reason },
  }));
}

// Structural mirrors of the check seams, so this module stays importable by
// unit tests without pulling the check modules' network code.
interface AdminSession {
  result: VerificationResult;
  jar?: unknown;
}

export interface PostReconvergeObservabilityDeps<Jar> {
  /** adminSignIn from checks/app-functional.ts. */
  signIn: (
    domain: string,
    email: string,
    password: string,
  ) => Promise<AdminSession & { jar?: Jar }>;
  /** runObservabilityChecks from checks/feature-observability.ts. */
  runChecks: (opts: {
    appDomain: string;
    isCompose: boolean;
    adminJar?: Jar;
    adminUnavailableReason?: string;
    attempts?: number;
  }) => Promise<VerificationResult[]>;
}

/**
 * Sign in as the super admin afresh (the verify-failover session belongs to a
 * step that may be long gone) and run the observability checks against the
 * reconverged primary. Returns auth_admin_login followed by the observability
 * results. Missing credentials are a FAIL here, not a skip: this is the only
 * place k8s-ha proves Grafana after a failover, and a skip would let the run
 * go green without that proof.
 */
export async function runPostReconvergeObservability<Jar>(
  opts: {
    domain: string;
    adminEmail?: string;
    adminPassword?: string;
    /** Authenticated-read attempts; Grafana may still be warming up. */
    attempts?: number;
  },
  deps: PostReconvergeObservabilityDeps<Jar>,
): Promise<VerificationResult[]> {
  if (!opts.adminEmail || !opts.adminPassword) {
    return [
      {
        checkName: 'auth_admin_login',
        status: 'fail',
        errorMessage:
          'ADMIN_EMAIL/ADMIN_PASSWORD not found in .env.local: cannot prove reconverge-deploy restored Grafana and Prometheus',
      },
    ];
  }
  const session = await deps.signIn(opts.domain, opts.adminEmail, opts.adminPassword);
  const obs = await deps.runChecks({
    appDomain: opts.domain,
    isCompose: false,
    adminJar: session.jar,
    adminUnavailableReason: session.jar
      ? undefined
      : 'auth_admin_login failed after reconverge-deploy',
    attempts: opts.attempts,
  });
  return [session.result, ...obs];
}
