/**
 * Target CPU architecture for every image vibecarbon builds and every server
 * it provisions.
 *
 * ## The decision (owner, 2026-07-30)
 *
 * **vibecarbon standardizes on x86-64 (amd64). Multi-architecture support is
 * dropped.** The platform was already amd64-only in practice, but NOTHING
 * enforced it: no `--platform` anywhere in the deploy path, so the app image
 * silently inherited the *operator's* architecture (an Apple Silicon operator
 * shipped an arm64 image to an amd64 server), and ARM server types were
 * reachable through unvalidated `-type` input.
 *
 * Why amd64 and not multi-arch:
 *   - **DigitalOcean has ZERO ARM instances** (31 size slugs across the
 *     s/c/g/gd/m/gpu families — none ARM), and DO's own CCM (v0.1.68) and CSI
 *     (v4.17.0) ship amd64-only images regardless.
 *   - **Hetzner ARM exists in only 3 of 6 locations** (fsn1/hel1/nbg1 — absent
 *     in ash/hil/sin), in only 4 SKUs (cax11/21/31/41), all inside the
 *     "Cost-Optimized / Limited availability" tier.
 *   - Everything the stack depends on — the full Supabase stack, Traefik,
 *     Kong, cert-manager, the Hetzner CCM/CSI drivers, cluster-autoscaler,
 *     registry:2, and the add-ons — publishes amd64 without question.
 *
 * So a single pinned architecture buys correctness (no silent arch mismatch)
 * at zero real cost in provider reach.
 *
 * ## What this module is for
 *
 * Every `docker build` in the deploy path passes {@link PLATFORM_BUILD_FLAG}.
 * The operator-side builds *need* it (their host arch would otherwise leak
 * into the image); the server-side builds (DOCKER_HOST=ssh:// onto an amd64
 * VPS) don't strictly need it, but the explicit pin documents the invariant
 * and keeps producing amd64 if a future server ever isn't.
 *
 * The server-type half of the same decision lives on the provider classes:
 * `BaseProvider.isArmServerType` / `BaseProvider.assertAmd64ServerType`.
 */

/** Docker platform string every vibecarbon image is built for. */
export const TARGET_PLATFORM = 'linux/amd64';

/** `docker build` flag form of {@link TARGET_PLATFORM}. */
export const PLATFORM_BUILD_FLAG = `--platform=${TARGET_PLATFORM}`;

/**
 * Appended to every build-failure message raised by a pinned build.
 *
 * Pinning the platform turns "silently built the wrong architecture" into a
 * loud build failure — the intended trade. But on an arm64 host without
 * binfmt/QEMU registered, BuildKit's failure is cryptic (`exec /bin/sh: exec
 * format error`, or `no match for platform in manifest`), and an operator has
 * no way to connect that to a flag they never passed. This hint does.
 */
export const AMD64_BUILD_HINT =
  `Builds are pinned to ${TARGET_PLATFORM}, vibecarbon is x86-64 only. ` +
  `If you are building on an arm64 machine (e.g. Apple Silicon) and the failure ` +
  `looks like "exec format error" or "no match for platform", Docker needs amd64 ` +
  `emulation: Docker Desktop ships it, and on Linux you can register it with ` +
  `\`docker run --privileged --rm tonistiigi/binfmt --install amd64\`.`;
