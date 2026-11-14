import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Best-effort docker call: capture stdout, swallow everything else. A missing
 * docker binary or a daemon hiccup must not derail cleanup.
 */
function bestEffortDocker(argv: readonly string[], timeoutMs = 30_000): string {
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
}

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
  const docker = bestEffortDocker;

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

/** A run younger than this may still be running on this machine (a concurrent run). */
export const STALE_RUN_MAX_AGE_MS = 43_200_000; // 12 h
/** Temp dirs and CA bundles older than this are leftovers, not a run in flight. */
export const STALE_TEMP_MAX_AGE_MS = 604_800_000; // 7 days

const SCRATCH_PROJECT = /((?:testapp|citest)-[a-z0-9]+(?:-ha)?-(\d{13})-[a-z0-9]{6})(?![a-z0-9])/;

/**
 * Find the scratch project in an image repository or volume name. Covers every
 * tag scheme (`10.0.1.2:5000/<p>`, `vibecarbon-local/<p>`, `<p>-app`, and
 * compose volumes `<p>_db_data`, which Docker prefixes with the compose
 * project). `createdAtMs` is the run's start time, which the name carries.
 */
export function parseScratchProject(
  ref: string,
): { projectName: string; createdAtMs: number } | null {
  const m = SCRATCH_PROJECT.exec(ref);
  return m ? { projectName: m[1], createdAtMs: Number(m[2]) } : null;
}

/**
 * Remove what EARLIER runs left on this machine, at the start of a run.
 * reapLocalBuildArtifacts only runs at the end of its own scenario, so a
 * killed run or a kept rig never reaches it: 29 image tags and 20 volumes
 * had piled up by 2026-11-13. Rules:
 * - Only scratch projects (`testapp-` / `citest-`), by the start time in the
 *   name, and only past 12 hours, so a concurrent run's artifacts stay.
 * - Never a kept rig's project: tests/results/.rig-*.json names it, and those
 *   images are what the operator iterates.
 * - Temp dirs and CA bundles by mtime, past 7 days.
 * - Never fatal: a failure here must not stop the run it prepares.
 */
export async function reapStaleLocalArtifacts(
  tag: string,
  o: {
    now?: number;
    maxAgeMs?: number;
    tempMaxAgeMs?: number;
    tmpRoot?: string;
    rigDir?: string;
    liveProjects?: Set<string>;
    docker?: (argv: readonly string[]) => string;
  } = {},
): Promise<{ images: number; volumes: number; tempDirs: number }> {
  const result = { images: 0, volumes: 0, tempDirs: 0 };
  const now = o.now ?? Date.now();
  const maxAgeMs = o.maxAgeMs ?? STALE_RUN_MAX_AGE_MS;
  const tempMaxAgeMs = o.tempMaxAgeMs ?? STALE_TEMP_MAX_AGE_MS;
  const tmpRoot = o.tmpRoot ?? tmpdir();
  const docker = o.docker ?? ((argv: readonly string[]) => bestEffortDocker(argv));

  try {
    let live = o.liveProjects;
    if (!live) {
      live = new Set<string>();
      const rigDir = o.rigDir ?? join(process.cwd(), 'tests', 'results');
      try {
        for (const f of readdirSync(rigDir)) {
          if (!f.startsWith('.rig-') || !f.endsWith('.json')) continue;
          try {
            const rig = JSON.parse(readFileSync(join(rigDir, f), 'utf8'));
            if (typeof rig?.projectName === 'string') live.add(rig.projectName);
          } catch {
            // an unreadable sentinel names nothing
          }
        }
      } catch {
        // no results dir, no kept rigs
      }
    }

    const isStale = (name: string): boolean => {
      const p = parseScratchProject(name);
      return p !== null && now - p.createdAtMs >= maxAgeMs && !live.has(p.projectName);
    };

    const images = docker(['images', '--format', '{{.Repository}}:{{.Tag}}'])
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
      .filter((ref) => isStale(ref.slice(0, ref.lastIndexOf(':'))));
    if (images.length > 0) {
      docker(['rmi', '-f', ...images]);
      result.images = images.length;
    }

    const volumes = docker(['volume', 'ls', '--format', '{{.Name}}'])
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean)
      .filter(isStale);
    if (volumes.length > 0) {
      docker(['volume', 'rm', '-f', ...volumes]);
      result.volumes = volumes.length;
    }

    try {
      for (const name of readdirSync(tmpRoot)) {
        if (!name.startsWith('vibecarbon-e2e-')) continue;
        const path = join(tmpRoot, name);
        try {
          const st = statSync(path);
          const isCaBundle = st.isFile() && /^vibecarbon-e2e-ca-bundle-.*\.pem$/.test(name);
          if (!st.isDirectory() && !isCaBundle) continue;
          if (now - st.mtimeMs < tempMaxAgeMs) continue;
          rmSync(path, { recursive: true, force: true });
          result.tempDirs++;
        } catch {
          // one stubborn entry must not stop the rest
        }
      }
    } catch {
      // unreadable temp root
    }
  } catch (e) {
    console.warn(
      `${tag} [reap] Stale artifact reap failed (non-fatal): ${e instanceof Error ? e.message : e}`,
    );
  }

  if (result.images + result.volumes + result.tempDirs > 0) {
    console.log(
      `${tag} [reap] Removed ${result.images} image(s), ${result.volumes} volume(s), ${result.tempDirs} temp dir(s) left by earlier runs`,
    );
  }
  return result;
}
