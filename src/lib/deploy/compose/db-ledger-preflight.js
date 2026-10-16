/**
 * Server-side preflight for compose and compose-ha: refuse to swap the stack
 * on a database this stack did not create.
 *
 * The app applies db/migrations at startup and records them in drizzle's
 * ledger (`drizzle.__drizzle_migrations`). A database made by the retired
 * stack has every table already but no ledger, so the baseline migration
 * fails on its first CREATE and the app reports MIGRATIONS_FAILED, AFTER
 * `docker compose up --remove-orphans` has already dropped the old services.
 * That is production down past the point of no return. k8s refuses the same
 * case before applying anything (assertNoRetiredChartDb in k3s.js); this is
 * the compose counterpart.
 *
 * It runs as its own plan step (check-db-ledger) right after setup-server,
 * before the bundle upload rewrites the old stack's compose files, before the
 * image transfer or build and before the swap, so a refusal leaves the server
 * exactly as it was. One read per server, not a retry: setup-server already
 * proved SSH and docker work, so a failing read is reported as one rather
 * than guessed at.
 *
 * What it reads, on `<project>-db` (the compose container_name):
 *  - running: one psql query. No ledger AND tables in `public` means the
 *    retired stack made this database: refuse. A ledger, or an empty public
 *    schema (a first boot, or a first migration that rolled back), is fine.
 *  - stopped: Postgres is not there to ask, so the container's image decides.
 *    The retired stack built its db as `<project>-db:latest` on the server;
 *    a stopped container of that image holds that stack's data: refuse. A
 *    stopped container of a pulled image is left to the app's migrator.
 *  - absent: a first deploy, nothing to check.
 */
import { sshRunAsync } from './index.js';

/** The query: true when tables exist in `public` but drizzle's ledger does not. */
export const PRE_LEDGER_SQL =
  "select to_regclass('drizzle.__drizzle_migrations') is null and exists(select 1 from pg_tables where schemaname='public')";

/**
 * The remote script. Prints `STATE=`, `IMAGE=` and (when running) `PRE_LEDGER=`
 * lines; psql's own stderr is folded in so a failed read can be quoted.
 *
 * @param {string} projectName
 * @returns {string}
 */
export function dbLedgerProbeCommand(projectName) {
  const container = `${projectName}-db`;
  const sqlB64 = Buffer.from(PRE_LEDGER_SQL).toString('base64');
  return [
    `c=${container}`,
    // `|| running=absent`, not `$(... || echo absent)`: a failed inspect still
    // prints an empty line, and the substitution would capture both.
    `running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null) || running=absent`,
    `echo "STATE=$running"`,
    `[ "$running" = absent ] && exit 0`,
    `echo "IMAGE=$(docker inspect -f '{{.Config.Image}}' "$c")"`,
    `[ "$running" = true ] || exit 0`,
    `out=$(docker exec "$c" psql -U postgres -d postgres -tAc "$(echo ${sqlB64} | base64 -d)" 2>&1); echo "PRE_LEDGER=$(echo "$out" | tr -d '[:space:]')"`,
  ].join('; ');
}

/**
 * Parse the probe output into a verdict.
 *
 * @param {string} output
 * @param {string} projectName
 * @returns {{verdict: 'absent'|'ok'|'pre-ledger'|'unreadable', detail: string}}
 */
export function parseDbLedgerProbe(output, projectName) {
  const field = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(String(output ?? ''))?.[1]?.trim();
  const state = field('STATE');
  const image = field('IMAGE') ?? '';
  if (state === 'absent') return { verdict: 'absent', detail: 'no db container' };
  if (state === 'false') {
    const retired = image === `${projectName}-db:latest` || image === `${projectName}-db`;
    return retired
      ? { verdict: 'pre-ledger', detail: `stopped db container runs the retired image ${image}` }
      : { verdict: 'ok', detail: `stopped db container (${image || 'unknown image'})` };
  }
  if (state === 'true') {
    const answer = field('PRE_LEDGER');
    if (answer === 't') {
      return { verdict: 'pre-ledger', detail: 'public tables but no drizzle migration ledger' };
    }
    if (answer === 'f') return { verdict: 'ok', detail: 'drizzle ledger present or schema empty' };
    return { verdict: 'unreadable', detail: `psql answered "${(answer ?? '').slice(0, 200)}"` };
  }
  return {
    verdict: 'unreadable',
    detail: `unexpected probe output "${String(output ?? '').slice(0, 200)}"`,
  };
}

/**
 * Probe every server and throw before any of them swaps its stack.
 *
 * @param {string[]} ips - primary first on compose-ha
 * @param {string} sshKeyPath
 * @param {string} projectName
 * @param {{sshRun?: typeof sshRunAsync}} [options] - `sshRun` is a test seam.
 */
export async function assertDbMadeByThisStack(ips, sshKeyPath, projectName, options = {}) {
  const { sshRun = sshRunAsync } = options;
  for (const ip of ips) {
    let out;
    try {
      out = await sshRun(ip, sshKeyPath, dbLedgerProbeCommand(projectName), { timeout: 30_000 });
    } catch (err) {
      throw new Error(
        `Could not check the database on ${ip} before replacing the stack ` +
          `(${String(err?.message ?? err).slice(0, 200)}). Refusing to swap the stack without ` +
          'knowing whether it holds data from an older vibecarbon stack.',
      );
    }
    const { verdict, detail } = parseDbLedgerProbe(out, projectName);
    if (verdict === 'absent' || verdict === 'ok') continue;
    if (verdict === 'unreadable') {
      throw new Error(
        `Could not check the database on ${ip} before replacing the stack (${detail}). ` +
          'Refusing to swap the stack without knowing whether it holds data from an older ' +
          `vibecarbon stack. Check \`docker logs ${projectName}-db\` on the server ` +
          `(\`ssh -i ${sshKeyPath} root@${ip}\`), then deploy again.`,
      );
    }
    throw new Error(
      `The database on ${ip} was created by an older vibecarbon stack (${detail}). This ` +
        'version applies its migrations from a fresh baseline, and it cannot adopt a database ' +
        'that already has the tables without the migration ledger: deploying now would take ' +
        'production down after the old services are gone.\n' +
        'Nothing has been changed on the server. To move to this version:\n' +
        '  1. Keep a copy: `vibecarbon backup <env>`, and dump the rows you want to keep ' +
        `(\`ssh -i ${sshKeyPath} root@${ip}\`, then ` +
        `\`docker exec ${projectName}-db pg_dump -U postgres --data-only -t <table> postgres\`).\n` +
        '  2. Start fresh: `vibecarbon destroy <env>`, then `vibecarbon deploy <env>`.\n' +
        '  3. Load the dumped rows into the new database by hand (the same ssh, then ' +
        `\`docker exec -i ${projectName}-db psql -U postgres postgres\`).`,
    );
  }
}
