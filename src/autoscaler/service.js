/**
 * carbon-autoscaler RPC handlers — implements the 15 `CloudProvider` RPCs
 * of the vendored `externalgrpc` contract (src/autoscaler/protos/
 * externalgrpc.proto, CA v1.32.7) on top of the group state machine
 * (groups.js) and the config watcher (config.js). See
 * .superpowers/sdd/m2-dossier-externalgrpc.md for the wire contract this
 * implements and the m2-carbon-autoscaler plan
 * Task 5's handler table for the normative per-RPC behavior.
 *
 * Every handler wraps its body in try/catch -> grpc INTERNAL with the
 * caught error's message. This is deliberate belt-and-suspenders: CA polls
 * this service every ~10s from a background loop, and a crashed process
 * would take down node-group visibility for the whole cluster until the
 * pod restarts — a single bad RPC must never do that.
 */

import grpc from '@grpc/grpc-js';
import { buildTemplateNode } from './node-template.js';

/**
 * Maps a GroupManager validation Error to a grpc status. GroupManager's
 * `_requireGroup` throws an Error whose message contains the literal
 * substring "unknown node group" for every "group id doesn't exist" case
 * (increaseSize/decreaseTargetSize/deleteNodes all route through it) — CA
 * should see that as NOT_FOUND; every other validation failure (delta past
 * maxSize, delta with the wrong sign, deleteNodes on a providerID CA
 * doesn't recognize, ...) is a client-supplied bad argument, INVALID_ARGUMENT.
 */
function toGrpcError(err) {
  const details = err instanceof Error ? err.message : String(err);
  const code = /unknown node group/.test(details)
    ? grpc.status.NOT_FOUND
    : grpc.status.INVALID_ARGUMENT;
  return { code, details };
}

function internalError(err) {
  const details = err instanceof Error ? err.message : String(err);
  return { code: grpc.status.INTERNAL, details };
}

/**
 * Builds the externalgrpc `CloudProvider` handler map.
 *
 * `getGroupManager` is a factory, not a plain accessor: `(config) =>
 * GroupManager`. buildHandlers calls it once up front (seeded from
 * `configWatcher.currentSync()`) to obtain the manager it starts serving,
 * then owns that reference internally — `manager` below is the single
 * mutable "current manager" for the lifetime of this handler set. The
 * config-reload rule (Refresh handler, below) is the ONLY place that
 * reassigns it, by calling `getGroupManager(newConfig)` again. This design
 * means buildHandlers, not its caller, is the source of truth for "which
 * manager is current" once construction is done — the factory shape exists
 * purely so Refresh can mint a fresh manager from a fresh config without
 * buildHandlers needing to know how a GroupManager is constructed (that
 * knowledge — provider, providerIdPrefix, log — stays in server.js).
 */
export function buildHandlers({ getGroupManager, configWatcher, provider, log }) {
  let manager = getGroupManager(configWatcher.currentSync());
  // Per-serverType TemplateNodeInfo specs cache. Dropped whenever Refresh
  // recreates the manager from a changed config — a config edit could
  // repoint a group at a different serverType, and stale specs under the
  // old serverType's key would just sit there unused (harmless) while a
  // renamed-but-same-name serverType change would go undetected without
  // the drop. Simplest correct rule: any config change invalidates the
  // whole cache.
  let specsCache = new Map();

  return {
    NodeGroups: async (_call, callback) => {
      try {
        callback(null, { nodeGroups: manager.groups() });
      } catch (err) {
        callback(internalError(err));
      }
    },

    NodeGroupForNode: async (call, callback) => {
      try {
        const providerID = call.request.node?.providerID;
        const groupId = manager.groupForProviderId(providerID);
        const group = groupId ? manager.groups().find((g) => g.id === groupId) : null;
        callback(null, { nodeGroup: group ?? { id: '' } });
      } catch (err) {
        callback(internalError(err));
      }
    },

    NodeGroupTargetSize: async (call, callback) => {
      try {
        const { id } = call.request;
        if (!manager.config.nodeGroups[id]) {
          callback({ code: grpc.status.NOT_FOUND, details: `unknown node group "${id}"` });
          return;
        }
        callback(null, { targetSize: manager.targetSize(id) });
      } catch (err) {
        callback(internalError(err));
      }
    },

    NodeGroupIncreaseSize: async (call, callback) => {
      try {
        const { id, delta } = call.request;
        await manager.increaseSize(id, delta);
        callback(null, {});
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    NodeGroupDeleteNodes: async (call, callback) => {
      try {
        const { id, nodes } = call.request;
        await manager.deleteNodes(id, nodes ?? []);
        callback(null, {});
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    NodeGroupDecreaseTargetSize: async (call, callback) => {
      try {
        const { id, delta } = call.request;
        await manager.decreaseTargetSize(id, delta);
        callback(null, {});
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    NodeGroupNodes: async (call, callback) => {
      try {
        callback(null, { instances: manager.nodeGroupNodes(call.request.id) });
      } catch (err) {
        callback(internalError(err));
      }
    },

    NodeGroupTemplateNodeInfo: async (call, callback) => {
      try {
        const { id } = call.request;
        const groupConfig = manager.config.nodeGroups[id];
        if (!groupConfig) {
          callback({ code: grpc.status.NOT_FOUND, details: `unknown node group "${id}"` });
          return;
        }

        let specs = specsCache.get(groupConfig.serverType);
        if (!specs) {
          specs = await provider.getServerType(groupConfig.serverType);
          specsCache.set(groupConfig.serverType, specs);
        }

        const nodeInfo = buildTemplateNode({
          groupId: id,
          group: groupConfig,
          specs,
          clusterName: manager.config.clusterName,
        });
        callback(null, { nodeInfo });
      } catch (err) {
        callback(internalError(err));
      }
    },

    Refresh: async (_call, callback) => {
      try {
        let reloadResult;
        try {
          reloadResult = await configWatcher.reloadIfChanged();
        } catch (err) {
          // config.js keeps serving the last-good config on a bad reload
          // (e.g. a Secret edit caught mid-propagation) — this Refresh
          // still succeeds against the CURRENT manager rather than failing
          // the RPC over a config problem CA can't do anything about.
          log(
            `[carbon-autoscaler] config reload failed, continuing with the current manager: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          reloadResult = { changed: false };
        }

        if (reloadResult.changed) {
          // Design decision (Task 3 review cycle): a changed config
          // recreates the GroupManager wholesale rather than patching the
          // live one in place. Convergence semantics become "process
          // restart" — any in-flight creating/deleting intents tracked by
          // the OLD manager are dropped, and the new manager's first
          // refresh() below snaps its state from cloud reality. This is
          // simpler and safer than reconciling old in-flight intents
          // against a config that may have changed maxSize, serverType, or
          // even removed the group entirely.
          manager = getGroupManager(reloadResult.config);
          specsCache = new Map();
        }

        const result = await manager.refresh();
        if (result.failed.length > 0) {
          for (const failure of result.failed) {
            log(
              `[carbon-autoscaler] refresh failed for group "${failure.groupId}": ${failure.error}`,
            );
          }
        }
        // Refresh RPC succeeds regardless of per-group failures — a group
        // left stale-but-sane this cycle is CA-safe (it'll retry the same
        // failing group next Refresh); a hard RPC error here would stall
        // CA's whole main loop over one flaky group.
        callback(null, {});
      } catch (err) {
        callback(internalError(err));
      }
    },

    Cleanup: async (_call, callback) => {
      try {
        callback(null, {});
      } catch (err) {
        callback(internalError(err));
      }
    },

    GPULabel: async (_call, callback) => {
      try {
        callback(null, { label: 'vibecarbon.dev/gpu' });
      } catch (err) {
        callback(internalError(err));
      }
    },

    GetAvailableGPUTypes: async (_call, callback) => {
      try {
        callback(null, { gpuTypes: {} });
      } catch (err) {
        callback(internalError(err));
      }
    },

    PricingNodePrice: async (_call, callback) => {
      try {
        callback({ code: grpc.status.UNIMPLEMENTED });
      } catch (err) {
        callback(internalError(err));
      }
    },

    PricingPodPrice: async (_call, callback) => {
      try {
        callback({ code: grpc.status.UNIMPLEMENTED });
      } catch (err) {
        callback(internalError(err));
      }
    },

    NodeGroupGetOptions: async (_call, callback) => {
      try {
        callback({ code: grpc.status.UNIMPLEMENTED });
      } catch (err) {
        callback(internalError(err));
      }
    },
  };
}
