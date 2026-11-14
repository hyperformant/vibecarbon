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

/** Longest the throwaway read may take (a first pull included) before the check gives up. */
export const READ_TIMEOUT_MS = 120_000;

/** Run docker with argv, returning stdout; throws on a non-zero exit or a timeout. */
function dockerCli(argv, { timeout } = {}) {
  return execFileSync('docker', argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

/** True when this compose project's db container is running exactly `ref`. */
function dbRunningOn(docker, composeProject, ref) {
  const out = docker([
    'ps',
    '--filter',
    `label=com.docker.compose.project=${composeProject}`,
    '--filter',
    'label=com.docker.compose.service=db',
    '--format',
    '{{.State}} {{.Image}}',
  ]);
  return out.split('\n').some((line) => line.trim() === `running ${ref}`);
}

/**
 * @param {{ composeProject: string, image: string, tag: string, docker?: (argv: string[], opts?: { timeout?: number }) => string, notify?: (msg: string) => void }} opts
 *   notify is called once, before a download, when the db image is not local yet.
 * @returns {{ ok: true } | { ok: false, volume: string, dataMajor: number, imageMajor: number, createdAt: string }}
 *   Anything the check cannot establish (no volume, no PG_VERSION, an
 *   unparsable tag, a docker failure or timeout) is ok: the check never blocks
 *   `up` itself.
 */
export function checkDbVolumeVersion({
  composeProject,
  image,
  tag,
  docker = dockerCli,
  notify = () => {},
}) {
  const volume = `${composeProject}_db_data`;
  const ref = `${image}:${tag}`;
  const imageMajor = pgMajorFromTag(tag);
  if (imageMajor === null) return { ok: true };
  try {
    const [info] = JSON.parse(docker(['volume', 'inspect', volume]));
    // A db already running on this very image has opened the data: skip the read.
    if (dbRunningOn(docker, composeProject, ref)) return { ok: true };
    try {
      docker(['image', 'inspect', ref]);
    } catch {
      notify(`Downloading the database image to check the data already in ${volume}`);
    }
    const raw = docker(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${volume}:/d:ro`,
        '--entrypoint',
        'cat',
        ref,
        '/d/PG_VERSION',
      ],
      { timeout: READ_TIMEOUT_MS },
    );
    const dataMajor = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(dataMajor) || dataMajor === imageMajor) return { ok: true };
    return { ok: false, volume, dataMajor, imageMajor, createdAt: info?.CreatedAt ?? '' };
  } catch {
    return { ok: true };
  }
}
