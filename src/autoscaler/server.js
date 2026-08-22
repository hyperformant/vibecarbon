#!/usr/bin/env node
/**
 * carbon-autoscaler entry point. Serves cluster-autoscaler's `externalgrpc`
 * `CloudProvider` contract (src/autoscaler/protos/externalgrpc.proto) plus
 * a vendored `grpc.health.v1.Health` service, driven by this repo's
 * provider registry (../lib/providers). See
 * the m2-carbon-autoscaler plan Task 5 and
 * .superpowers/sdd/m2-dossier-externalgrpc.md for the wire contract and the
 * 5s-per-call deadline this service must respect.
 *
 * Deployed as a sidecar container in the cluster-autoscaler Deployment,
 * bound to plaintext loopback (127.0.0.1:8086 by default) — see the
 * dossier's §2/§8 for why plaintext-on-loopback is the sanctioned
 * same-pod transport (no client cert management needed; nothing outside
 * the pod's network namespace can reach it).
 */

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { getProvider } from '../lib/providers/index.js';
import { ConfigWatcher } from './config.js';
import { GroupManager } from './groups.js';
import { loadExternalGrpcDefinition, PROTO_DIR } from './proto.js';
import { buildHandlers } from './service.js';

const DEFAULT_CONFIG_PATH = '/config/config.json';
const DEFAULT_BIND = '127.0.0.1:8086';

/**
 * Loads the vendored grpc.health.v1.Health service definition (see
 * protos/VENDORED.md's "grpc/health/v1/health.proto" section) — same
 * loader options as loadExternalGrpcDefinition, applied to a separate,
 * unrelated proto file. Duplicated (not imported) from healthcheck.js on
 * purpose: healthcheck.js is meant to be a minimal, standalone gRPC client
 * for the exec probe, and importing server.js from it would pull in the
 * whole provider/config/groups module graph for no reason.
 */
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
 * Starts the carbon-autoscaler gRPC server and resolves once it's bound.
 * Exported (rather than only run as an import-time side effect) so tests
 * can drive a real in-process instance without spawning a child process —
 * see the CLI-entry guard at the bottom of this file for the actual
 * process entry point, which is the only caller that omits `provider`.
 *
 * `provider` is an escape hatch for tests: when omitted (the production
 * path), the provider instance is built from the config's own `provider`
 * field via `getProvider(config.provider, token)`, exactly once at
 * startup — it does NOT get rebuilt on a config reload (Refresh only
 * rebuilds the GroupManager; see service.js's config-reload rule). When
 * supplied, it's used as-is, letting tests inject a mock provider instead
 * of making real cloud API calls.
 */
export async function startServer({ configPath, token, bind, log = console.error, provider } = {}) {
  const resolvedConfigPath =
    configPath ?? process.env.CARBON_AUTOSCALER_CONFIG ?? DEFAULT_CONFIG_PATH;
  const resolvedToken = token ?? process.env.PROVIDER_API_TOKEN;
  const resolvedBind = bind ?? process.env.CARBON_AUTOSCALER_BIND ?? DEFAULT_BIND;

  if (!resolvedToken) {
    throw new Error(
      'carbon-autoscaler: PROVIDER_API_TOKEN is required (set the env var, or the Secret key ' +
        'that populates it, before starting the service)',
    );
  }

  const configWatcher = new ConfigWatcher(resolvedConfigPath);
  const resolvedProvider =
    provider ?? getProvider(configWatcher.currentSync().provider, resolvedToken);

  const getGroupManager = (config) =>
    new GroupManager({
      config,
      provider: resolvedProvider,
      providerIdPrefix: config.providerIdPrefix,
      log,
    });

  const handlers = buildHandlers({
    getGroupManager,
    configWatcher,
    provider: resolvedProvider,
    log,
  });

  // Health status: NOT_SERVING until the first Refresh RPC completes
  // successfully, SERVING after. Wrapping the returned Refresh handler
  // (rather than threading a health-status callback through
  // buildHandlers) keeps service.js focused purely on RPC semantics —
  // "when is this service healthy" is a server.js/deployment concern.
  let serving = false;
  const innerRefresh = handlers.Refresh;
  handlers.Refresh = (call, callback) => {
    innerRefresh(call, (err, response) => {
      if (!err) serving = true;
      callback(err, response);
    });
  };

  const server = new grpc.Server();

  const { CloudProvider } = loadExternalGrpcDefinition();
  server.addService(CloudProvider.service, handlers);

  const { Health } = loadHealthDefinition();
  server.addService(Health.service, {
    Check: (_call, callback) => {
      callback(null, { status: serving ? 'SERVING' : 'NOT_SERVING' });
    },
    // A full Watch implementation would stream status-change notifications;
    // CA's own client never calls it (see dossier §8) and our own
    // healthcheck.js only calls Check, so UNIMPLEMENTED is a safe stub —
    // per the health protocol's own contract, a client that gets
    // UNIMPLEMENTED should treat Watch as unsupported and not retry.
    // Watch is SERVER-STREAMING: grpc-js invokes it with (call) only — the
    // error goes out via the stream, not a unary callback.
    Watch: (call) => {
      call.emit('error', { code: grpc.status.UNIMPLEMENTED, details: 'Watch is not supported' });
    },
  });

  const port = await new Promise((resolve, reject) => {
    server.bindAsync(resolvedBind, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) reject(err);
      else resolve(boundPort);
    });
  });

  return {
    server,
    port,
    stop: () => new Promise((resolve) => server.tryShutdown(() => resolve())),
  };
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
  startServer()
    .then(({ port, stop }) => {
      console.error(`[carbon-autoscaler] listening on 127.0.0.1:${port}`);

      const shutdown = (signal) => {
        console.error(`[carbon-autoscaler] received ${signal}, shutting down`);
        stop().then(() => process.exit(0));
      };
      for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => shutdown(signal));
      }
    })
    .catch((err) => {
      console.error(`[carbon-autoscaler] failed to start: ${err.message}`);
      process.exit(1);
    });
}
