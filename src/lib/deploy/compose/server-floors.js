/**
 * Stop a deploy early when a server's Docker is under its floor.
 *
 * We do not pin Docker, so a server gets whatever its image or Docker's apt repo
 * gives it, and an old one would otherwise fail deep in the deploy. The read
 * rides the session of the first step that touches a server's Docker, the
 * database check (check-db-ledger), which runs on every compose and compose-ha
 * deploy, cold or warm, before anything is uploaded. It opens no session and
 * costs no round trip of its own, and it runs beside the database check rather
 * than ahead of it, so the step takes as long as the slower of the two. On a
 * cold server both are a few short docker commands.
 *
 * k8s servers run containerd under k3s and have no Docker to check.
 *
 * Only a version it read and knows is too old is refused (runtime-floors.js).
 * A read that fails or says something else is a warning, and whatever the
 * deploy needs from Docker next will report a real problem in its own words.
 */
import { progressLog } from '../../cli/progress.js';
import { DOCKER_PACKAGES } from '../../iac/docker-install.js';
import { perfRecord } from '../../perf.js';
import { judgeVersion, tooOldMessage, unreadableMessage } from '../../runtime-floors.js';
import { aptGet } from '../apt.js';
import { sshRunAsync } from './index.js';

/**
 * The read. One printf, so its lines reach stdout in a single write and cannot
 * land in the middle of a line from the script it rides on. Five seconds is far
 * more than either command takes, and only a wedged dockerd reaches it.
 */
const READ_VERSIONS_SH = [
  't0=$(date +%s%N)',
  `e=$(timeout 5 docker version --format '{{.Server.Version}}' 2>/dev/null)`,
  'v=$(timeout 5 docker compose version --short 2>/dev/null)',
  `printf 'VC_ENGINE=%s\\nVC_COMPOSE=%s\\nVC_VERSIONS_MS=%s\\n' "$e" "$v" "$(( ($(date +%s%N) - t0) / 1000000 ))"`,
].join('; ');

/**
 * Run the read beside a remote script, in its session. The script keeps its own
 * shell, so an `exit` in it ends only that shell, and its exit status is the
 * session's.
 *
 * @param {string} script
 * @returns {string}
 */
export function withServerVersions(script) {
  return `(${READ_VERSIONS_SH}) & (${script}); rc=$?; wait; exit $rc`;
}

/**
 * Judge what the read printed. Throws on a version under its floor, warns on one
 * it cannot read.
 *
 * @param {string} ip
 * @param {string | null | undefined} output
 * @param {object} options
 * @param {string} options.sshKeyPath - quoted in the way out
 * @param {(message: string) => void} [options.warn]
 * @param {string} [options.perfName] - the `[perf]` marker for what the read cost
 */
export function judgeServerVersions(ip, output, { sshKeyPath, warn = progressLog, perfName }) {
  const text = String(output ?? '');
  const field = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';

  const readMs = Number.parseInt(field('VC_VERSIONS_MS'), 10);
  if (perfName && Number.isFinite(readMs)) perfRecord(perfName, readMs);

  const subject = `on ${ip}`;
  const update = `${aptGet('update')} && ${aptGet(`install -y ${DOCKER_PACKAGES.join(' ')}`)}`;
  const fix =
    `Update Docker on the server, which restarts its containers: ` +
    `ssh -i ${sshKeyPath} root@${ip} '${update}'\n` +
    '           Then deploy again.';
  const reads = [
    ['docker-engine', field('VC_ENGINE')],
    ['compose', field('VC_COMPOSE')],
  ];
  for (const [tool, raw] of reads) {
    const { verdict, found, floor } = judgeVersion(tool, 'server', raw);
    if (verdict === 'too-old') throw new Error(tooOldMessage({ tool, found, floor, subject, fix }));
    if (verdict === 'unreadable') warn(unreadableMessage({ tool, raw, subject }));
  }
}

/**
 * The same check for a server with no database step ahead of it: the new server
 * `vibecarbon scale` builds. One command on the SSH connection the boot wait
 * already opened. A failed read warns, for the same reason an unreadable version
 * does.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {object} [options]
 * @param {typeof sshRunAsync} [options.run] - test seam
 * @param {(message: string) => void} [options.warn]
 * @param {string} [options.perfName]
 */
export async function assertServerFloors(ip, sshKeyPath, options = {}) {
  const { run = sshRunAsync, warn = progressLog, perfName } = options;
  let output;
  try {
    output = await run(ip, sshKeyPath, READ_VERSIONS_SH, { timeout: 30_000, retries: 1 });
  } catch (err) {
    warn(
      `Could not read the Docker versions on ${ip} ` +
        `(${String(err?.message ?? err).slice(0, 200)}). Continuing without checking them.`,
    );
    return;
  }
  judgeServerVersions(ip, output, { sshKeyPath, warn, perfName });
}
