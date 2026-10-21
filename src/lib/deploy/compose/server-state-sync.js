/**
 * Pulumi state follows a compose scale.
 *
 * Compose scale replaces servers outside Pulumi (provider.createServer, then
 * provider.deleteServer of the old one). This module keeps the stack in step:
 * after the old server is destroyed, the stack's `server` resource is pointed
 * at the replacement (lib/iac/server-state.js holds the why).
 *
 * The sync is recorded before the old server is deleted, as
 * `envConfig.pendingServerState = [{ stack, serverId, serverType, ip }]`, and
 * cleared once state names the replacement. So a sync that fails, or a scale
 * killed between the delete and the sync, leaves a record, and `vibecarbon
 * deploy` repairs state from it before any Pulumi `up` (and refuses when the
 * repair fails): a deploy never refreshes a deleted server away and builds a
 * second one.
 */

import * as p from '@clack/prompts';
import { updateProjectConfig } from '../../config.js';
import { composeServerStateSpec, syncServerState } from '../../iac/server-state.js';
import { providerIdFor } from '../../providers/index.js';
import { composeHaStackOf } from './ha-role-swap.js';

/**
 * Refuse a compose scale, before any server is built, on a provider whose
 * stack cannot be pointed at a replacement (Scaleway, see iac/server-state.js).
 *
 * @param {{ environment: string, envConfig: object }} args
 */
export function assertComposeScaleKeepsState({ environment, envConfig }) {
  const provider = providerIdFor(envConfig);
  if (composeServerStateSpec(provider)) return;
  throw new Error(
    `compose scale is not available on ${provider} yet: it replaces the server outside Pulumi, ` +
      `and ${provider}'s server holds an IP and a volume Pulumi state could not follow, so the next ` +
      `deploy would build a second server. Resize ${environment} in the ${provider} console instead.`,
  );
}

/**
 * The Pulumi stack a compose server was born in: the env itself on single
 * compose, `<env>-primary` / `<env>-standby` on compose-ha (by the node's
 * stack identity, which survives a failover's role swap).
 */
export function composeServerStack({ ha, environment, projectName, server }) {
  if (!ha) return environment;
  const stack = composeHaStackOf(server, projectName, environment) ?? server?.role;
  return `${environment}-${stack}`;
}

/**
 * The Pulumi backend options for this env's stacks: provider, token, and the
 * state bucket the deploy used (envConfig.s3 plus the object-storage keys).
 * Null keys on an S3-backed env mean the sync cannot reach state, so the
 * caller refuses before anything changes.
 *
 * @returns {Promise<{ provider: string, providerToken: string, projectName: string, s3Config?: object }>}
 */
export async function resolveServerStateOptions({ envConfig, projectName, Provider, apiToken }) {
  const options = { provider: providerIdFor(envConfig), providerToken: apiToken, projectName };
  if (!envConfig.s3?.bucket) return options;
  const creds = await Provider.promptObjectStorageCredentials(projectName, { save: false });
  if (!creds?.accessKey || !creds?.secretKey) {
    throw new Error(
      `scale keeps ${projectName}'s Pulumi state in step with the servers it replaces, and needs ` +
        `the object-storage keys of the state bucket ${envConfig.s3.stateBucket ?? envConfig.s3.bucket}: ` +
        'export them, then rerun.',
    );
  }
  return {
    ...options,
    s3Config: {
      bucket: envConfig.s3.bucket,
      region: envConfig.s3.region,
      endpoint: envConfig.s3.endpoint,
      stateBucket: envConfig.s3.stateBucket,
      stateBucketRegion: envConfig.s3.stateBucketRegion,
      stateEndpoint: envConfig.s3.stateEndpoint,
      accessKey: creds.accessKey,
      secretKey: creds.secretKey,
    },
  };
}

/** Record a pending state sync (one per stack; a newer one replaces it). */
export function recordPendingServerState(environment, entry) {
  updateProjectConfig((config) => {
    const envConfig = config.environments?.[environment];
    if (!envConfig) {
      throw new Error(`server state: environment ${environment} is not in .vibecarbon.json`);
    }
    envConfig.pendingServerState = [
      ...(envConfig.pendingServerState ?? []).filter((e) => e.stack !== entry.stack),
      { ...entry, at: new Date().toISOString() },
    ];
  });
}

/** Drop the pending sync for `stack`. A no-op when none is set. */
export function clearPendingServerState(environment, stack) {
  updateProjectConfig((config) => {
    const envConfig = config.environments?.[environment];
    const pending = envConfig?.pendingServerState;
    if (!pending) return;
    const rest = pending.filter((e) => e.stack !== stack);
    if (rest.length > 0) envConfig.pendingServerState = rest;
    else delete envConfig.pendingServerState;
  });
}

/**
 * The state sync a scaled server's replacement needs: its stack, and the
 * replacement's id, size and IP (`server._replacement`, its servers[] entry).
 * Recorded with recordPendingServerState BEFORE the old server's delete, and
 * applied by syncScaledServerState after it.
 *
 * @returns {{ stack: string, serverId: string|number, serverType: string, ip: string }}
 */
export function scaledServerStateEntry(ctx, server) {
  const replacement = server._replacement;
  return {
    stack: composeServerStack({
      ha: ctx.tier === 'compose-ha',
      environment: ctx.environment,
      projectName: ctx.projectName,
      server,
    }),
    serverId: replacement.id,
    serverType: replacement.serverType,
    ip: replacement.ip,
    // The server it replaces, so a record whose delete never landed can name
    // it for cleanup (it keeps billing outside Pulumi state).
    old: { id: server.id, ip: server.ip, name: server.providerServerName ?? server.name ?? null },
  };
}

/** The old server, as a cleanup line names it. */
export function describeOldServer(old) {
  if (!old) return 'the old server';
  return `the old server ${old.ip} (id ${old.id}${old.name ? `, ${old.name}` : ''})`;
}

/** Mark the record's old server as deleted (its delete landed). */
export function markPendingServerOldDeleted(environment, stack) {
  updateProjectConfig((config) => {
    const entry = config.environments?.[environment]?.pendingServerState?.find(
      (e) => e.stack === stack,
    );
    if (entry) entry.oldDeleted = true;
  });
}

/** The one recovery line for a stack that still names a replaced server. */
export function serverStateRecovery(environment) {
  return `run vibecarbon deploy ${environment}: it points Pulumi state at the new server before anything else`;
}

/**
 * After the old server's delete: point the stack at the replacement and clear
 * the record. Never throws: the scale itself succeeded on the infrastructure.
 * A failure is logged, kept on `ctx.serverStateProblems` for the outro (which
 * fails the command), and the record stays for deploy to repair.
 */
export async function syncScaledServerState(ctx, entry) {
  const { stack, serverId, serverType, ip } = entry;
  const target = { serverId, serverType, ip };
  try {
    if (!ctx.serverStateOptions) {
      throw new Error('no Pulumi backend options were resolved for this scale');
    }
    await syncServerState(stack, target, ctx.serverStateOptions);
    clearPendingServerState(ctx.environment, stack);
  } catch (err) {
    const problem =
      `Pulumi stack ${stack} still names the server scale replaced ` +
      `(${String(err?.message ?? err).split('\n')[0]}); ${serverStateRecovery(ctx.environment)}`;
    p.log.error(problem);
    ctx.serverStateProblems = [...(ctx.serverStateProblems ?? []), problem];
  }
}

/**
 * Deploy, before any Pulumi `up`: apply every pending server-state sync a
 * scale left. Idempotent. Throws (so the deploy stops before `up`) when one
 * cannot be applied.
 *
 * @param {{ environment: string, envConfig: object, options: object }} args
 * @returns {Promise<number>} how many were applied
 */
export async function repairPendingServerState({ environment, envConfig, options }) {
  const pending = envConfig?.pendingServerState ?? [];
  for (const { stack, serverId, serverType, ip, old, oldDeleted } of pending) {
    // A record whose delete never landed (killed before it, or it failed):
    // the old server may still run, billing outside Pulumi state.
    if (!oldDeleted) {
      p.log.warn(
        `${describeOldServer(old)}, which scale replaced in stack ${stack}, may still exist: ` +
          "if your provider's console lists it, delete it there; nothing tracks it any more.",
      );
    }
    try {
      const { changed } = await syncServerState(stack, { serverId, serverType, ip }, options);
      p.log.info(
        changed
          ? `Pulumi stack ${stack} now names server ${serverId} (${ip}), the one scale built`
          : `Pulumi stack ${stack} already names server ${serverId} (${ip})`,
      );
    } catch (err) {
      throw new Error(
        `Refusing to deploy ${environment}: Pulumi stack ${stack} still names a server scale ` +
          `replaced, and pointing it at server ${serverId} (${ip}) failed: ` +
          `${String(err?.message ?? err).split('\n')[0]}. A deploy now would build a second server. ` +
          'Fix the cause and rerun the deploy.',
      );
    }
    clearPendingServerState(environment, stack);
  }
  if (envConfig && pending.length > 0) delete envConfig.pendingServerState;
  return pending.length;
}
