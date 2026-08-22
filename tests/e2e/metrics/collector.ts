/**
 * Metrics collector orchestrator for e2e tests.
 *
 * Ties together the E2EDb, SSH resource collection, and health
 * latency measurement to provide a single entry point for recording all
 * metrics after each lifecycle step.
 *
 * All collection methods are fault-tolerant — they log warnings via
 * console.warn but never throw. A failed metric collection must never
 * cause an e2e test to fail.
 */

import { measureHealthLatencies } from '../checks/health.js';
import type { CostSnapshot, VerificationResult } from '../scenarios/types.js';
import { collectResourceMetrics } from '../utils/ssh.js';
import { sshUnreachableDiagnosis, sshUnreachableSince } from '../utils/ssh-reachability.js';
import type { E2EDb } from './db.js';

// ---------------------------------------------------------------------------
// Hetzner server type pricing (approximate EUR/hr)
// Source: https://www.hetzner.com/cloud — pricing as of 2026-03
// ---------------------------------------------------------------------------

const HETZNER_PRICING: Record<string, { hourly: number; monthly: number }> = {
  cpx11: { hourly: 0.0065, monthly: 4.69 },
  cpx21: { hourly: 0.0079, monthly: 5.69 },
  cpx31: { hourly: 0.0158, monthly: 11.39 },
  cpx41: { hourly: 0.0317, monthly: 22.79 },
};

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

export class MetricsCollector {
  constructor(private db: E2EDb) {}

  /**
   * Record timing metrics for a step (duration already known from cli-runner).
   * Stores as metric type `timing`, name `step_duration_ms`.
   */
  recordTiming(stepId: string, durationMs: number): void {
    try {
      this.db.recordMetric({
        stepId,
        metricType: 'timing',
        metricName: 'step_duration_ms',
        value: durationMs,
      });
    } catch (err) {
      console.warn(
        `[metrics-collector] Failed to record timing for step ${stepId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Collect and record health endpoint latencies for a domain.
   * Makes 10 rapid requests and stores p50/p95/p99.
   */
  async recordHealthLatencies(stepId: string, domain: string): Promise<void> {
    try {
      const latencies = await measureHealthLatencies(domain, '/api/health', 10);

      this.db.recordMetric({
        stepId,
        metricType: 'health_latency',
        metricName: 'api_health_p50',
        value: latencies.p50Ms,
      });
      this.db.recordMetric({
        stepId,
        metricType: 'health_latency',
        metricName: 'api_health_p95',
        value: latencies.p95Ms,
      });
      this.db.recordMetric({
        stepId,
        metricType: 'health_latency',
        metricName: 'api_health_p99',
        value: latencies.p99Ms,
      });
    } catch (err) {
      console.warn(
        `[metrics-collector] Failed to record health latencies for step ${stepId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Collect and record server resource utilization (CPU, memory, disk) via SSH.
   * For multiple servers, metric names are prefixed with the server index
   * (e.g., `server_0_cpu_percent`, `server_1_cpu_percent`).
   */
  async recordResourceUtilization(
    stepId: string,
    serverIps: string[],
    sshKeyPath: string,
  ): Promise<void> {
    // Collect from all servers in parallel
    const results = await Promise.allSettled(
      serverIps.map((ip) => collectResourceMetrics(ip, sshKeyPath)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        console.warn(
          `[metrics-collector] Resource collection failed for server ${serverIps[i]}:`,
          result.reason instanceof Error ? result.reason.message : result.reason,
        );
        continue;
      }

      const metrics = result.value;
      if (!metrics) {
        // Say WHY. A bare "no metrics returned" for a host whose :22 is
        // black-holed is how the 2026-08-11 SSH outage stayed invisible — this
        // line, for BOTH nodes, was the strongest available evidence that the
        // failure was operator-side, and it read as a shrug.
        const unreachable = sshUnreachableSince(serverIps[i]);
        console.warn(
          unreachable
            ? `[metrics-collector] No resource metrics for server ${serverIps[i]} — ${sshUnreachableDiagnosis(serverIps[i])}`
            : `[metrics-collector] No resource metrics returned for server ${serverIps[i]}`,
        );
        continue;
      }

      // For multiple servers, prefix with server index; for a single server, no prefix
      const prefix = serverIps.length > 1 ? `server_${i}_` : '';

      try {
        this.db.recordMetric({
          stepId,
          metricType: 'resource',
          metricName: `${prefix}cpu_percent`,
          value: metrics.cpuPercent,
        });
        this.db.recordMetric({
          stepId,
          metricType: 'resource',
          metricName: `${prefix}memory_used_mb`,
          value: metrics.memoryUsedMb,
        });
        this.db.recordMetric({
          stepId,
          metricType: 'resource',
          metricName: `${prefix}memory_total_mb`,
          value: metrics.memoryTotalMb,
        });
        this.db.recordMetric({
          stepId,
          metricType: 'resource',
          metricName: `${prefix}disk_used_gb`,
          value: metrics.diskUsedGb,
        });
        this.db.recordMetric({
          stepId,
          metricType: 'resource',
          metricName: `${prefix}disk_total_gb`,
          value: metrics.diskTotalGb,
        });
      } catch (err) {
        console.warn(
          `[metrics-collector] Failed to store resource metrics for server ${serverIps[i]}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Fetch and record current cost from Hetzner pricing for the environment's servers.
   *
   * Uses a hardcoded pricing lookup by server type rather than calling the Hetzner API,
   * which avoids an API dependency and keeps tests hermetic. The server type is resolved
   * by querying the Hetzner API for each server IP.
   *
   * Returns the cost snapshot for display purposes, or null if no servers are provided
   * or the cost cannot be determined.
   */
  async recordCost(
    stepId: string,
    serverIps: string[],
    hetznerToken: string,
  ): Promise<CostSnapshot | null> {
    if (serverIps.length === 0) return null;

    try {
      // Resolve IP → server-type via the shared, PAGINATED snapshot helper
      // (tests/e2e/utils/server-types.ts) instead of a hand-rolled bare
      // `GET /v1/servers` — the bare GET served the API's default 25 rows,
      // so on a busy shared account a server past page 1 was unmatchable
      // and its cost silently dropped from the metrics (truncated-listing
      // failure class, 2026-07-30). One helper, two consumers — the IP→type
      // FETCH can no longer drift from verify-scale's (the pricing table
      // below is still this file's own and can: HETZNER_PRICING covers only
      // the cpx line today, so cx-typed servers resolve a type but no
      // price — pre-existing gap, see PR #214 review ledger).
      //
      // Deliberate behavior deltas vs the old inline fetch, accepted for
      // convergence: the helper retries thrown network errors 6× with
      // backoff (~121s worst case, vs one 15s attempt — recordCost is
      // best-effort metrics, the extra patience only delays a null), and
      // its warn lines carry the helper's own [verify-scale] marker after
      // our [metrics-collector] tag.
      const { fetchServerTypes } = await import('../utils/server-types.js');
      const ipToType = new Map(
        Object.entries(
          await fetchServerTypes(serverIps, hetznerToken, { tag: '[metrics-collector]' }),
        ),
      );

      // Sum up pricing for all servers in this environment
      let totalHourly = 0;
      let totalMonthly = 0;
      let matched = 0;

      for (const ip of serverIps) {
        const serverType = ipToType.get(ip);
        if (!serverType) {
          console.warn(`[metrics-collector] Could not find server type for IP ${ip}`);
          continue;
        }

        const pricing = HETZNER_PRICING[serverType];
        if (!pricing) {
          console.warn(
            `[metrics-collector] No pricing data for server type "${serverType}" (IP: ${ip})`,
          );
          continue;
        }

        totalHourly += pricing.hourly;
        totalMonthly += pricing.monthly;
        matched++;
      }

      if (matched === 0) {
        console.warn('[metrics-collector] Could not determine cost for any server');
        return null;
      }

      // Round to 4 decimal places for hourly, 2 for monthly
      const snapshot: CostSnapshot = {
        hourlyEur: Math.round(totalHourly * 10_000) / 10_000,
        monthlyEur: Math.round(totalMonthly * 100) / 100,
      };

      this.db.recordMetric({
        stepId,
        metricType: 'cost',
        metricName: 'hourly_eur',
        value: snapshot.hourlyEur,
      });
      this.db.recordMetric({
        stepId,
        metricType: 'cost',
        metricName: 'monthly_eur',
        value: snapshot.monthlyEur,
      });

      return snapshot;
    } catch (err) {
      console.warn(
        `[metrics-collector] Failed to record cost for step ${stepId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Persist a batch of [perf] sub-stage timings (one CLI invocation's worth)
   * to the perf_substep table. Fault-tolerant — a metrics-write failure must
   * never block the test.
   */
  recordPerfSubsteps(
    stepId: string,
    timings: Array<{ name: string; ms: number; note?: string }>,
  ): void {
    try {
      this.db.recordPerfSubsteps(stepId, timings);
    } catch (err) {
      console.warn(
        `[metrics-collector] Failed to record ${timings.length} perf substeps for step ${stepId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Record verification check results from health/functional/feature checks.
   * Each result is stored individually in the verifications table.
   */
  recordVerifications(stepId: string, results: VerificationResult[]): void {
    for (const result of results) {
      try {
        this.db.recordVerification({
          stepId,
          checkName: result.checkName,
          status: result.status,
          responseTimeMs: result.responseTimeMs,
          errorMessage: result.errorMessage,
          details: result.details,
        });
      } catch (err) {
        console.warn(
          `[metrics-collector] Failed to record verification "${result.checkName}" for step ${stepId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Run full metrics collection for a step (timing + latencies + resources + cost).
   *
   * Calls all collectors in parallel (except timing which is synchronous).
   * Each collector is wrapped in a try/catch so that a failure in one does
   * not prevent the others from completing.
   */
  async collectAll(params: {
    stepId: string;
    durationMs: number;
    domain: string;
    serverIps: string[];
    sshKeyPath: string;
    hetznerToken: string;
  }): Promise<void> {
    // Timing is synchronous — record it immediately
    this.recordTiming(params.stepId, params.durationMs);

    // Run the async collectors in parallel, each independently fault-tolerant
    await Promise.allSettled([
      this.recordHealthLatencies(params.stepId, params.domain),
      this.recordResourceUtilization(params.stepId, params.serverIps, params.sshKeyPath),
      this.recordCost(params.stepId, params.serverIps, params.hetznerToken),
    ]);
  }
}
