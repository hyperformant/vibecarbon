/**
 * carbon-autoscaler node-group state machine — the correctness core of the
 * service. For every node group defined in the config (Task 2's
 * config.json contract) it tracks three quantities (VSHN model):
 *
 *   - desired    — the target size CA wants. Mutators (increaseSize/
 *                  decreaseTargetSize/deleteNodes) bump/lower it
 *                  synchronously between refreshes; every refresh() then
 *                  SNAPS it to reality + in-flight intents (see refresh()'s
 *                  docstring) rather than merely clamping it — the cloud is
 *                  always authoritative.
 *   - in-flight  — creates issued but not yet visible in the cloud
 *                  ("creating" intents) and deletes issued but not yet
 *                  gone ("deleting" markers).
 *   - reality    — the label-scoped `provider.listServers()` snapshot
 *                  taken by the last refresh().
 *
 * The RPC layer (Task 5) has a hard 5s deadline per call, so every public
 * mutator here records intent and returns; the actual
 * provider.createServer()/deleteServer() calls run in the BACKGROUND
 * (fire-and-forget from the caller's perspective) and their outcomes are
 * folded back into group state asynchronously.
 *
 * Concurrency: a single FIFO promise-chain mutex (`this._lock`) serializes
 * every state MUTATION across every group (refresh's reconcile step,
 * increaseSize/decreaseTargetSize's desired-size math, deleteNodes'
 * bookkeeping, and the background create/delete callbacks folding their
 * outcome back in). This is what makes a Refresh<->IncreaseSize interleave
 * safe: whichever call reaches the lock first fully completes its
 * bookkeeping before the next one starts, so a concurrent bump can never be
 * silently overwritten by a reconcile computed from stale state. The
 * cloud API calls themselves (createServer/deleteServer/listServers) are
 * deliberately OUTSIDE the lock — only the bookkeeping that reads/writes
 * group state re-enters it via `_runLocked`.
 */

import { randomBytes } from 'node:crypto';

const BASE36_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** RFC1123-safe lowercase base36 suffix, drawn from crypto.randomBytes. */
function randomBase36(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += BASE36_CHARS[bytes[i] % BASE36_CHARS.length];
  }
  return out;
}

/** Safe `.message` extraction for catch blocks — never throws even if the
 * caught value isn't an Error (e.g. something threw a plain string). */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export class GroupManager {
  constructor({ config, provider, providerIdPrefix, log }) {
    this.config = config;
    this.provider = provider;
    this.providerIdPrefix = providerIdPrefix;
    this.log = log ?? (() => {});

    // FIFO mutex: every locked call chains off this promise and always
    // resolves (never rejects), regardless of whether the guarded work
    // threw, so a failure in one locked call can never wedge the queue for
    // callers still waiting behind it.
    this._lock = Promise.resolve();

    // Firewall id is resolved lazily (on first create in a cycle) and
    // cached for the rest of that cycle; refresh() invalidates it by
    // clearing the cached promise so the next cycle re-resolves.
    this._firewallIdPromise = undefined;

    // Network id is resolved the same lazily-cached-per-cycle way as the
    // firewall id above, but the failure contract is the OPPOSITE: an
    // unresolvable firewall degrades to "create without a firewall" (best
    // effort), while an unresolvable network must FAIL the create instead
    // of proceeding without it — a worker not attached to the cluster's
    // private network can never join k3s (worker-init.sh fatal-exits
    // waiting for the private NIC) and is invisible to destroy's
    // in-network sweep filter, i.e. a permanent orphan. See
    // _lookupNetworkId/_createInBackground.
    this._networkIdPromise = undefined;

    this._groups = new Map();
    for (const groupId of Object.keys(config.nodeGroups)) {
      this._groups.set(groupId, {
        desired: 0,
        running: new Map(), // serverId(string) -> raw server (last refresh)
        creating: new Map(), // name -> { name, resolvedId, errorInfo }
        deleting: new Map(), // serverId(string) -> { failed }
      });
    }
  }

  /**
   * Run `fn` (sync or async) as the next link in the FIFO mutex chain.
   * Returns a promise that settles with fn's outcome; the internal chain
   * itself never rejects, so subsequent locked calls are never blocked by
   * an earlier failure.
   */
  _runLocked(fn) {
    const result = this._lock.then(fn, fn);
    this._lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  _requireGroup(groupId) {
    const group = this._groups.get(groupId);
    if (!group) {
      throw new Error(`carbon-autoscaler: unknown node group "${groupId}"`);
    }
    return group;
  }

  /** Synchronous target size (desired) for a group. */
  targetSize(groupId) {
    return this._requireGroup(groupId).desired;
  }

  /** `[{id, minSize, maxSize}]` for every configured group. */
  groups() {
    return Object.entries(this.config.nodeGroups).map(([id, groupConfig]) => ({
      id,
      minSize: groupConfig.minSize,
      maxSize: groupConfig.maxSize,
    }));
  }

  /**
   * `[{id, status: {instanceState, errorInfo?}}]` — running servers from
   * the last refresh (instanceDeleting if a delete is in flight for them),
   * plus creating intents (instanceCreating, with errorInfo if the create
   * failed and hasn't been reconciled away yet).
   */
  nodeGroupNodes(groupId) {
    const group = this._requireGroup(groupId);
    const instances = [];

    for (const [id] of group.running) {
      const deleting = group.deleting.get(id);
      instances.push({
        id: this.providerIdPrefix + id,
        status: { instanceState: deleting ? 'instanceDeleting' : 'instanceRunning' },
      });
    }

    for (const entry of group.creating.values()) {
      const id = entry.resolvedId
        ? this.providerIdPrefix + entry.resolvedId
        : `pending:${entry.name}`;
      const status = { instanceState: 'instanceCreating' };
      if (entry.errorInfo) status.errorInfo = entry.errorInfo;
      instances.push({ id, status });
    }

    return instances;
  }

  /**
   * groupId owning `providerID`, or null if it's not managed by any group
   * (wrong prefix, or a prefix match against an id we don't recognize —
   * NEVER throws; the RPC layer maps null to the empty-id "unmanaged"
   * contract, never an error).
   */
  groupForProviderId(providerID) {
    if (typeof providerID !== 'string' || !providerID.startsWith(this.providerIdPrefix)) {
      return null;
    }
    const id = providerID.slice(this.providerIdPrefix.length);
    for (const [groupId, group] of this._groups) {
      if (group.running.has(id)) return groupId;
      for (const entry of group.creating.values()) {
        if (entry.resolvedId === id) return groupId;
      }
    }
    return null;
  }

  /**
   * Validate + bump desired, then fire one background createServer() per
   * new node (NOT awaited — this resolves as soon as the bookkeeping is
   * recorded, per the RPC layer's 5s deadline).
   */
  async increaseSize(groupId, delta) {
    if (!(delta > 0)) {
      throw new Error(`carbon-autoscaler: increaseSize delta must be > 0 (got ${delta})`);
    }

    const names = await this._runLocked(() => {
      const group = this._requireGroup(groupId);
      const groupConfig = this.config.nodeGroups[groupId];
      if (group.desired + delta > groupConfig.maxSize) {
        throw new Error(
          `carbon-autoscaler: increaseSize would take group "${groupId}" desired ` +
            `(${group.desired}) + delta (${delta}) past maxSize (${groupConfig.maxSize})`,
        );
      }
      group.desired += delta;
      const newNames = [];
      for (let i = 0; i < delta; i++) {
        const name = `${this.config.clusterName}-ca-${randomBase36(8)}`;
        group.creating.set(name, { name, resolvedId: null, errorInfo: null });
        newNames.push(name);
      }
      return newNames;
    });

    for (const name of names) {
      this._createInBackground(groupId, name).catch((err) => {
        // Last-resort belt: _createInBackground is written to never reject,
        // but this call site is fire-and-forget (no caller awaits it), so a
        // rejection here would otherwise be an unhandled promise rejection
        // that crashes the process.
        this.log(
          `[carbon-autoscaler] _createInBackground(${groupId}, ${name}) rejected unexpectedly: ${errMessage(err)}`,
        );
      });
    }
  }

  /**
   * Runs entirely outside the FIFO mutex except for its two locked
   * bookkeeping folds. This whole method must NEVER reject — it's invoked
   * fire-and-forget from increaseSize (no caller awaits or .catches it), so
   * an escaping rejection becomes an unhandled promise rejection that
   * crashes the process. In particular `groupConfig` may be gone (a config
   * reload can drop a node group while this task is still in flight) even
   * though `this._groups` still tracks the intent — that path is handled
   * explicitly below rather than let the dereference throw.
   */
  async _createInBackground(groupId, name) {
    try {
      const groupConfig = this.config.nodeGroups[groupId];
      if (!groupConfig) {
        this.log(
          `[carbon-autoscaler] createServer(${name}) skipped — group "${groupId}" is no longer ` +
            'in config (dropped by reload)',
        );
        await this._runLocked(() => {
          const entry = this._groups.get(groupId)?.creating.get(name);
          if (entry) {
            entry.errorInfo = {
              errorCode: 'group-removed',
              errorMessage: `node group "${groupId}" was removed from config before its create could run`,
              instanceErrorClass: 3,
            };
          }
        });
        return;
      }

      let networkId;
      try {
        networkId = await this._resolveNetworkId();
      } catch (err) {
        this.log(
          `[carbon-autoscaler] createServer(${name}) REFUSED, ${errMessage(err)} — a worker ` +
            'not attached to the cluster network can never join k3s; not creating',
        );
        await this._runLocked(() => {
          const entry = this._groups.get(groupId)?.creating.get(name);
          if (entry) {
            entry.errorInfo = {
              errorCode: 'network-not-found',
              errorMessage: errMessage(err),
              instanceErrorClass: 3,
            };
          }
        });
        return;
      }

      const firewallId = await this._resolveFirewallId();

      const createConfig = {
        name,
        serverType: groupConfig.serverType,
        region: groupConfig.region,
        image: groupConfig.image,
        userData: groupConfig.cloudInit,
        labels: { ...groupConfig.serverLabels },
        sshKeys: [this.config.sshKeyName],
        networks: [networkId],
      };
      if (firewallId) createConfig.firewalls = [firewallId];

      try {
        const { id } = await this.provider.createServer(createConfig);
        await this._runLocked(() => {
          const entry = this._groups.get(groupId)?.creating.get(name);
          if (entry) entry.resolvedId = String(id);
        });
      } catch (err) {
        this.log(`[carbon-autoscaler] createServer(${name}) failed: ${errMessage(err)}`);
        await this._runLocked(() => {
          const entry = this._groups.get(groupId)?.creating.get(name);
          if (entry) {
            entry.errorInfo = {
              errorCode: 'provider-error',
              errorMessage: errMessage(err),
              instanceErrorClass: 3,
            };
          }
        });
      }
    } catch (err) {
      // Genuinely last-resort: nothing above should throw once past its own
      // try/catch, but this method's promise must never reject regardless.
      this.log(
        `[carbon-autoscaler] _createInBackground(${groupId}, ${name}) hit an unexpected error: ${errMessage(err)}`,
      );
    }
  }

  async _resolveFirewallId() {
    if (this._firewallIdPromise === undefined) {
      this._firewallIdPromise = this._lookupFirewallId();
    }
    return this._firewallIdPromise;
  }

  async _lookupFirewallId() {
    const firewallName = this.config.firewallName;
    try {
      const firewall = await this.provider.findFirewallByName(firewallName);
      if (!firewall?.id) {
        this.log(
          `[carbon-autoscaler] firewall "${firewallName}" not found — creating nodes without a firewall`,
        );
        return null;
      }
      return firewall.id;
    } catch (err) {
      this.log(
        `[carbon-autoscaler] firewall lookup for "${firewallName}" failed (${err.message}) — ` +
          'creating nodes without a firewall',
      );
      return null;
    }
  }

  async _resolveNetworkId() {
    if (this._networkIdPromise === undefined) {
      this._networkIdPromise = this._lookupNetworkId();
    }
    return this._networkIdPromise;
  }

  /**
   * Resolve config.networkName to a provider network id via
   * provider.listNetworks() + find-by-name — the same approach destroy.js
   * uses to locate the cluster network for its teardown sweep. UNLIKE
   * _lookupFirewallId, this always THROWS on failure (not-found, or a
   * listNetworks() rejection) rather than degrading to a null fallback —
   * see the constructor's `_networkIdPromise` comment for why a
   * network-less create is never acceptable here. The thrown message
   * always names networkName so a caller folding it into
   * errorInfo.errorMessage identifies which network was unresolvable.
   */
  async _lookupNetworkId() {
    const networkName = this.config.networkName;
    let networks;
    try {
      networks = await this.provider.listNetworks();
    } catch (err) {
      throw new Error(`network "${networkName}" lookup failed: ${errMessage(err)}`);
    }
    const network = networks.find((n) => n.name === networkName);
    if (!network?.id) {
      throw new Error(`network "${networkName}" not found`);
    }
    return network.id;
  }

  /**
   * Map each ExternalGrpcNode to a bare server id (stripping
   * providerIdPrefix, verifying group membership), mark them deleting,
   * lower desired, then fire deleteServer() calls in the background.
   *
   * Ids already marked deleting (an overlapping/duplicate deleteNodes call —
   * e.g. a retried RPC, or two callers racing the same node) are validated
   * the same as any other id but otherwise skipped: no second deleting
   * marker, no second desired decrement, no second deleteServer() dispatch.
   * Without this, two overlapping calls for the same id would double-count
   * a single in-flight deletion against desired and issue a redundant
   * deleteServer() call against the cloud.
   */
  async deleteNodes(groupId, nodes) {
    const ids = await this._runLocked(() => {
      const group = this._requireGroup(groupId);
      const resolvedIds = nodes.map((node) => {
        const providerID = node?.providerID;
        if (typeof providerID !== 'string' || !providerID.startsWith(this.providerIdPrefix)) {
          throw new Error(
            `carbon-autoscaler: deleteNodes providerID "${providerID}" is not under prefix ` +
              `"${this.providerIdPrefix}"`,
          );
        }
        const id = providerID.slice(this.providerIdPrefix.length);
        if (!group.running.has(id)) {
          throw new Error(
            `carbon-autoscaler: deleteNodes server "${id}" is not a known member of group "${groupId}"`,
          );
        }
        return id;
      });

      const newIds = [];
      for (const id of resolvedIds) {
        if (group.deleting.has(id)) {
          this.log(
            `[carbon-autoscaler] deleteNodes: server "${id}" in group "${groupId}" is already ` +
              'marked deleting, skipping duplicate delete',
          );
          continue;
        }
        group.deleting.set(id, { failed: false });
        newIds.push(id);
      }
      group.desired = Math.max(0, group.desired - newIds.length);
      return newIds;
    });

    for (const id of ids) {
      this._deleteInBackground(groupId, id).catch((err) => {
        // Last-resort belt — see the matching comment on the
        // _createInBackground call site.
        this.log(
          `[carbon-autoscaler] _deleteInBackground(${groupId}, ${id}) rejected unexpectedly: ${errMessage(err)}`,
        );
      });
    }
  }

  /**
   * Runs entirely outside the FIFO mutex except for its one locked
   * bookkeeping fold. Like _createInBackground, this must NEVER reject —
   * it's fire-and-forget from deleteNodes.
   */
  async _deleteInBackground(groupId, id) {
    try {
      try {
        await this.provider.deleteServer(id);
      } catch (err) {
        this.log(`[carbon-autoscaler] deleteServer(${id}) failed: ${errMessage(err)}`);
        await this._runLocked(() => {
          const entry = this._groups.get(groupId)?.deleting.get(id);
          if (entry) entry.failed = true;
        });
      }
    } catch (err) {
      this.log(
        `[carbon-autoscaler] _deleteInBackground(${groupId}, ${id}) hit an unexpected error: ${errMessage(err)}`,
      );
    }
  }

  /**
   * Lower desired without deleting nodes. Rejects if the result would drop
   * below the current running count — decreaseTargetSize must never imply
   * a node deletion; that's deleteNodes' job.
   */
  async decreaseTargetSize(groupId, delta) {
    if (!(delta < 0)) {
      throw new Error(`carbon-autoscaler: decreaseTargetSize delta must be < 0 (got ${delta})`);
    }
    return this._runLocked(() => {
      const group = this._requireGroup(groupId);
      const runningCount = group.running.size;
      if (group.desired + delta < runningCount) {
        throw new Error(
          `carbon-autoscaler: decreaseTargetSize would take group "${groupId}" desired ` +
            `(${group.desired}) + delta (${delta}) below its running count (${runningCount})`,
        );
      }
      group.desired = Math.max(0, group.desired + delta);
    });
  }

  /**
   * Re-list cloud reality per group and reconcile.
   *
   * Reconcile invariant: desired is derived from reality + in-flight
   * intents at EVERY refresh — never merely clamped against its own
   * previous value. Mutators (increaseSize/decreaseTargetSize/deleteNodes)
   * only adjust desired in the window BETWEEN refreshes; each refresh snaps
   * it back to what the cloud + tracked intents actually justify. This is
   * what makes an out-of-band change (an operator manually deleting or
   * adding a matching server, with no tracked intent) converge on the next
   * refresh instead of leaving desired permanently wrong — the cloud is
   * authoritative (dossier §6, VSHN guidance).
   *
   * Steps: drop creating intents that materialized (matched by name —
   * robust even if our own createServer() callback hasn't resolved yet) or
   * that failed (their errorInfo was already surfaced to the RPC layer;
   * dropping the tracked intent here needs no separate desired decrement —
   * the snap below subsumes it); drop deleting markers whose server is gone
   * (delete completed), or revert ones whose delete call already failed and
   * the server is still present (goes back to plain running, so CA will
   * re-request the delete on a future scale-down) — an in-flight
   * (unresolved) delete marker on a still-present server is left alone.
   * Finally SNAP desired = min(maxSize, effectiveRunning + creatingCount),
   * where effectiveRunning is listed servers NOT covered by a remaining
   * delete-intent.
   *
   * Per-group failure isolation: each group's listServers + reconcile is
   * caught independently. A group whose provider.listServers() call fails
   * (transient provider error, timeout, etc.) is left exactly as it was —
   * stale-but-sane, no snap, no intent processing for it this cycle — while
   * every other group's refresh still completes normally. refresh() itself
   * always resolves (never rejects, even if every group fails) with a
   * `{refreshed, failed}` summary so the caller (the RPC layer's Refresh
   * handler) can decide what to surface; a single flaky group must never
   * take down bookkeeping for its siblings.
   */
  async refresh() {
    this._firewallIdPromise = undefined;
    this._networkIdPromise = undefined;
    const results = await Promise.all(
      Object.keys(this.config.nodeGroups).map(async (groupId) => {
        try {
          await this._refreshGroup(groupId);
          return { groupId, ok: true };
        } catch (err) {
          this.log(
            `[carbon-autoscaler] refresh() failed for group "${groupId}": ${errMessage(err)} — ` +
              'keeping its last-known state this cycle',
          );
          return { groupId, ok: false, error: errMessage(err) };
        }
      }),
    );

    return {
      refreshed: results.filter((r) => r.ok).map((r) => r.groupId),
      failed: results.filter((r) => !r.ok).map(({ groupId, error }) => ({ groupId, error })),
    };
  }

  async _refreshGroup(groupId) {
    const groupConfig = this.config.nodeGroups[groupId];
    const selector = { 'cluster-autoscaler/node': groupId, cluster: this.config.clusterName };
    const servers = await this.provider.listServers(selector);

    await this._runLocked(() => {
      const group = this._groups.get(groupId);
      if (!group) return; // config reload dropped this group mid-flight

      const namesPresent = new Set(servers.map((s) => s.name));
      for (const [name, entry] of group.creating) {
        if (namesPresent.has(name)) {
          // Materialized — reality now includes it via group.running below.
          group.creating.delete(name);
        } else if (entry.errorInfo) {
          // Failed — already surfaced via errorInfo; the snap below
          // recomputes desired without this intent, so no manual
          // decrement here.
          group.creating.delete(name);
        }
      }

      const idsPresent = new Set(servers.map((s) => String(s.id)));
      for (const [id, entry] of group.deleting) {
        if (!idsPresent.has(id)) {
          // Completed — server is gone.
          group.deleting.delete(id);
        } else if (entry.failed) {
          // Delete call failed and the server is still there — revert to
          // plain running so it's counted in effectiveRunning below.
          group.deleting.delete(id);
        }
        // else: in-flight (unresolved) delete on a still-present server —
        // leave it marked deleting; excluded from effectiveRunning below.
      }

      group.running = new Map(servers.map((s) => [String(s.id), s]));

      const effectiveRunning = group.running.size - group.deleting.size;
      const creatingCount = group.creating.size;
      group.desired = Math.min(groupConfig.maxSize, effectiveRunning + creatingCount);
    });
  }
}
