/**
 * Pure shared config for the compose per-server OCI registry.
 *
 * Zero imports, deliberately: this module must be safe for `bundle.js` to
 * import when rendering `reconcile.sh` (`registryEnsureShell()`) WITHOUT
 * pulling in the compose SSH stack (`spawn`, ssh option builders, retry
 * loops, …) that `./index.js` drags in — `reconcile.sh` only needs the
 * shell TEXT baked into the script, never the ability to run it directly.
 * `./registry.js` imports these constants + `registryRunCommand()` for its
 * own `sshRunAsync`-driven `ensureComposeRegistry`, so this file is the
 * single source of truth for both call sites.
 *
 * Warm compose redeploys `docker push` only the changed layers to this
 * registry over an SSH tunnel (see `../registry-push.js`), and the server
 * pulls `127.0.0.1:5000/<repo>:<tag>` locally instead of streaming the
 * whole image tarball across the operator's uplink every time.
 *
 * DELIBERATELY a standalone `docker run`, NOT a service in the app
 * docker-compose.yml or any overlay: that keeps it entirely clear of the
 * network-recreate / `-f`-set hazard class that caused the vibecarbon-web
 * prod outage (project_compose_overlay_network_recreate). It binds
 * `127.0.0.1` only (never internet-exposed) and uses a persistent named
 * volume so the layer diff pays off across deploys.
 */

export const REGISTRY_IMAGE = 'registry:2';
export const REGISTRY_CONTAINER = 'vibecarbon-registry';
export const REGISTRY_PORT = 5000;

/**
 * Persistent blob store for the registry. This volume GROWS WITHOUT BOUND and
 * is deliberately NOT garbage-collected today — investigated 2026-07-30, the
 * findings and the recommended design are recorded here for whoever picks it
 * up. (Read this before adding any GC: getting it wrong corrupts a registry
 * mid-deploy, which is strictly worse than the disk growth below.)
 *
 * WHY IT GROWS. Every deploy pushes a new manifest to the SAME tag
 * (`<proj>-app:local`), so the previous manifest becomes an untagged revision
 * that still references its layers. `registry:2` never reclaims anything on
 * its own. Blobs are content-addressed, so only genuinely-changed layers add
 * bytes: in `carbon/Dockerfile`'s runner stage the alpine base, the node
 * binary and the deps `node_modules` are stable across deploys, and only
 * `COPY --from=builder /app/dist ./dist` moves. Measured 2026-07-30 against
 * carbon's built `dist/`: 12 MB on disk, ~3.8 MB gzipped — so ~3.5-4 MB of
 * orphaned blobs per code-only deploy, ~1.3 GB/year at one deploy a day,
 * against a 40-80 GB server disk.
 *
 * CONTEXT THAT MATTERS: dockerd on the same server leaks the SAME layers at
 * the SAME rate and always has. Each deploy's `docker pull && docker tag`
 * moves `<proj>-app:local` onto the new image and leaves the previous one
 * dangling forever — identical behavior to the `docker load` sideload era, so
 * this is not a regression introduced by the registry. A registry-only GC
 * would therefore fix half the leak; the real fix is a server-side docker
 * disk-hygiene story that covers both.
 *
 * WHAT UPSTREAM REQUIRES (verified against distribution's garbage-collection
 * docs, 2026-07-30): "You should ensure that the registry is in read-only mode
 * or not running at all. If you were to upload an image while garbage
 * collection is running, there is the risk that the image's layers are
 * mistakenly deleted leading to a corrupted image." GC is stop-the-world.
 * `registry garbage-collect [--dry-run] [--delete-untagged] <config>`;
 * `--delete-untagged` (registry >= 2.7; we run 2.8.3) is REQUIRED here because
 * without it the retained untagged revisions keep referencing their layers and
 * GC frees nothing. `storage.delete.enabled` is NOT required — offline GC
 * operates on storage directly, not through the delete API — so no custom
 * config file has to be mounted.
 *
 * RECOMMENDED DESIGN, in preference order:
 *   1. Cap the cache from the OPERATOR side, in `ensureComposeRegistry`
 *      (registry.js). It runs only in the one build mode that pushes, and it
 *      runs immediately before the push, so we provably own the registry (the
 *      F2 barrier in `startComposeStack` means no other pusher exists). When
 *      `docker exec <container> du -sm /var/lib/registry` exceeds a cap
 *      (~1-2 GB; must be >> one image and << the disk), `docker rm -f` the
 *      container and `docker volume rm` this volume, then fall through to the
 *      existing create. No GC, no stop-the-world, no config file. Worst case
 *      is one full push — exactly what the sideload fallback already costs,
 *      and on a cold registry the same work either way. A failed measurement
 *      must be treated as "unknown -> don't reset".
 *   2. Offline GC: stop the container, `docker run --rm -v <vol>:/var/lib/registry
 *      registry:2 garbage-collect --delete-untagged /etc/docker/registry/config.yml`
 *      (same image, no extra pull), start it again. Reclaims precisely, but
 *      it is stop-the-world and adds a stop/start cycle to a path that runs on
 *      every deploy on every compose server. Only worth it if the cache is
 *      ever big enough that re-seeding it is expensive.
 *   3. Do it as part of the broader dockerd hygiene work instead, so the
 *      dangling-image half of the leak is fixed at the same time.
 *
 * NOT SHIPPED YET because at ~3.5-4 MB/deploy the leak has years of headroom,
 * and the dockerd half is the larger, older, still-unaddressed sibling —
 * fixing them together beats bolting a destructive step onto a mechanism that
 * has not yet had an e2e warm-redeploy validation.
 */
export const REGISTRY_VOLUME = 'vibecarbon-registry-data';

/** Tag prefix images must carry to resolve against this registry. */
export const REGISTRY_PREFIX = `127.0.0.1:${REGISTRY_PORT}/`;

/**
 * Per-attempt settle ladder for the compose tier's `pushImageOverSshTunnel`
 * (3 attempts, 21s of settle total).
 *
 * The shared helper's default — `DEFAULT_PUSH_SETTLE_DELAYS_MS`,
 * 1s/15s/30s/60s/120s = 226s — was budgeted for k8s, and its own comment says
 * why: an object-storage-backed registry returning 503 SlowDown while an HA
 * deploy pushes the primary and standby clusters into the SAME S3 account in
 * parallel, plus a registry POD reschedule taking ~10-20s to become Ready.
 * Neither condition exists here. Compose's registry is a filesystem-backed
 * container on one server, written by exactly one pusher (the operator), and
 * `--restart unless-stopped` brings it back in ~1-2s.
 *
 * The decisive asymmetry is the fallback: a compose push that gives up falls
 * back to `sideloadCompose`, which always works, so the cost of stopping
 * early is bounded at "one full-image transfer" — precisely the pre-#201
 * behavior, and on a COLD deploy identical work either way (an empty registry
 * has no layers to diff against). The cost of retrying too long is that dead
 * time is added ON TOP of that sideload. A wedged-but-running registry
 * (`docker ps` status checks can't detect it, so `ensureComposeRegistry`
 * happily returns) therefore used to burn ~4 minutes on EVERY deploy before
 * the fallback started; it now costs ~20-30s.
 *
 * Chosen from the failure modes compose actually faces:
 *   1s  — not a backoff: the settle applies before EVERY push including the
 *         first, and a freshly opened `ssh -N -f` tunnel needs a moment to
 *         bind. Keeps the happy path a single fast attempt.
 *   5s  — a `--restart unless-stopped` registry bounce, or a brief SSH blip
 *         on the operator's uplink.
 *  15s  — a slower restart, or dockerd busy competing with reconcile's own
 *         `docker compose pull` of the Supabase images for disk I/O.
 * Beyond that, retrying is worse than sideloading. Tunnel-bind races need no
 * ladder entry at all — `pushImageOverSshTunnel` walks 20 ports WITHIN one
 * attempt, so reaching a second attempt for that reason means something
 * systemic, not a race.
 */
export const COMPOSE_PUSH_SETTLE_DELAYS_MS = [1_000, 5_000, 15_000];

/**
 * The `docker run` invocation that creates the registry container.
 * Shared verbatim by `registry.js` (one `sshRunAsync` call) and
 * `registryEnsureShell()` below (embedded in a reconcile-safe block) so the
 * two call sites can never drift on flags.
 * @returns {string}
 */
export function registryRunCommand() {
  return (
    `docker run -d --name ${REGISTRY_CONTAINER} --restart unless-stopped ` +
    `-p 127.0.0.1:${REGISTRY_PORT}:${REGISTRY_PORT} ` +
    `-v ${REGISTRY_VOLUME}:/var/lib/registry ${REGISTRY_IMAGE}`
  );
}

/**
 * Idempotent, reconcile-safe shell block that ensures the registry
 * container is running, (re)creating it if absent or stopped. Embedded into
 * `reconcile.sh` (rendered by `bundle.js`), which runs under `set -e` — the
 * registry is ADDITIVE (warm-redeploy optimization, never load-bearing for
 * the app itself), so every step here is `|| true` guarded and a failure
 * must never abort the rest of reconciliation.
 *
 * DELIBERATELY UNCONDITIONAL — it ships in EVERY compose server's
 * reconcile.sh, not just the one build mode that pushes to it. Only
 * compose-single `local` mode ever pushes here; `direct` (build on the
 * server), `push` (GHCR), compose-ha (`haRemoteBuild` builds natively on
 * both nodes) and scale-replacement servers all run this block and end up
 * with an idle registry they never use. That is on purpose:
 *
 *  1. The cost is measured and negligible: `registry:2` (2.8.3) is a
 *     10.1 MB pull / 25.4 MB on disk / 4.3 MiB RSS idle — 0.05% of the
 *     smallest supported disk (DO s-1vcpu-2gb, 50 GB) and 0.2% of its RAM.
 *     An unused registry's volume stays empty: nothing pushes to it.
 *  2. Build mode is NOT durable state. `resolveBuildMode` re-decides it on
 *     every deploy from ambient facts — is local docker running, is CI/CD
 *     configured, was `-direct`/`-push` passed — and `cicdEnabled` is
 *     explicitly known not to survive project recreation (see the design
 *     spec's Follow-on section). A server therefore flips local↔direct↔push
 *     between deploys with no config change, and a mode-gated ensure would
 *     be absent on exactly the deploy that flips back to `local` and needs
 *     a healthy registry for its first push.
 *  3. Gating means threading a mode flag orchestrator → renderBundle →
 *     renderReconcileScript, and `scale.js` — which calls
 *     `startComposeStack` on a freshly provisioned replacement server —
 *     has no build-mode information at all. A caller that omits the flag
 *     does not fail: it silently drops the R11/Option-B safety net (the
 *     authenticated re-pull after a rate-limited deploy-time pull), and the
 *     only symptom is "warm deploys got slow again" months later. A silent,
 *     late-surfacing footgun is a worse trade than 25 MB of idle disk.
 *  4. compose-ha has no image transfer to optimize today, but a future
 *     incremental-HA path needs precisely this container present on both
 *     nodes; keeping it warm costs nothing extra.
 *
 * Pinned by `compose-registry-config.test.ts` ("ships for every compose
 * mode") so this stays a decision rather than an accident.
 * @returns {string}
 */
export function registryEnsureShell() {
  return (
    `if [ -z "$(docker ps --filter name=^${REGISTRY_CONTAINER}$ --filter status=running -q)" ]; then ` +
    `docker rm -f ${REGISTRY_CONTAINER} 2>/dev/null || true; ` +
    `${registryRunCommand()} || true; ` +
    `fi`
  );
}
