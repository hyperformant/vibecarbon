#!/usr/bin/env node
/**
 * carbon-autoscaler health-check CLI — connects to the running server's
 * `grpc.health.v1.Health` service and maps the result to an exit code.
 * Invoked as a k8s `exec` probe (see the M2 plan's Task 7 manifest and
 * .superpowers/sdd/m2-dossier-externalgrpc.md §8): the CA Deployment runs
 * `hostNetwork`, so a native grpc probe dialing the pod's hostIP would hit
 * the WRONG interface given the server intentionally binds loopback-only —
 * an exec probe runs inside the pod's network namespace and can reach
 * 127.0.0.1 directly.
 *
 * Two modes, selected by CLI flag (`--liveness` / `--readiness`; no flag
 * defaults to `--readiness`):
 *
 *  --liveness: exit 0 iff the server answers Check with ANY valid status
 *    (SERVING or NOT_SERVING) — that alone proves the process is alive and
 *    the gRPC socket is answering. Exit 1 only on a connection
 *    error/timeout/deadline. SERVING only flips after the sidecar's first
 *    successful Refresh RPC (see server.js) — gating liveness on it would
 *    have kubelet restart a perfectly healthy-but-still-starting (or
 *    provider-slow) sidecar in a pointless loop. Use for k8s
 *    livenessProbe / Docker HEALTHCHECK.
 *
 *  --readiness (default): exit 0 iff Check reports SERVING — the "safe to
 *    be marked Ready / gate a rollout" signal. Use for k8s readinessProbe.
 *
 * Both modes share the same 3s deadline.
 *
 * Deliberately standalone: does NOT import server.js (which pulls in the
 * whole provider/config/groups module graph) — just enough grpc-js +
 * proto-loader to make one Check call and exit.
 */

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { PROTO_DIR } from './proto.js';

const DEFAULT_BIND = '127.0.0.1:8086';
const DEADLINE_MS = 3000;

function loadHealthDefinition() {
  const def = protoLoader.loadSync(join(PROTO_DIR, 'grpc/health/v1/health.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  return grpc.loadPackageDefinition(def).grpc.health.v1;
}

/**
 * Resolves the raw `grpc.health.v1.Health/Check` status string ('SERVING'
 * | 'NOT_SERVING' | ...) within the deadline, or rejects on connection
 * error/timeout/deadline. Kept separate from `probe()` below so both
 * modes share one wire call and one interpretation point.
 */
export function checkHealth(bind = process.env.CARBON_AUTOSCALER_BIND ?? DEFAULT_BIND) {
  return new Promise((resolve, reject) => {
    const { Health } = loadHealthDefinition();
    const client = new Health(bind, grpc.credentials.createInsecure());
    const deadline = new Date(Date.now() + DEADLINE_MS);

    client.Check({ service: '' }, { deadline }, (err, response) => {
      client.close();
      if (err) {
        reject(err);
        return;
      }
      resolve(response.status);
    });
  });
}

/**
 * Runs one health probe and resolves the process exit code (0 or 1) — the
 * shared logic behind both the CLI entry below and the in-process unit
 * tests (tests/unit/autoscaler/healthcheck.test.ts), so tests exercise
 * this contract without spawning a child process.
 *
 * `mode`: 'liveness' → 0 for any answered Check (SERVING or NOT_SERVING),
 * 1 only on connection error/timeout/deadline. 'readiness' (default) → 0
 * iff Check reports SERVING.
 */
export async function probe({ bind, mode = 'readiness', log = () => {} } = {}) {
  try {
    const status = await checkHealth(bind);
    if (mode === 'liveness') return 0;
    return status === 'SERVING' ? 0 : 1;
  } catch (err) {
    log(`[carbon-autoscaler healthcheck] ${err.message}`);
    return 1;
  }
}

function modeFromArgv(argv) {
  return argv.includes('--liveness') ? 'liveness' : 'readiness';
}

// Only run when executed directly (not when imported by tests) — same
// realpathSync-symlink-resolving idiom as src/cli.js's entry guard.
const isEntryPoint = (() => {
  try {
    return (
      process.argv[1] &&
      realpathSync(new URL(import.meta.url).pathname) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  probe({ mode: modeFromArgv(process.argv.slice(2)), log: console.error }).then((code) => {
    process.exit(code);
  });
}
