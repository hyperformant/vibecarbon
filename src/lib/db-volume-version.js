/**
 * The local db volume must hold the PostgreSQL major the db image runs.
 *
 * Compose names volumes `<compose project>_<volume>`, so a project can mount a
 * `<name>_db_data` volume that an earlier stack left behind, holding another
 * major's files. Postgres then refuses to start ("database files are
 * incompatible with server"), the container crash-loops, and compose only
 * reports "unhealthy". The same happens to every project when the db image
 * moves to a new major. `vibecarbon up` asks this before it starts anything.
 */

import { execFileSync } from 'node:child_process';

/** The PostgreSQL major in a db image tag (`17.11-walg3.0.9-r5` is 17), or null. */
export function pgMajorFromTag(tag) {
  const match = /^(\d+)\./.exec(String(tag ?? ''));
  return match ? Number(match[1]) : null;
}

/** Run docker with argv, returning stdout; throws on a non-zero exit. */
function dockerCli(argv) {
  return execFileSync('docker', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {{ composeProject: string, image: string, tag: string, docker?: (argv: string[]) => string }} opts
 * @returns {{ ok: true } | { ok: false, volume: string, dataMajor: number, imageMajor: number, createdAt: string }}
 *   Anything the check cannot establish (no volume, no PG_VERSION, an
 *   unparsable tag, a docker failure) is ok: the check never blocks `up` itself.
 */
export function checkDbVolumeVersion({ composeProject, image, tag, docker = dockerCli }) {
  const volume = `${composeProject}_db_data`;
  const imageMajor = pgMajorFromTag(tag);
  if (imageMajor === null) return { ok: true };
  try {
    const [info] = JSON.parse(docker(['volume', 'inspect', volume]));
    const raw = docker([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${volume}:/d:ro`,
      '--entrypoint',
      'cat',
      `${image}:${tag}`,
      '/d/PG_VERSION',
    ]);
    const dataMajor = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(dataMajor) || dataMajor === imageMajor) return { ok: true };
    return { ok: false, volume, dataMajor, imageMajor, createdAt: info?.CreatedAt ?? '' };
  } catch {
    return { ok: true };
  }
}
