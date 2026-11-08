/**
 * Reap operator-side Docker images and volumes left behind by THIS scenario's
 * local builds. The provider orphan sweeps handle the CLOUD side; this handles
 * the LOCAL machine, where each deploy accumulates artifacts that nothing else
 * removes:
 *
 *   - k8s / k8s-ha build `10.0.1.1:5000/<projectName>:<sha>-<ts>` locally
 *     (buildLocalImage in src/lib/deploy/image.js) for the layer delta into the
 *     master's registry. Only `localhost:<port>/…` aliases get reaped (the
 *     retired ssh-tunnel push minted them; an operator machine that ran an older
 *     CLI may still hold some); the original registry-prefixed tag is kept for
 *     the Deployment and never removed. Iterating a kept rig mints a fresh timestamped tag every rebuild,
 *     so these pile up unbounded → `docker builder prune` / `docker system df`
 *     showed hundreds of `testapp-k8s-*` images (60GB+ reclaimable).
 *   - compose local builds tag `<projectName>-app:local` / `vibecarbon-local/<projectName>`.
 *
 * projectName is per-run unique (`testapp-<mode>-<ts>-<suffix>`), so a substring
 * match on the image *repository* is safe and prefix-agnostic — it catches every
 * tag scheme without hardcoding registry prefixes. Best-effort throughout: this
 * runs during teardown (pass OR fail, but never when a rig is kept), and nothing
 * here may crash the run or slow it meaningfully. Skipped entirely when a rig is
 * preserved (VC_KEEP_*), because the kept images are what the operator iterates.
 */
export async function reapLocalBuildArtifacts(tag: string, projectName: string): Promise<void> {
  const { execFileSync } = await import('node:child_process');

  // Best-effort docker call: capture stdout, swallow everything else. A missing
  // docker binary or a daemon hiccup must not derail cleanup.
  const docker = (argv: readonly string[], timeoutMs = 30_000): string => {
    try {
      return execFileSync('docker', argv, {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 8 * 1024 * 1024,
      }).trim();
    } catch {
      return '';
    }
  };

  try {
    // Images: match on repository (the part before the last ':'), not the whole
    // ref, so a git-sha tag that happens to contain projectName-like text can't
    // widen the match. rmi by full ref (repo:tag) is unambiguous.
    const refs = docker(['images', '--format', '{{.Repository}}:{{.Tag}}'])
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
      .filter((ref) => {
        const repo = ref.slice(0, ref.lastIndexOf(':'));
        return repo.includes(projectName);
      });
    if (refs.length > 0) {
      // -f: these images are no longer referenced by any running container
      // (the rig is being destroyed), but a lingering stopped container or a
      // second tag on the same image id would otherwise block plain rmi.
      docker(['rmi', '-f', ...refs]);
      console.log(`${tag} [reap] Removed ${refs.length} local build image(s) for ${projectName}`);
    }

    // Volumes: real-infra k8s volumes are PVC-backed on the (now-destroyed)
    // cluster and compose real-infra volumes live on the remote host, so this
    // is usually a no-op — but a local compose build leaves `<projectName>_*`
    // volumes, and reaping them here keeps the local volume pool from drifting.
    const vols = docker(['volume', 'ls', '--format', '{{.Name}}'])
      .split('\n')
      .map((v) => v.trim())
      .filter((name) => name.includes(projectName));
    if (vols.length > 0) {
      docker(['volume', 'rm', '-f', ...vols]);
      console.log(`${tag} [reap] Removed ${vols.length} local volume(s) for ${projectName}`);
    }
  } catch (e) {
    // Never fatal — teardown continues regardless.
    console.warn(
      `${tag} [reap] Local artifact reap failed (non-fatal): ${e instanceof Error ? e.message : e}`,
    );
  }
}
